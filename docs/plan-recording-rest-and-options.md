# Plan: Call Recording REST API and Recording Options

This document plans the addition of:
1. A REST endpoint to return a call recording by `callId`
2. Recording configuration on **agents** and **instances** (listeners), including optional encryption key and stereo/mono flag
3. **Custom recording implementation**: direct capture from the LiveKit room, encode (mono/stereo), optional encryption, and upload to GCP storage (S3-compatible path config), without using LiveKit Cloud or the LiveKit agent built-in recording.

---

## 1. Recording options schema (agents and instances)

Use a single `recording` object with the following shape:

```ts
recording?: {
  enabled: boolean;
  key?: string;      // optional encryption key
  stereo?: boolean;   // default false (mono)
}
```

- **Agent level**: add to `AgentOptions` so it can be set when creating/updating an agent and applies as the default for all instances of that agent.
- **Instance / listener level**: allow override per instance via the listener `options.recording` field on `/agents/{agentId}/listen`, which is persisted into the `Instance.recording` JSONB column. Precedence: **instance/listener over agent** (same pattern as `callHook`).

**Where to add it**

- **OpenAPI (api-doc.yaml)**  
  - In `AgentOptions`, add a `recording` property: `enabled` (boolean, required), `key` (string), `stereo` (boolean, default false).
  - In the listener **join** request body (`options`), add an optional `recording` object with the same shape.
- **Types (api-client.ts)**  
  - In `Agent.options`, add: `recording?: { enabled: boolean; key?: string; stereo?: boolean };`
- **Instance / metadata**  
  - Resolve effective config from instance metadata (or listener options) then agent in the worker.

---

## 2. REST endpoint: get call recording

**Path:** `GET /calls/{callId}/recording`

- **Purpose:** Stream the call recording audio for the given `callId` directly to the client.
- **Auth:** Same as `GET /calls/{callId}/logs` (call scoped by organisation/user via `res.locals.user.sql.where`).
- **Behaviour:**
  - Load Call by `callId`; if no `recordingId` return 404.
  - Open a read stream from GCP for that `recordingId`.
  - Determine encryption mode from the Call row:
    - If **`call.encryptionKey` is non-null**: this means the server generated a random per-call key. Create a decrypt `Transform` (AES-256-GCM with this key) and stream **decrypted** audio to the client: `GCS → decipher → HTTP response`.
    - If **`call.encryptionKey` is null**: this means the client provided the encryption key at agent/instance config time and the server does **not** store it. In this case the server **does not decrypt**; it simply streams the encrypted bytes: `GCS → HTTP response`. The client is responsible for decrypting using its own key.
  - Set appropriate headers (`Content-Type`, optional `Content-Disposition`) but always treat this endpoint as a **streaming download**, not a JSON metadata API.
- **Database:** Call model has:
  - `recordingId` (STRING, nullable): GCP object path.
  - `encryptionKey` (STRING, nullable): random per-call encryption key **only when the client did not supply a key**. When the client does supply a key in `recording.key`, this column remains null and the server never stores that key.

---

## 3. Environment and storage

- **RECORDING_STORAGE_PATH** (optional): Base path for recording objects in the storage bucket.
  - When not set, the system defaults to: `gs://llm-voice/${NODE_ENV}-recordings` (with `NODE_ENV` defaulting to `development` if unset).
  - Use the same format as GCS-style URLs:
  - **GCS:** `gs://<bucket>/<optional-prefix>/` (e.g. `gs://my-bucket/recordings/`). The implementation will append `{callId}.wav` (or `{callId}.enc` when encrypted).
  - Alternatively a URL form such as `https://storage.googleapis.com/<bucket>/<prefix>/` can be supported if the upload client uses the same bucket/prefix; the plan assumes parsing `gs://` to get bucket and prefix.
- **Credentials:** Use existing Google credentials already used elsewhere in the project:
  - `GOOGLE_APPLICATION_CREDENTIALS` (path to service account JSON), or
  - Application Default Credentials when running on GCP.
