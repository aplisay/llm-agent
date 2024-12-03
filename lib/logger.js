const pino = require('pino');
const { createGcpLoggingPinoConfig } = require('@google-cloud/pino-logging-gcp-config');


module.exports = process.env.NODE_ENV === 'production'
  ? pino(
    createGcpLoggingPinoConfig(
      {},
      {
        // set Pino log level to 'info'  by default
        level: 'debug',
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