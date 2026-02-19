# Call Recording in LLM Agents

This document describes how to enable call recording for agents and listeners, how recordings are stored and encrypted, and how to retrieve them via the REST API.

---

## Overview

Call recording is implemented entirely in the LLM Agent backend:

- Audio is captured from the LiveKit room in the LiveKit worker.
- Audio is **streamed directly** into a storage bucket (configured via env).
- Recordings are **always encrypted**, even if you do not specify a key.
- Decryption is handled either:
  - server‑side (when the server generated the key), or
  - client‑side (when you provided the key).

You control recording behaviour at:

- **Agent level**: default for all instances of that agent.
- **Listener/instance level**: override per instance via metadata or join options.

---

## Recording configuration

### Agent options

In the Agent definition, you can set:

```json
{
  "options": {
    "recording": {
      "enabled": true,
      "key": "optional-client-key",
      "stereo": false
    }
  }
}
```

- `enabled` (**required**, boolean): turn recording on/off for this agent.
- `key` (optional, string):
  - If **present**, this is treated as a **client‑provided encryption key**.
  - If **absent**, the server generates a random per‑call key.
- `stereo` (optional, boolean, default `false`):
  - `false`: mono recording (all participants mixed).
  - `true`: stereo; current implementation records raw PCM and can be extended to map participants to L/R channels.

### Instance / listener override

At instance/listener level, you can override recording for a specific listener, e.g. by setting:

- `instance.metadata.recording` or
- (if exposed) `listener.options.recording` in the join payload,

with the same shape:

```json
{
  "recording": {
    "enabled": true,
    "key": "per-instance-key",
    "stereo": true
  }
}
```

**Precedence:**

1. Listener/instance `recording` (if provided)
2. Agent‑level `options.recording`

---

## Encryption behaviour

Every recording is encrypted using AES‑256‑GCM. There are two modes:

### 1. Client‑provided key

If you specify `options.recording.key` at the agent/instance level:

- The recording is encrypted using a key derived from this value.
- The server **does not store** this key.
- The encrypted file is written to the storage bucket.

**Implication:** Only your client (who knows the key) can decrypt the recording.

### 2. Server‑generated key

If you omit `options.recording.key`:

- The system generates a random per‑call key internally.
- The recording is still fully encrypted in the storage bucket.

**Implication:** The server can transparently decrypt on behalf of clients, and downloads from the API will stream **plaintext audio**.

---

## Retrieving a recording

### Endpoint

```http
GET /calls/{callId}/recording
```

Auth and scoping are identical to other call APIs: the caller must be allowed to access that call (organisation/user scoping is enforced).

### Behaviour

1. The API looks up the `Call`:
   - If there is no `recordingId`, it returns `404`.
2. It then branches based on the encryption mode:

#### A. Server‑generated key (decrypt and stream)

- If you **did not** provide `options.recording.key`, the server generated a key for you.
- The API returns a **stream of raw audio** (no decryption needed on the client).

#### B. Client‑provided key (redirect to encrypted object)

- If you **did** provide `options.recording.key`, the server does not know your key.
- The API returns a **redirect (302/303)** to a short‑lived URL for the encrypted object in the storage bucket.
- Your client:
  - Follows the redirect and downloads the **encrypted** data.
  - Decrypts it locally using the same key you set in `options.recording.key`.

---

## Deleting a recording

### Delete endpoint

```http
DELETE /calls/{callId}/recording
```

### Delete behaviour

- Auth and scoping are the same as for `GET /calls/{callId}/recording`.
- When called:
  - If the call does not exist or has no associated recording, the API returns `404`.
  - If a recording exists, the server permanently deletes it from storage and clears its metadata for that call.
  - On success, the API returns **`204 No Content`**.

Use this endpoint when you want to permanently remove the stored recording for a given call.

---

## Summary of key points for API users

- **To enable recording**: set `options.recording.enabled = true` on the agent and/or listener instance.
- **To control encryption**:
  - Provide `options.recording.key` if you want to manage decryption yourself.
  - Omit `key` to let the server generate and manage per‑call keys and stream raw audio back to you.
- **To fetch recordings**:
  - Always use `GET /calls/{callId}/recording`.
  - If you did **not** provide a key, you get a raw audio stream (encryption is handled for you).
  - If you **did** provide a key, you are redirected to a short‑lived URL for the encrypted blob and must decrypt it yourself.
- **To delete recordings**:
  - Use `DELETE /calls/{callId}/recording` to permanently remove the stored recording for that call.
