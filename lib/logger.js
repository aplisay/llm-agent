const pino = require('pino');
const { createGcpLoggingPinoConfig } = require('@google-cloud/pino-logging-gcp-config');


module.exports = process.env.NODE_ENV === 'production'
  ? pino(
    createGcpLoggingPinoConfig(
      {},
      {
        // set Pino log level to 'debug'
        level: process.env.LOGLEVEL || 'info',
      }
    )
  )
  : pino(
    {
      level: process.env.LOGLEVEL || 'info',
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true
        }
      }
    }); 