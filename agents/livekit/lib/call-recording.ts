import path from 'node:path';
import logger from './logger.js';
// @ts-expect-error JS module without published types; contract documented in lib/recording/CONTRACT.md
import { uploadEncryptedOgg } from '../agent-lib/recording/index.js';

const RECORDER_IO_FILENAME = 'audio.ogg';

export interface UploadRecorderIOOptions {
  /** When set, derive the encryption key from this string (client-side decrypt). */
  clientEncryptionKey?: string;
}

export interface UploadRecorderIOResult {
  gcsBucket: string;
  gcsObject: string;
  serverGeneratedKey?: string;
}

/**
 * Upload the RecorderIO OGG file from a LiveKit job session directory.
 *
 * Thin wrapper around the shared {@link uploadEncryptedOgg} helper. All the
 * encryption + GCS plumbing lives in `lib/recording/`; this function only
 * knows that the LiveKit SDK writes the file at `audio.ogg` inside the job's
 * session directory.
 */
export async function uploadRecorderIOToGcs(
  sessionDirectory: string,
  callId: string,
  options?: UploadRecorderIOOptions,
): Promise<UploadRecorderIOResult> {
  const localPath = path.join(sessionDirectory, RECORDER_IO_FILENAME);
  return uploadEncryptedOgg({
    localPath,
    callId,
    clientEncryptionKey: options?.clientEncryptionKey,
    logger,
  });
}
