# Call recording — shared contract

This document is the single source of truth for the on-wire format and storage
layout used by every agent that records calls (LiveKit, Pipecat, anything we add
later). Two implementations follow it:

- **JS** — this directory (`lib/recording/`), consumed by the REST download
  endpoint and the LiveKit agent.
- **Python** — `agents/pipecat/pipecat_aplisay/recording/`, a sibling
  implementation. Different language, same contract.

If you change anything here you must update both sides and the round-trip
tests in `tests/lib/recording.test.mjs` (and the Python equivalents).

## File format on disk and in GCS

- Audio container: **OGG**, codec: **Opus**, stereo (2 channels).
- Channel layout: **user on the left channel, agent on the right channel**.
- Sample rate: whatever the source pipeline produces (16 kHz or 24 kHz are
  typical). Decoders must read the rate from the OGG header — implementations
  do not pin it.

LiveKit writes this format natively via the SDK's `RecorderIO`. Pipecat
produces it by piping interleaved 16-bit PCM from `AudioBufferProcessor`
(`num_channels=2`) through `ffmpeg -c:a libopus -f ogg`.

## Encryption

AES-256-GCM, applied as a streaming transform after the OGG file is written
to local disk and before upload. The on-wire format of the encrypted object is:

```
IV (12 bytes) || ciphertext || auth tag (16 bytes)
```

The download endpoint expects this exact layout. Authenticated-data is empty.

### Key handling

Two modes:

- **Client-provided key** (`agent.options.recording.key` set): derive a
  32-byte AES key by truncating-or-zero-padding the UTF-8 bytes of the user
  string. The platform stores no key; downloads return ciphertext, and the
  client decrypts.
- **Server-generated key** (no `recording.key`): generate 32 random bytes,
  encrypt with them, store the base64 of those bytes alongside the recording
  metadata. The download endpoint decrypts and returns plaintext audio.

Both implementations derive the key identically so a recording made by one
agent is decryptable by the other.

## GCS object naming

```
${RECORDING_STORAGE_PATH}/${callId}.ogg
```

- `RECORDING_STORAGE_PATH` is a `gs://bucket[/prefix]` URL.
- When unset, default is `gs://llm-voice/${NODE_ENV || 'development'}-recordings`.
- The agent always uses the **primary** `callId` (i.e. the inbound leg id —
  never the bridged child id).

## Metadata persistence

On successful upload, the agent calls:

```
PUT /api/agent-db/call/:callId/recording
{
  "recordingId": "<gcs object name>",
  "encryptionKey": "<base64 32-byte key>"   // only when server-generated
}
```

This is the moment the `Call` row gets `recordingId` populated. If the upload
fails, the agent **must not** call this endpoint — the absence of
`recordingId` is the platform's "no recording exists" signal.

## Public surface

Both implementations expose the same primitives, named to read naturally in
each language:

| JS                            | Python                                  |
|-------------------------------|-----------------------------------------|
| `parseGcsPath`                | `parse_gcs_path`                        |
| `defaultRecordingBaseUrl`     | `default_recording_base_url`            |
| `objectNameFor`               | `object_name_for`                       |
| `deriveKey` / `generateKey`   | `derive_key` / `generate_key`           |
| `GcmEncryptStream`            | `GcmEncryptStream`                      |
| `GcmDecryptStream`            | `GcmDecryptStream`                      |
| `uploadEncryptedOgg`          | `upload_encrypted_ogg`                  |

The Python side additionally exposes `RecordingSession` and an `OggEncoder`
helper because Pipecat's `AudioBufferProcessor` yields raw stereo PCM —
encoding to Opus/OGG happens on the recording side rather than upstream.
LiveKit needs no such helper because its SDK writes OGG directly.
