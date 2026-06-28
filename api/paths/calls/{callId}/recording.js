import { Call, CallRecordingDownload } from '../../../../lib/database.js';
import { Storage } from '@google-cloud/storage';
import { requirePermission } from '../../../../lib/auth/permissions.js';
import {
  GcmDecryptStream,
  parseGcsPath,
  defaultRecordingBaseUrl,
} from '../../../../lib/recording/index.js';

export default function (logger) {
  const storage = new Storage();

  const getCallRecording = async (req, res) => {
    if (!requirePermission(res, 'recording', 'download')) return;
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

    const { bucket } = parseGcsPath(defaultRecordingBaseUrl());
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

        res.setHeader('Content-Type', 'audio/ogg');
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

    // No server-stored key: file is either encrypted (client-provided key) or legacy plain.
    // Stream the file as-is so the client can decrypt when they provided the key.
    try {
      res.setHeader('Content-Type', 'application/octet-stream');
      const readStream = file.createReadStream();
      readStream.on('error', (err) => {
        logger.error({ err, callId: call.id }, 'error reading recording from GCS');
        if (!res.headersSent) {
          res.status(500).end('Error reading recording');
        } else {
          res.end();
        }
      });
      readStream.pipe(res);
    } catch (err) {
      logger.error({ err, callId: call.id }, 'failed to stream recording');
      return res.status(500).send({ error: 'Internal server error' });
    }
  };

  getCallRecording.apiDoc = {
    summary: 'Stream or redirect to a call recording',
    description:
      'Streams decrypted audio when the server holds a per-call encryption key, or redirects to a short-lived signed URL when the client provided the encryption key.',
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
        description: 'Streaming raw audio when decrypted on the server.',
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
  if (!requirePermission(res, 'recording', 'delete')) return;
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

    const { bucket } = parseGcsPath(defaultRecordingBaseUrl());
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
