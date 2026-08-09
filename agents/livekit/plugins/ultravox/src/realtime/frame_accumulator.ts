// Drop-in replacement for @livekit/agents' AudioByteStream, for the inbound
// (caller -> Ultravox) path only.
//
// The SDK's AudioByteStream.write does:
//
//     this.#buf = new Int8Array([...this.#buf, ...bytes]);
//
// which spreads both the residual buffer and the incoming chunk through the
// iterator protocol into a JS number array, then rebuilds a typed array from
// it — on every call. Because the residual is re-spread each time, the cost is
// driven by call count as much as by byte count, and pushAudio calls it ~100
// times a second with ~480-byte frames against a 4800-byte (100 ms) frame
// size.
//

import { AudioFrame } from "@livekit/rtc-node";

export class FrameAccumulator {
  readonly #sampleRate: number;
  readonly #numChannels: number;
  readonly #bytesPerFrame: number;
  #buf: Uint8Array;

  constructor(sampleRate: number, numChannels: number, samplesPerChannel: number) {
    this.#sampleRate = sampleRate;
    this.#numChannels = numChannels;
    // 2 bytes per sample (Int16), matching AudioByteStream.
    this.#bytesPerFrame = numChannels * samplesPerChannel * 2;
    this.#buf = new Uint8Array(0);
  }

  write(data: ArrayBufferLike | ArrayBufferView): AudioFrame[] {
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);

    if (bytes.length > 0) {
      const merged = new Uint8Array(this.#buf.length + bytes.length);
      merged.set(this.#buf, 0);
      merged.set(bytes, this.#buf.length);
      this.#buf = merged;
    }

    const frames: AudioFrame[] = [];
    let offset = 0;
    while (this.#buf.length - offset >= this.#bytesPerFrame) {
      // slice (not subarray) so each frame owns its buffer: AudioFrame is
      // constructed from `frameData.buffer`, which would otherwise be a view
      // onto the whole accumulator and read past the frame.
      const frameData = this.#buf.slice(offset, offset + this.#bytesPerFrame);
      offset += this.#bytesPerFrame;
      frames.push(
        new AudioFrame(
          new Int16Array(frameData.buffer),
          this.#sampleRate,
          this.#numChannels,
          frameData.length / 2,
        ),
      );
    }
    // One copy for the residual, rather than one per emitted frame.
    if (offset > 0) this.#buf = this.#buf.slice(offset);

    return frames;
  }
}

export default FrameAccumulator;
