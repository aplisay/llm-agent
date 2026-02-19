import { Storage } from '@google-cloud/storage';
import { randomBytes, createCipheriv } from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Room, RemoteTrack, RemoteTrackPublication, RemoteParticipant } from '@livekit/rtc-node';
import { RoomEvent, TrackKind, TrackSource, AudioStream } from '@livekit/rtc-node';
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

  let bytesWritten = iv.length;
  const originalWrite = writeStream.write.bind(writeStream);
  writeStream.write = function (chunk: Buffer | string, ...args: any[]): boolean {
    const len = typeof chunk === 'string' ? Buffer.byteLength(chunk) : (chunk as Buffer).length;
    bytesWritten += len;
    return originalWrite(chunk as any, ...args);
  };

  // First write the IV so the decryptor can reconstruct it later.
  writeStream.write(iv);

  logger.info({ callId, bucket, objectName }, 'startRoomRecording: started writing recording to GCS');

  let stopping = false;
  let firstChunkLogged = false;
  // Per-track chunk counts for debug (participantIdentity -> count)
  const chunkCountByParticipant: Record<string, number> = {};
  let totalChunksReceived = 0;

  const onTrackSubscribed = async (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    try {
      if (track.kind !== TrackKind.KIND_AUDIO) {
        return;
      }
      // Record only microphone source (same as agent pipeline) so we capture user + agent output consistently
      const source = (publication as { source?: number }).source;
      if (source !== undefined && source !== TrackSource.SOURCE_MICROPHONE) {
        logger.debug(
          { callId, trackSid: track.sid, source },
          'startRoomRecording: skipping non-microphone track',
        );
        return;
      }

      const participantKey = participant.identity ?? track.sid;
      if (chunkCountByParticipant[participantKey] !== undefined) {
        logger.debug(
          { callId, trackSid: track.sid, participantIdentity: participant.identity },
          'startRoomRecording: already recording this participant, skipping duplicate track',
        );
        return;
      }
      chunkCountByParticipant[participantKey] = 0;

      logger.info(
        { callId, trackSid: track.sid, participantIdentity: participant.identity },
        'startRoomRecording: subscribed to audio track for recording',
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
          totalChunksReceived += 1;
          chunkCountByParticipant[participantKey] = (chunkCountByParticipant[participantKey] ?? 0) + 1;
          logger.debug(
            {
              callId,
              participantIdentity: participant.identity,
              trackSid: track.sid,
              chunkBytes: encryptedChunk.length,
              frameBytes: buf.length,
              chunkIndex: chunkCountByParticipant[participantKey],
              totalChunksFromAllTracks: totalChunksReceived,
            },
            'startRoomRecording: participant audio chunk received and written',
          );
          if (!firstChunkLogged) {
            firstChunkLogged = true;
            logger.info(
              { callId, firstChunkBytes: encryptedChunk.length, participantIdentity: participant.identity },
              'startRoomRecording: first audio chunk written',
            );
          }
        }
      }

      logger.debug(
        { callId, participantIdentity: participant.identity, trackSid: track.sid, totalChunks: chunkCountByParticipant[participantKey] },
        'startRoomRecording: audio track stream ended',
      );
    } catch (err) {
      logger.error({ err, callId, participantIdentity: participant.identity, trackSid: track.sid }, 'startRoomRecording: error recording audio track');
    }
  };

  room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);

  // Process already-subscribed tracks (session RoomIO may have subscribed before we attached,
  // or tracks may have been subscribed on room connect). Same pattern as agents-js ParticipantAudioInputStream.
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      const track = publication.track;
      const pubSource = (publication as { source?: number }).source;
      if (
        !track ||
        track.kind !== TrackKind.KIND_AUDIO ||
        pubSource !== TrackSource.SOURCE_MICROPHONE
      ) {
        continue;
      }
      logger.info(
        { callId, participantIdentity: participant.identity, trackSid: track.sid },
        'startRoomRecording: processing already-subscribed audio track',
      );
      onTrackSubscribed(track, publication, participant);
    }
  }

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

      logger.info(
        {
          bucket,
          objectName,
          callId,
          bytesWritten,
          totalChunksReceived,
          chunkCountByParticipant,
        },
        'startRoomRecording: finished writing recording to GCS',
      );
      if (bytesWritten <= iv.length + 16) {
        logger.warn(
          { callId, bytesWritten, objectName, totalChunksReceived, chunkCountByParticipant },
          'startRoomRecording: recording is effectively empty (no or minimal audio data)',
        );
      }
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

const RECORDER_IO_FILENAME = 'audio.ogg';

/**
 * Upload the RecorderIO OGG file from the session directory to GCS and delete the local file.
 * Used when recording via the agents SDK RecorderIO (pipeline tee) instead of room-listener.
 */
export async function uploadRecorderIOToGcs(
  sessionDirectory: string,
  callId: string,
): Promise<{ gcsBucket: string; gcsObject: string }> {
  const basePath =
    RECORDING_STORAGE_PATH || `gs://llm-voice/${NODE_ENV || 'development'}-recordings`;
  const { bucket, prefix } = parseGcsPath(basePath);
  const objectName = `${prefix}${callId}.ogg`;
  const localPath = path.join(sessionDirectory, RECORDER_IO_FILENAME);

  if (!fs.existsSync(localPath)) {
    logger.warn({ callId, sessionDirectory, localPath }, 'uploadRecorderIOToGcs: OGG file not found, skipping upload');
    throw new Error(`RecorderIO recording file not found: ${localPath}`);
  }

  const storage = new Storage();
  const file = storage.bucket(bucket).file(objectName);

  await new Promise<void>((resolve, reject) => {
    const writeStream = file.createWriteStream({
      metadata: { contentType: 'audio/ogg' },
      resumable: false,
    });
    const readStream = fs.createReadStream(localPath);
    readStream.on('error', reject);
    writeStream.on('error', reject);
    writeStream.on('finish', () => resolve());
    readStream.pipe(writeStream);
  });

  try {
    await fs.promises.unlink(localPath);
  } catch (err) {
    logger.warn({ err, localPath, callId }, 'uploadRecorderIOToGcs: failed to delete local OGG file');
  }

  logger.info({ callId, bucket, objectName }, 'uploadRecorderIOToGcs: uploaded RecorderIO OGG to GCS');
  return { gcsBucket: bucket, gcsObject: objectName };
}

