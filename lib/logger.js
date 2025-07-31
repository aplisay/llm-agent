import pino from 'pino';
import { createGcpLoggingPinoConfig } from '@google-cloud/pino-logging-gcp-config';

const logger = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging'
  ? pino(
    createGcpLoggingPinoConfig(
      {},
      {
        // set Pino log level to 'info'  by default
        level: process.env.LOGLEVEL || 'info',
      }
    )
  )
  : pino(
    {
      level: process.env.LOGLEVEL || 'debug',
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true
        }
      }
    });

export default logger; 