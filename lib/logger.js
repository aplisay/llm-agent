const pino = require('pino');
const { createGcpLoggingPinoConfig } = require('@google-cloud/pino-logging-gcp-config');


module.exports = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging'
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