/**
 * Neuphonic TTS for pipeline agents and for realtime models in text-output mode.
 *
 * Our own class rather than @livekit/agents-plugin-neuphonic, whose stream sends one <STOP> per reply
 * (Neuphonic says nothing before it) and whose SSE path throws from a socket handler. See docs/neuphonic.md.
 */
import {
  APIConnectionError,
  APIError,
  APIStatusError,
  APITimeoutError,
  AsyncIterableQueue,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  delay,
  intervalForRetry,
  log,
  shortuuid,
  tokenize,
  tts,
  type APIConnectOptions,
} from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import type { Agent } from "./api-client.js";
import { agentLanguageTag } from "./pipeline-inference-options.js";

export const NEUPHONIC_BASE_URL = "https://api.neuphonic.com";
/** The rate both upstream Neuphonic plugins ask for. */
export const NEUPHONIC_SAMPLE_RATE = 22050;
/** Sentence requests in flight per reply. Neuphonic has per-account concurrency limits. */
const LOOKAHEAD = 2;

export interface NeuphonicOptions {
  apiKey: string;
  /** Unset lets Neuphonic choose its default voice for `langCode`; some languages have none. */
  voiceId?: string;
  /** Base code such as `en`. Must be a language the voice speaks. */
  langCode: string;
  sampleRate: number;
  baseURL: string;
}

export class NeuphonicTTS extends tts.TTS {
  label = "neuphonic.TTS";
  readonly #opts: NeuphonicOptions;

  constructor(opts: {
    apiKey: string;
    voiceId?: string;
    langCode?: string;
    sampleRate?: number;
    baseURL?: string;
  }) {
    const sampleRate = opts.sampleRate ?? NEUPHONIC_SAMPLE_RATE;
    super(sampleRate, 1, { streaming: true });
    if (!opts.apiKey) {
      throw new Error("TTS vendor neuphonic needs NEUPHONIC_API_KEY");
    }
    this.#opts = {
      apiKey: opts.apiKey,
      voiceId: opts.voiceId || undefined,
      langCode: (opts.langCode || "en").toLowerCase(),
      sampleRate,
      baseURL: (opts.baseURL || NEUPHONIC_BASE_URL).replace(/\/+$/, ""),
    };
  }

  /** The request options, without the key. */
  get options(): Omit<NeuphonicOptions, "apiKey"> {
    const { apiKey: _apiKey, ...rest } = this.#opts;
    return rest;
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new NeuphonicChunkedStream(this, text, this.#opts, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return new NeuphonicSynthesizeStream(this, this.#opts, options?.connOptions);
  }
}

/** `options.tts` to a Neuphonic TTS, with the key from `NEUPHONIC_API_KEY`. */
export function buildNeuphonicTts(agent: Agent): NeuphonicTTS {
  const apiKey = process.env.NEUPHONIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("TTS vendor neuphonic needs NEUPHONIC_API_KEY in the worker environment");
  }
  const voice = String(agent.options?.tts?.voice || "").trim();
  const tag = agentLanguageTag(agent);
  return new NeuphonicTTS({
    apiKey,
    voiceId: voice.includes(":") ? voice.split(":").pop()!.trim() : voice,
    langCode: tag ? tag.split(/[-_]/)[0]!.toLowerCase() : "en",
  });
}

function withoutRetry(e: unknown): unknown {
  return e instanceof APIError && e.retryable
    ? new APIError(e.message, { body: e.body, retryable: false })
    : e;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Decoded PCM from one SSE event block, or undefined for a block without audio. */
function parseEvent(block: string): Uint8Array | undefined {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (!data.length) return undefined;
  let payload: { status_code?: number; errors?: unknown; data?: { audio?: string } };
  try {
    payload = JSON.parse(data.join("\n"));
  } catch {
    throw new APIError(`Neuphonic TTS sent an unreadable event: ${data.join(" ").slice(0, 200)}`, {
      retryable: false,
    });
  }
  // Neuphonic reports a bad voice, language or key as a 500 error event inside an HTTP 200 stream.
  if (event === "error" || payload.errors) {
    const statusCode = typeof payload.status_code === "number" ? payload.status_code : -1;
    throw new APIStatusError({
      message: `Neuphonic TTS error ${statusCode}: ${JSON.stringify(payload.errors ?? payload)}`,
      options: { statusCode, body: payload, retryable: statusCode < 400 || statusCode >= 500 || statusCode === 429 },
    });
  }
  const audio = payload.data?.audio;
  return audio ? Buffer.from(audio, "base64") : undefined;
}

/**
 * PCM for `text` from the SSE endpoint. Throws `APIError`s, returns quietly once `signal` aborts.
 * `timeoutMs` bounds the wait for the first audio only.
 */
export async function* neuphonicAudio(
  opts: NeuphonicOptions,
  text: string,
  { signal, timeoutMs }: { signal: AbortSignal; timeoutMs: number },
): AsyncGenerator<Uint8Array> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const failed = (e: unknown): APIError =>
    timedOut
      ? new APITimeoutError({ message: `Neuphonic TTS gave no audio within ${timeoutMs} ms` })
      : new APIConnectionError({ message: `Neuphonic TTS request failed: ${(e as Error)?.message ?? e}` });
  try {
    let res: Response;
    try {
      res = await fetch(`${opts.baseURL}/sse/speak/${encodeURIComponent(opts.langCode)}`, {
        method: "POST",
        headers: {
          "X-API-KEY": opts.apiKey,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          text,
          lang_code: opts.langCode,
          sampling_rate: opts.sampleRate,
          encoding: "pcm_linear",
          ...(opts.voiceId ? { voice_id: opts.voiceId } : {}),
        }),
        signal: controller.signal,
      });
    } catch (e) {
      if (signal.aborted) return;
      throw failed(e);
    }
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new APIStatusError({
        message: `Neuphonic TTS returned HTTP ${res.status}`,
        options: {
          statusCode: res.status,
          body: { text: body.slice(0, 500) },
          retryable: res.status === 429 || res.status >= 500,
        },
      });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (signal.aborted) return;
        throw failed(e);
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const audio = parseEvent(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (audio) {
          clearTimeout(timer);
          yield audio;
        }
      }
    }
    const tail = parseEvent(buffer.trim());
    if (tail) yield tail;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    // Releases the connection when the caller stops reading early.
    controller.abort();
  }
}

