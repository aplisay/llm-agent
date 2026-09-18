/**
 * Minimal mono PCM WAV reader/writer for the fallback-message cache.
 *
 * Cached announcements are stored as 16-bit signed little-endian PCM in a WAV
 * container. WAV rather than raw PCM because the container carries the sample
 * rate with the samples: the two runtimes synthesise through different TTS
 * stacks at whatever rate the vendor emits, and the reader must resample to
 * the transport's rate without being told out of band what it started from. It
 * also means a cached object can be pulled out of the bucket and played in any
 * audio tool when someone is working out why an announcement sounds wrong.
 *
 * Only the subset needed here is implemented: PCM (format 1), mono, 16-bit.
 * Mirrored by `agents/pipecat/pipecat_aplisay/fallback_message/wav.py`.
 */

const RIFF = 0x46464952; // 'RIFF' little-endian
const WAVE = 0x45564157; // 'WAVE'
const FMT_ = 0x20746d66; // 'fmt '
const DATA = 0x61746164; // 'data'

const HEADER_BYTES = 44;
const PCM_FORMAT = 1;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;

/**
 * @typedef {Object} DecodedWav
 * @property {Buffer} pcm Raw 16-bit little-endian mono samples.
 * @property {number} sampleRate
 */

/**
 * Wrap mono 16-bit PCM in a WAV container.
 *
 * @param {Buffer} pcm Raw 16-bit little-endian mono samples.
 * @param {number} sampleRate
 * @returns {Buffer}
 */
export function encodeWav(pcm, sampleRate) {
  if (!Buffer.isBuffer(pcm)) {
    throw new Error('encodeWav: pcm must be a Buffer');
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`encodeWav: invalid sampleRate ${sampleRate}`);
  }
  const byteRate = sampleRate * CHANNELS * (BITS_PER_SAMPLE / 8);
  const blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(RIFF, 0);
  header.writeUInt32LE(HEADER_BYTES - 8 + pcm.length, 4); // RIFF chunk size
  header.writeUInt32LE(WAVE, 8);
  header.writeUInt32LE(FMT_, 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(PCM_FORMAT, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.writeUInt32LE(DATA, 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Read a mono 16-bit PCM WAV produced by {@link encodeWav}.
 *
 * Chunks are walked rather than assumed at fixed offsets: some TTS vendors
 * return WAV with a `LIST`/`fact` chunk ahead of `data`, and a cached object
 * written from such a payload would otherwise decode as noise.
 *
 * @param {Buffer} buffer
 * @returns {DecodedWav}
 */
export function decodeWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    throw new Error('decodeWav: buffer too short to be a WAV');
  }
  if (buffer.readUInt32LE(0) !== RIFF || buffer.readUInt32LE(8) !== WAVE) {
    throw new Error('decodeWav: not a RIFF/WAVE payload');
  }
  let sampleRate = 0;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.readUInt32LE(offset);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === FMT_) {
      const format = buffer.readUInt16LE(body);
      const channels = buffer.readUInt16LE(body + 2);
      const bits = buffer.readUInt16LE(body + 14);
      if (format !== PCM_FORMAT || channels !== CHANNELS || bits !== BITS_PER_SAMPLE) {
        throw new Error(
          `decodeWav: expected mono 16-bit PCM, got format=${format} channels=${channels} bits=${bits}`,
        );
      }
      sampleRate = buffer.readUInt32LE(body + 4);
    } else if (chunkId === DATA) {
      if (!sampleRate) {
        throw new Error('decodeWav: data chunk before fmt chunk');
      }
      // Trust the buffer over the declared size: a truncated upload would
      // otherwise hand callers a Buffer slice shorter than they expect.
      const end = Math.min(body + chunkSize, buffer.length);
      return { pcm: buffer.subarray(body, end), sampleRate };
    }
    // Chunks are word-aligned: an odd size carries a trailing pad byte.
    offset = body + chunkSize + (chunkSize % 2);
  }
  throw new Error('decodeWav: no data chunk found');
}