- **Client:** Use **@google-cloud/storage** in the LiveKit agent package (add dependency if not present). GCS is S3-compatible only via optional adapters; for “S3 type” the user clarified storage is **GCP via existing Google credential**, so the native GCS client is the right choice.

---

## 4. Custom recording implementation (no LiveKit Cloud / no agent built-in recording)

Because we need **encryption**, **stereo/mono** control, and **direct storage to the bucket**, we implement our own recording pipeline instead of relying on LiveKit agent recording or LiveKit Egress. For a pipeline-based alternative (teeing the agent’s input/output streams), see [RecorderIO investigation](recording-recorder-io-investigation.md).

### 4.1 Architecture

- **worker.ts** (LiveKit agent entry):
  - Resolves effective `recording` config (instance then agent).
  - If `recording.enabled`: creates a **recording pipeline** from a new lib, starts it after the session/call is up, and on session end (shutdown callback) stops the pipeline, awaits the returned `recordingId`, and updates the call via an internal API. The pipeline uses `RECORDING_STORAGE_PATH` when set, or its default when not.
  - Does **not** use `session.start({ record: true })`; transfer/consultation sessions continue to use `record: false`.
- **New lib** (see 4.2): Owns all capture, encoding, encryption, and upload. Worker only wires it into the agent lifecycle.

### 4.2 New lib: recording pipeline

**File:** `agents/livekit/lib/call-recording.ts` (or `recording-pipeline.ts`).

**Responsibility:** Abstract the “push onto the agent pipeline” recording logic so the worker stays clear. The lib:

1. **Inputs**
  - `room`: the LiveKit `Room` from the agent (`ctx.room` / `job.room` from `@livekit/rtc-node`).
  - `callId`: string (for naming the file and associating with the call).
  - `options`: `{ stereo: boolean; encryptionKey?: string }` (stereo = dual-channel; mono = single mixed channel).
  - Storage config: read from env `RECORDING_STORAGE_PATH` (or its default) inside the lib (or accept an options bag with base path).

2. **Streaming capture and encode (no in-memory buffering)**
   - **GCS stream setup (first):** On `startRoomRecording`, immediately create a write stream using `file.createWriteStream()` from `@google-cloud/storage`, targeting an object path derived from `RECORDING_STORAGE_PATH` (or its default) and `callId` (e.g. `{prefix}{callId}.raw` or `{prefix}{callId}.enc`).
   - **Optional encryption transform:** If `encryptionKey` is provided, create a Node `Transform` stream using `crypto.createCipheriv` (e.g. AES-256-GCM) and pipe **GCS write stream ← cipher ← audio pipeline** so encryption is performed **on the fly**.
   - **Subscribe to room audio tracks:** use `RoomEvent.TrackSubscribed` (and handle `TrackUnsubscribed`). For each audio track, create an `AudioStream(track)` from `@livekit/rtc-node` and consume frames as an async iterator (pattern from the receive-audio example), writing each frame directly into the pipeline (no frame accumulation in memory).
   - **Mono:** For each frame, mix all active participants’ audio to a single channel (e.g. sum and normalize samples) and write the resulting PCM chunk straight into the transform/GCS stream.
   - **Stereo:** For each frame, map participants to left/right in real time (e.g. caller = left, agent = right). If only one side is present, either duplicate or leave the unused channel silent. The mixed stereo frame is then written straight into the transform/GCS stream.
   - **Format:** Use a streaming-friendly format that does not require a final-size header (e.g. raw 16‑bit PCM like LINEAR16, or an OGG/Opus container if you later want compression). The important point is: **no long-lived in-memory buffer, only streaming writes**. If a container like WAV is desired for some reason, it should be implemented either with a temp file on disk or a streaming header update strategy, but the default plan is raw PCM for simplicity and robustness.

