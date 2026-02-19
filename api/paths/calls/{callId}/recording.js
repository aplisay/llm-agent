import { Call, CallRecordingDownload } from '../../../../lib/database.js';
import { Storage } from '@google-cloud/storage';
import { createDecipheriv } from 'crypto';
import { Transform } from 'stream';

const { RECORDING_STORAGE_PATH, NODE_ENV } = process.env;

function parseGcsPath(baseUrl) {
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

class GcmDecryptStream extends Transform {
  constructor(key) {
    super();
    this.key = key;
    this.ivBuffer = Buffer.alloc(0);
    this.ciphertextBuffer = Buffer.alloc(0);
    this.decipher = null;
  }

  _transform(chunk, _encoding, callback) {
    try {
      // Accumulate IV first (12 bytes)
      if (!this.decipher) {
        this.ivBuffer = Buffer.concat([this.ivBuffer, chunk]);
        if (this.ivBuffer.length < 12) {
          return callback();
        }
        const iv = this.ivBuffer.subarray(0, 12);
        const remaining = this.ivBuffer.subarray(12);
        this.decipher = createDecipheriv('aes-256-gcm', this.key, iv);
        this.ciphertextBuffer = remaining;
        return callback();
      }

      // After IV, buffer ciphertext + tag
      this.ciphertextBuffer = Buffer.concat([this.ciphertextBuffer, chunk]);
      callback();
    } catch (err) {
      callback(err);
    }
  }

  _flush(callback) {
    try {
      if (!this.decipher) {
        return callback();
      }
      if (this.ciphertextBuffer.length < 16) {
        return callback(new Error('Invalid ciphertext: not enough data for auth tag'));
      }
      const authTag = this.ciphertextBuffer.subarray(this.ciphertextBuffer.length - 16);
      const ciphertext = this.ciphertextBuffer.subarray(0, this.ciphertextBuffer.length - 16);
      this.decipher.setAuthTag(authTag);
      if (ciphertext.length > 0) {
        const decrypted = this.decipher.update(ciphertext);
        if (decrypted.length > 0) {
          this.push(decrypted);
        }
      }
      const finalData = this.decipher.final();
      if (finalData.length > 0) {
        this.push(finalData);
      }
      callback();
    } catch (err) {
      callback(err);
    }
  }
}

export default function (logger) {
  const storage = new Storage();

  const getCallRecording = async (req, res) => {
    const { callId } = req.params;

    const where = { id: callId, ...res.locals.user.sql.where };
    logger.debug({ callId, where }, 'getCallRecording');

    const call = await Call.findOne({ where });

    if (!call) {
      return res.status(404).send({ error: 'Call not found' });
    }

    if (!call.recordingId) {
      return res.status(404).send({ error: 'Recording not found for this call' });
    }

    // Log download for billing / audit
    try {
      await CallRecordingDownload.create({
        callId: call.id,
        organisationId: call.organisationId,
        userId: call.userId,
        downloadedAt: new Date(),
      });
    } catch (err) {
      logger.error({ err, callId: call.id }, 'failed to log recording download');
    }

  const basePath =
      RECORDING_STORAGE_PATH || `gs://llm-voice/${NODE_ENV || 'development'}-recordings`;
    const { bucket } = parseGcsPath(basePath);
    const objectName = call.recordingId;
    const file = storage.bucket(bucket).file(objectName);

    // Diagnostics: log recording metadata and GCS object size to debug empty recordings
    let objectSize = null;
    try {
      const [metadata] = await file.getMetadata();
      objectSize = metadata?.size != null ? Number(metadata.size) : null;
    } catch (err) {
      logger.warn({ err, callId: call.id, objectName, bucket }, 'getCallRecording: could not get recording object metadata (object may not exist yet)');
    }
    logger.info({
      callId: call.id,
      recordingId: call.recordingId,
      bucket,
      objectName,
      hasEncryptionKey: Boolean(call.encryptionKey),
      objectSizeBytes: objectSize,
    }, 'getCallRecording: serving recording');
    if (objectSize === 0 || (objectSize == null && call.encryptionKey)) {
      logger.warn({ callId: call.id, objectName, objectSizeBytes: objectSize }, 'getCallRecording: GCS object is missing or zero length');
    }

    // If we have a server-stored encryptionKey, decrypt and stream plaintext audio
    if (call.encryptionKey) {
      try {
        const key = Buffer.from(call.encryptionKey, 'base64');
        const decryptStream = new GcmDecryptStream(key);
        const readStream = file.createReadStream();

        res.setHeader('Content-Type', 'application/octet-stream');
        readStream
          .on('error', (err) => {
            logger.error({ err, callId: call.id }, 'error reading recording from GCS');
            if (!res.headersSent) {
              res.status(500).end('Error reading recording');
            } else {
              res.end();
            }
          })
          .pipe(decryptStream)
          .on('error', (err) => {
            logger.error({ err, callId: call.id }, 'error decrypting recording');
            if (!res.headersSent) {
              res.status(500).end('Error decrypting recording');
            } else {
              res.end();
            }
          })
          .pipe(res);
        return;
      } catch (err) {
        logger.error({ err, callId: call.id }, 'failed to set up decrypt stream');
        return res.status(500).send({ error: 'Internal server error' });
      }
    }

    // Otherwise, client provided the key; generate a short-lived signed URL and redirect
    try {
      const [signedUrl] = await file.getSignedUrl({
        action: 'read',
        expires: Date.now() + 60 * 1000, // 60 seconds
      });
      logger.debug({ callId: call.id, signedUrl }, 'redirecting to signed GCS URL for encrypted recording');
      return res.redirect(302, signedUrl);
    } catch (err) {
      logger.error({ err, callId: call.id }, 'failed to generate signed URL for recording');
      return res.status(500).send({ error: 'Internal server error' });
    }
  };

  getCallRecording.apiDoc = {
    summary: 'Stream or redirect to a call recording',
    description:
      'Streams decrypted audio when the server holds a per-call encryption key, or redirects to a short-lived signed GCS URL when the client provided the encryption key.',
    tags: ['Calls'],
    operationId: 'getCallRecording',
    parameters: [
      {
        name: 'callId',
        in: 'path',
        description: 'The call ID',
        required: true,
        schema: {
          type: 'string',
        },
      },
    ],
    responses: {
      200: {
        description: 'Streaming plaintext audio when decrypted on the server.',
      },
      302: {
        description: 'Redirect to a short-lived signed URL for the encrypted recording.',
      },
      404: {
        description: 'Call or recording not found',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                error: {
                  type: 'string',
                },
              },
            },
          },
        },
      },
      500: {
        description: 'Internal server error',
      },
    },
  };

  return {
    GET: getCallRecording,
    DELETE: deleteCallRecording,
  };
}

async function deleteCallRecording(req, res) {
  const { callId } = req.params;
  const storage = new Storage();

  const where = { id: callId, ...res.locals.user.sql.where };

  try {
    const call = await Call.findOne({ where });

    if (!call) {
      return res.status(404).send({ error: 'Call not found' });
    }

    if (!call.recordingId) {
      // Nothing to delete; treat as not found for recording
      return res.status(404).send({ error: 'Recording not found for this call' });
    }

    const basePath =
      RECORDING_STORAGE_PATH || `gs://llm-voice/${NODE_ENV || 'development'}-recordings`;
    const { bucket } = parseGcsPath(basePath);
    const objectName = call.recordingId;
    const file = storage.bucket(bucket).file(objectName);

    try {
      await file.delete({ ignoreNotFound: true });
    } catch (err) {
      // Log but still proceed with clearing metadata
      // eslint-disable-next-line no-console
      console.error({ err, callId: call.id, objectName }, 'error deleting recording object from storage');
    }

    call.recordingId = null;
    call.encryptionKey = null;
    await call.save();

    return res.status(204).send();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error({ err, callId }, 'error deleting recording for call');
    return res.status(500).send({ error: 'Internal server error' });
  }
}

