import { Storage } from '@google-cloud/storage';
import { randomBytes, createCipheriv } from 'crypto';
import type { Room, RemoteTrack, RemoteTrackPublication, RemoteParticipant } from '@livekit/rtc-node';
import { RoomEvent, TrackKind, AudioStream } from '@livekit/rtc-node';
import logger from '../agent-lib/logger.js';

const { RECORDING_STORAGE_PATH, NODE_ENV } = process.env;

export interface RecordingOptions {
  stereo: boolean;
  encryptionKey?: string; // client-provided key (optional)
}

export interface RoomRecordingHandle {
  callId: string;
  room: Room;
  gcsBucket: string;
  gcsObject: string;
  stop: () => Promise<void>;
  // When using a server-generated key, this will be set
  serverGeneratedKey?: string;
}

function parseGcsPath(baseUrl: string): { bucket: string; prefix: string } {
  // Expect format: gs://bucket[/optional/prefix/]
  if (!baseUrl.startsWith('gs://')) {
    throw new Error('RECORDING_STORAGE_PATH must be a gs:// URL');
  }

  const withoutScheme = baseUrl.slice('gs://'.length);
  const firstSlash = withoutScheme.indexOf('/');
  if (firstSlash === -1) {
    return { bucket: withoutScheme, prefix: '' };
  }

  const bucket = withoutScheme.slice(0, firstSlash);
  let prefix = withoutScheme.slice(firstSlash + 1);
  if (prefix.length > 0 && !prefix.endsWith('/')) {
    prefix += '/';
  }
  return { bucket, prefix };
}

export async function startRoomRecording(
  room: Room,
  callId: string,
  options: RecordingOptions,
): Promise<RoomRecordingHandle> {
  const basePath =
    RECORDING_STORAGE_PATH || `gs://llm-voice/${NODE_ENV || 'development'}-recordings`;

  const { bucket, prefix } = parseGcsPath(basePath);
  const storage = new Storage();
  const objectName = `${prefix}${callId}.raw`;
  const bucketRef = storage.bucket(bucket);
  const fileRef = bucketRef.file(objectName);

  // Determine effective encryption key:
  // - If client provided `options.encryptionKey`, use it (but do not store it).
  // - Otherwise, generate a random per-call key and return it in the handle for persistence.
  let effectiveKey: Buffer;
  let serverGeneratedKey: string | undefined;
  if (options.encryptionKey) {
    // Derive a 32-byte key from the provided string (simple hash-then-truncate approach).
    const keyBytes = Buffer.from(options.encryptionKey, 'utf8');
    effectiveKey = keyBytes.length >= 32 ? keyBytes.subarray(0, 32) : Buffer.concat([keyBytes, Buffer.alloc(32 - keyBytes.length, 0)]);
  } else {
    const randomKey = randomBytes(32);
    effectiveKey = randomKey;
    // Store as base64 so it can be persisted if desired.
    serverGeneratedKey = randomKey.toString('base64');
  }

  const iv = randomBytes(12); // AES-GCM 96-bit IV
  const cipher = createCipheriv('aes-256-gcm', effectiveKey, iv);

  const writeStream = fileRef.createWriteStream({
    resumable: true,
    contentType: 'application/octet-stream',
  });

  // First write the IV so the decryptor can reconstruct it later.
  writeStream.write(iv);

  let stopping = false;

  const onTrackSubscribed = async (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    try {
      if (track.kind !== TrackKind.KIND_AUDIO) {
        return;
      }

      logger.debug(
        { callId, trackSid: track.sid, participantIdentity: participant.identity },
        'subscribed to audio track for recording',
      );

      const stream = new AudioStream(track);

      for await (const frame of stream) {
        if (stopping) {
          break;
        }

        // For now, do not attempt complex mixing; just write raw PCM frames.
        // Stereo/mono handling can be added here by reshaping frame.data.
        const buf = Buffer.from(frame.data.buffer);
        const encryptedChunk = cipher.update(buf);
        if (encryptedChunk.length > 0) {
          writeStream.write(encryptedChunk);
        }
      }
    } catch (err) {
      logger.error({ err, callId }, 'error recording audio track');
    }
  };

  room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);

  const stop = async () => {
    stopping = true;

    try {
      // Finalize cipher and write authentication tag.
      const finalChunk = cipher.final();
      if (finalChunk.length > 0) {
        writeStream.write(finalChunk);
      }
      const authTag = cipher.getAuthTag();
      writeStream.write(authTag);
      writeStream.end();

      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', () => resolve());
        writeStream.on('error', (err) => reject(err));
      });

      logger.info({ bucket, objectName, callId }, 'finished writing recording to GCS');
    } catch (err) {
      logger.error({ err, callId }, 'error finalising recording stream');
    } finally {
      room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
    }
  };

  return {
    callId,
    room,
    gcsBucket: bucket,
    gcsObject: objectName,
    stop,
    serverGeneratedKey,
  };
}

