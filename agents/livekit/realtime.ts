import { fileURLToPath } from 'node:url';
import { ServerOptions, cli } from '@livekit/agents';
import * as loggerModule from './agent-lib/logger.js';
import { runSetup } from './lib/initialise.js';
import worker from './lib/worker.js';
import { LogLevel } from 'node_modules/@livekit/rtc-node/dist/proto/ffi_pb.js';

const logger = loggerModule.default;

logger.info({ argv: process.argv }, 'worker started');

if (process.argv[2] === 'setup') {
  runSetup();
} else {
  cli.runApp(new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'realtime',
    port: 8081,
    production: true
  }));
}

export default worker; 