/** One request for the whole text: the fallback message and other direct `synthesize()` callers. */
class NeuphonicChunkedStream extends tts.ChunkedStream {
  label = "neuphonic.ChunkedStream";
  readonly #opts: NeuphonicOptions;
  readonly #timeoutMs: number;

  constructor(
    ttsInstance: NeuphonicTTS,
    text: string,
    opts: NeuphonicOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, ttsInstance, connOptions, abortSignal);
    this.#opts = opts;
    this.#timeoutMs = (connOptions ?? DEFAULT_API_CONNECT_OPTIONS).timeoutMs;
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    const bstream = new AudioByteStream(this.#opts.sampleRate, 1);
    let queued = false;
    const put = (frame: AudioFrame) => {
      if (this.abortSignal.aborted) return;
      this.queue.put({ requestId, segmentId: requestId, frame, final: false });
      queued = true;
    };
    try {
      for await (const pcm of neuphonicAudio(this.#opts, this.inputText, {
        signal: this.abortSignal,
        timeoutMs: this.#timeoutMs,
      })) {
        bstream.write(toArrayBuffer(pcm)).forEach(put);
      }
    } catch (e) {
      // The base class retries run(); a retry after audio went out would repeat it.
      throw queued ? withoutRetry(e) : e;
    }
    bstream.flush().forEach(put);
  }
}

/**
 * One request per sentence, played in order, the next fetched while the current one plays. Not
 * tts.StreamAdapter: in agents-js 1.0.46 it meters each sentence and the whole reply, billing twice.
 */
class NeuphonicSynthesizeStream extends tts.SynthesizeStream {
  label = "neuphonic.SynthesizeStream";
  readonly #opts: NeuphonicOptions;
  readonly #logger = log();

  constructor(ttsInstance: NeuphonicTTS, opts: NeuphonicOptions, connOptions?: APIConnectOptions) {
    super(ttsInstance, connOptions);
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    const sentences = new tokenize.basic.SentenceTokenizer().stream();
    const failure = new AbortController();
    const signal = AbortSignal.any([this.abortSignal, failure.signal]);

    const forwardInput = async () => {
      for await (const input of this.input) {
        if (signal.aborted) break;
        if (input === NeuphonicSynthesizeStream.FLUSH_SENTINEL) sentences.flush();
        else sentences.pushText(input);
      }
      sentences.endInput();
      sentences.close();
    };

    const speak = async () => {
      const inFlight: Promise<void>[] = [];
      let played: Promise<void> = Promise.resolve();
      for await (const { token } of sentences) {
        if (signal.aborted) break;
        while (inFlight.length >= LOOKAHEAD) await inFlight.shift();
        const sentence = this.#fetchSentence(token, signal);
        inFlight.push(sentence.done.catch(() => undefined));
        const previous = played;
        played = (async () => {
          await previous;
          for await (const frame of sentence.frames) {
            if (signal.aborted) return;
            this.queue.put({ requestId, segmentId: requestId, frame, final: false });
          }
          await sentence.done;
        })();
        // Handled here so a failure before the next sentence arrives is not reported as unhandled.
        played.catch(() => failure.abort());
      }
      await played;
      if (!signal.aborted) this.queue.put(NeuphonicSynthesizeStream.END_OF_STREAM);
    };

    await Promise.all([forwardInput(), speak()]);
  }

  #fetchSentence(text: string, signal: AbortSignal) {
    const frames = new AsyncIterableQueue<AudioFrame>();
    const done = (async () => {
      for (let attempt = 0; ; attempt++) {
        const bstream = new AudioByteStream(this.#opts.sampleRate, 1);
        let queued = false;
        try {
          for await (const pcm of neuphonicAudio(this.#opts, text, {
            signal,
            timeoutMs: this.connOptions.timeoutMs,
          })) {
            for (const frame of bstream.write(toArrayBuffer(pcm))) {
              frames.put(frame);
              queued = true;
            }
          }
          bstream.flush().forEach((frame) => frames.put(frame));
          return;
        } catch (e) {
          if (queued || !(e instanceof APIError) || !e.retryable || attempt >= this.connOptions.maxRetry) {
            throw withoutRetry(e);
          }
          this.#logger.warn({ err: e, attempt: attempt + 1 }, "Neuphonic TTS request failed, retrying");
          await delay(intervalForRetry(this.connOptions, attempt), { signal }).catch(() => undefined);
          if (signal.aborted) return;
        }
      }
    })().finally(() => frames.close());
    done.catch(() => undefined);
    return { frames, done };
  }
}