3. **Upload lifecycle**
   - Since the write goes directly to GCS, there is no separate “upload” phase. The upload is effectively continuous as frames are received.
   - On `stopRoomRecording`, unsubscribe from further frames, end the audio pipeline, and wait for the GCS stream `'finish'` event. This guarantees all buffered bytes are flushed to storage.
   - Return **recordingId**: the object path used in GCP (e.g. `prefix/callId.raw` or `prefix/callId.enc`). This is what is stored on `Call.recordingId` and later used by `GET /calls/{callId}/recording` to stream the audio.

6. **API**
   - `startRoomRecording(room, callId, options): Promise<RoomRecordingHandle>`  
     - Subscribes to tracks, starts collecting frames, returns a handle.
   - `stopRoomRecording(handle): Promise<{ recordingId: string }>`  
     - Stops collection, flushes and encodes, optionally encrypts, uploads to GCP, returns `recordingId`.

The worker only calls `startRoomRecording` after the session has started and `stopRoomRecording` in the shutdown callback (or when the call ends). No recording logic lives in the worker beyond config resolution and start/stop.

### 4.3 Worker integration (worker.ts)

- After resolving scenario (instance, agent, call):
  - Compute effective recording: `effectiveRecording = instance.metadata?.recording ?? agent.options?.recording` (or listener options if passed through).
- If `effectiveRecording?.enabled` and `process.env.RECORDING_STORAGE_PATH_URL`:
  - Create recording handle: `const recordingHandle = await startRoomRecording(ctx.room, call.id, { stereo: effectiveRecording.stereo ?? false, encryptionKey: effectiveRecording.key })`. Use the same `Room` type the worker already uses (`job.room` / `ctx.room`).
  - In the session shutdown callback (the same place we today call `getActiveCall().end()` and cleanup):
    - `const { recordingId } = await stopRoomRecording(recordingHandle)`.
    - Call new API `setCallRecordingId(call.id, recordingId)` (see 4.4).
- If recording is disabled or env not set, do not start the pipeline.
- **Transfer/consultation:** Do not start recording for the consultation room (transfer-handler already uses `record: false`); only the primary call records.

### 4.4 Internal API: set call recordingId and encryptionKey

- **Endpoint:** `PUT /api/agent-db/call/{callId}/recording` (or `PATCH` with body `{ recordingId, encryptionKey? }`).
- **Auth:** Internal (e.g. same as other agent-db routes: shared token or service auth).
- **Behaviour:** Load Call by `callId`, set:
  - `call.recordingId = body.recordingId`
  - `call.encryptionKey = body.encryptionKey ?? call.encryptionKey` (only set when we generated a random key; remain null when client provided their own).
  Save and return 200.
- **api-client.ts:** Add `setCallRecordingData(callId: string, recordingId: string, encryptionKey?: string): Promise<void>` that calls this endpoint so the worker can update the call after upload.

---

## 5. Recording options summary

| Option | Location | Purpose |
|--------|----------|--------|
| `recording.enabled` | Agent options, instance/listener override | Turn recording on for this agent/instance. |
| `recording.key` | Agent options, instance/listener override | Optional; if set, encrypt recording (AES-256) before upload; client decrypts with same key. |
| `recording.stereo` | Agent options, instance/listener override | `false` = mono (default), `true` = stereo (e.g. caller L, agent R). |

---

## 6. File and schema changes checklist

- **api/api-doc.yaml**
  - Add `recording` to `AgentOptions` (and to listener join `options` if supporting override at join).
  - Path `GET /calls/{callId}/recording` updated to document streaming behaviour and encryption modes.
  - Path `PUT /api/agent-db/call/{callId}/recording` (internal) with body `{ recordingId, encryptionKey? }`.
- **agents/livekit/lib/api-client.ts**
  - Add `recording?: { enabled: boolean; key?: string; stereo?: boolean }` to `Agent.options`.
  - Add `setCallRecordingData(callId: string, recordingId: string, encryptionKey?: string): Promise<void>`.
- **api/paths/calls/{callId}/recording.js**
  - Implement GET as a streaming endpoint that reads from the storage bucket and conditionally decrypts based on `Call.encryptionKey`.
