import pino from 'pino';
import { createGcpLoggingPinoConfig } from '@google-cloud/pino-logging-gcp-config';
import { errorForLog } from './error-answers.js';

// pino-http builds its own `err` serializer, so index.mjs passes this one to it as well.
export const serializers = { err: errorForLog };

const logger =
  process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging'
    ? pino(
        createGcpLoggingPinoConfig(
          {},
          {
            // set Pino log level to 'info' by default
            level: process.env.LOGLEVEL || 'info',
            serializers,
          },
        ),
      )
    : pino({
        level: process.env.LOGLEVEL || 'debug',
        depthLimit: 4,
        serializers,
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
          },
        },
      });

export default logger;
