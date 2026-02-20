# Call Recording in LLM Agents

This document describes how to enable call recording for agents and listeners, how recordings are stored and encrypted, and how to retrieve them via the REST API.

---

## Overview

Call recording is implemented entirely in the LLM Agent backend:

- When recording is enabled, the worker record agent interactions as **stereo OGG/Opus** transiently within the worker, then then encrypts and uploads this to a storage bucket. Recordings are encrypted at rest. 
- Recording is controlled at agent and instance level (see below). The `key` option controls who holds the encryption key (client or server).

You control recording behaviour at:

- **Agent level**: default for all instances of that agent.
- **Listener/instance level**: override per instance via the instance's recording object or join options.

---

## Recording configuration

### Agent options

In the Agent definition, you can set:

```json
{
  "options": {
    "recording": {
      "enabled": true,
      "key": "optional-client-key"
    }
  }
}
```

- `enabled` (**required**, boolean): turn recording on/off for this agent.
- `key` (optional, string):
  - If **present**, this is treated as a **client‑provided encryption key**.
  - If **absent**, the server generates a random per‑call key.

### Instance / listener override

At instance/listener level, you can override recording for a specific listener, e.g. by setting:

- `instance.recording` or

with the same shape:

```json
{
  "recording": {
    "enabled": true,
    "key": "per-instance-key"
  }
}
```

**Precedence:**

1. Listener/instance `recording` (if provided)
2. Agent‑level `options.recording`

---

## Encryption behaviour

Every recording is encrypted before upload. There are two modes:

### 1. Client‑provided key

If you specify `options.recording.key` at the agent/instance level:

- The recording is encrypted using a key derived from this value.
- The server **does not store** this key.
- The encrypted recording is stored.

**Implication:** Only your client (who knows the key) can decrypt the recording.

### 2. Server‑generated key

If you omit `options.recording.key`:

- The system generates a random per‑call key internally.
- The recording is still fully encrypted in storage.

**Implication:** The server stores the key against the recording in its database and can decrypt on behalf of clients; `GET /calls/{callId}/recording` streams **decrypted OGG audio** (Content-Type: audio/ogg).

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
- The API streams **decrypted OGG audio** (Content-Type: audio/ogg).

#### B. Client‑provided key (stream encrypted bytes)

- If you **did** provide `options.recording.key`, the server does not store your key.
- The API streams the **encrypted** file as-is (Content-Type: application/octet-stream).
- Your client must decrypt the stream locally using the same key.

### Example: stream and save (curl / OpenSSL)

Replace `$BASE_URL`, `$CALL_ID`, and your auth (e.g. `$TOKEN` or cookie) with real values.

**1. Server‑generated key (no decryption)**

The response is decrypted OGG audio. Save it directly:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/calls/$CALL_ID/recording" \
  -o recording.ogg
```

**2. Client‑provided key (decrypt with OpenSSL)**

The response is encrypted (first 12 bytes = IV, then ciphertext + 16-byte auth tag). Derive the 32-byte key from your key string (UTF-8, zero-padded or truncated to 32 bytes) and decrypt:

```bash
# Download encrypted stream
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/calls/$CALL_ID/recording" \
  -o encrypted.bin

# Derive 32-byte key (UTF-8, zero-pad to 32 bytes) and output as hex
CLIENT_KEY="your-recording-key"
KEY_HEX=$( ( echo -n "$CLIENT_KEY"; dd if=/dev/zero bs=1 count=32 2>/dev/null ) | head -c 32 | xxd -p | tr -d '\n' )

# Decrypt: IV = first 12 bytes; rest = ciphertext + auth tag
IV_HEX=$(head -c 12 encrypted.bin | xxd -p | tr -d '\n')
tail -c +13 encrypted.bin | openssl enc -aes-256-gcm -d -K "$KEY_HEX" -iv "$IV_HEX" -out recording.ogg
```

**3. Client‑provided key (decrypt with JavaScript fetch + Web Crypto)**

Same encrypted format (12-byte IV, then ciphertext + 16-byte auth tag). Derive the 32-byte key from your key string (UTF-8, zero-padded or truncated to 32 bytes) and decrypt in the browser with the Web Crypto API:

```javascript
const baseUrl = 'https://api.example.com';
const callId = 'your-call-id';
const clientKey = 'your-recording-key';

// Derive 32-byte key (UTF-8, zero-pad or truncate to 32 bytes)
function deriveKey(clientKey) {
  const utf8 = new TextEncoder().encode(clientKey);
  const key = new Uint8Array(32);
  key.set(utf8.subarray(0, 32));
  return crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
}

async function getEncryptedRecording() {
  const res = await fetch(`${baseUrl}/calls/${callId}/recording`, {
    headers: { 'Authorization': `Bearer ${yourToken}` },
  });
  if (!res.ok) throw new Error(res.statusText);
  const encrypted = new Uint8Array(await res.arrayBuffer());
  const iv = encrypted.subarray(0, 12);
  const ciphertextAndTag = encrypted.subarray(12);
  const key = await deriveKey(clientKey);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertextAndTag
  );
  return new Blob([decrypted], { type: 'audio/ogg' });
}

// Usage: getEncryptedRecording().then(blob => { ... save or play blob ... });
```

Resulting blob is playable OGG/Opus (e.g. create an object URL and set it as `audio.src`).

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
  - If a recording exists, the server permanently deletes it and clears its metadata for that call.
  - Note that due to the way that *permanent deletion* works in the underlying storage buckets, actual deletion of the data may happen some days later. We do not however provide any mecahism to recover deleted recordings during this time, and if server encryption has been used, we delete the key from the call record and would not be able to decrypt it even if it were to be recovered.
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
  - If you **did** provide a key, you receive a stream of encrypted bytes and must decrypt it yourself using the same key.
- **To delete recordings**:
  - Use `DELETE /calls/{callId}/recording` to permanently remove the stored recording for that call.