- **api/paths/agent-db/call/{callId}/recording.js** (new)
  - PUT handler: set `Call.recordingId` and optional `Call.encryptionKey` from body, save, return 200.
- **lib/database.js**
  - Call model has nullable `recordingId` (already added) and nullable `encryptionKey` (new) to hold server-generated per-call keys.
- **agents/livekit/lib/call-recording.ts** (new)
  - `startRoomRecording(room, callId, options)` / `stopRoomRecording(handle)`.
  - Capture from room (TrackSubscribed, AudioStream), mono/stereo mix, streaming encode, optional AES encrypt, upload to the storage bucket using `RECORDING_STORAGE_PATH` (or its default), return recordingId.
- **agents/livekit/lib/worker.ts**
  - Resolve effective `recording` from instance then agent.
  - If recording enabled: start recording pipeline after session start; in shutdown callback stop pipeline and call `setCallRecordingData(call.id, recordingId, encryptionKey?)` when a server-generated key is used.
- **agents/livekit/lib/transfer-handler.ts**
  - No change: keep consultation session with `record: false`.
- **agents/livekit/package.json**
  - Add dependency `@google-cloud/storage` if not already present.

---

## 7. Encryption and stereo details

- **Encryption:** Application-level AES-256 (e.g. GCM). Key derived from `recording.key`. Store only the ciphertext in GCP; do not store the key. Document for API consumers that when `key` was set, the file at `recordingId` is encrypted and must be decrypted client-side with the same key.
- **Stereo:** Two channels. Suggested mapping: left = first remote participant (e.g. caller), right = agent / second participant. If only one track, duplicate to both channels or leave one silent; document the convention.

---

## 8. GET /calls/{callId}/recording and download URL (optional later)

The endpoint behaves as follows:

- Load `Call` by `callId`; if no `recordingId` → 404.
- If **`Call.encryptionKey` is non-null** (server-generated key case):
  - Create a GCS read stream for `recordingId`.
  - Create an AES-256-GCM decrypt stream from `Call.encryptionKey`.
  - Pipe `GCS → decipher → HTTP response`, streaming **plaintext audio**.
  - Record the download in the billing table (see section 9).
- If **`Call.encryptionKey` is null** (client-provided key case):
  - Generate a **very short-lived signed URL** from GCS for `recordingId` (e.g. 30–60 seconds expiry).
  - Respond with a redirect (`302` / `303`) to that URL, so the client downloads the **encrypted** object directly from GCS and decrypts it client-side.
  - Record the generation of this signed URL as a download event in the billing table (see section 9).

In both cases, every successful invocation that either streams or redirects to a recording counts as a **download event** and is written to the billing table.

---

## 9. Download logging and billing

For billing and audit purposes, every time `/calls/{callId}/recording` is used to access a recording (either by streaming decrypted audio or by generating a signed GCS URL), we write a row into a dedicated **call recording downloads** table.

**Table schema (Sequelize model example):**

- `id` (primary key, auto-increment `BIGINT`)
- `callId` (UUID, indexed)
- `organisationId` (UUID, indexed)
- `userId` (UUID, indexed)
- `downloadedAt` (timestamp, default now)

**Behaviour:**

- When `/calls/{callId}/recording` successfully:
  - Begins streaming decrypted audio (server-key case), or
  - Generates and returns a redirect to a signed GCS URL (client-key case),
- It should:
  - Look up the `Call` row to get `organisationId` and `userId` (the call owner).
  - Insert a row into the new downloads table with:
    - `callId`: the call’s ID
    - `organisationId`: from `Call.organisationId`
    - `userId`: from `Call.userId`
    - `downloadedAt`: current timestamp

This ensures that **every access to a recording is billable and auditable**, regardless of encryption mode.

This plan keeps the REST surface small, uses a single env var for storage path, reuses Google credentials, and isolates all capture/encode/encrypt/upload logic in a dedicated lib so the worker only wires recording into the agent lifecycle.
