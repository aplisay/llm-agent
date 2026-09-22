/**
 * A streaming TTS over one that only synthesises whole texts: Gemini TTS (`google.beta.TTS`).
 *
 * Without it agents-js 1.0.46 wraps such a TTS in a new tts.StreamAdapter on every reply. The
 * adapter's stream and each sentence's ChunkedStream all emit metrics on the inner TTS, which is
 * the one the session listens to, so every reply is metered twice.
 */
import { AsyncIterableQueue, shortuuid, tokenize, tts, type APIConnectOptions } from "@livekit/agents";

export class SentenceStreamTTS extends tts.TTS {
  label: string;
  readonly #inner: tts.TTS;

  constructor(inner: tts.TTS) {
    super(inner.sampleRate, inner.numChannels, { streaming: true });
    this.#inner = inner;
    // A google TTS usage row takes its detail from this label, so keep the plugin's.
    this.label = inner.label;
    // Forward errors only. The inner TTS meters each sentence; stream() meters the reply.
    inner.on("error", (ev) => this.emit("error", ev));
  }

  get inner(): tts.TTS {
    return this.#inner;
  }

  /** One request for the whole text, as before. The fallback message uses this. */
  synthesize(text: string, connOptions?: APIConnectOptions, abortSignal?: AbortSignal): tts.ChunkedStream {
    return this.#inner.synthesize(text, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return new SentenceStream(this, this.#inner, options?.connOptions);
  }

  async close(): Promise<void> {
    await this.#inner.close();
  }
}

/** Requests each sentence once it is complete and plays them in order, as tts.StreamAdapter does. */
class SentenceStream extends tts.SynthesizeStream {
  label: string;
  readonly #inner: tts.TTS;

  constructor(owner: SentenceStreamTTS, inner: tts.TTS, connOptions?: APIConnectOptions) {
    super(owner, connOptions);
    this.#inner = inner;
    this.label = `${owner.label}.SentenceStream`;
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    const sentences = new tokenize.basic.SentenceTokenizer().stream();
    const pending = new AsyncIterableQueue<tts.ChunkedStream>();

    const forwardInput = async () => {
      for await (const input of this.input) {
        if (this.abortSignal.aborted) break;
        if (input === SentenceStream.FLUSH_SENTINEL) sentences.flush();
        else sentences.pushText(input);
      }
      sentences.endInput();
      sentences.close();
    };

    const request = async () => {
      for await (const { token } of sentences) {
        // A ChunkedStream never hears an abort that happened before it was made.
        if (this.abortSignal.aborted) break;
        pending.put(this.#inner.synthesize(token, this.connOptions, this.abortSignal));
      }
      pending.close();
    };

    const play = async () => {
      for await (const sentence of pending) {
        for await (const { frame } of sentence) {
          if (this.abortSignal.aborted) return;
          // Never `final`: the base class would meter the reply at the first final frame.
          this.queue.put({ requestId, segmentId: requestId, frame, final: false });
        }
      }
      if (!this.abortSignal.aborted) this.queue.put(SentenceStream.END_OF_STREAM);
    };

    await Promise.all([forwardInput(), request(), play()]);
  }
}
