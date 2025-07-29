import { fileURLToPath } from 'node:url';
import { WorkerOptions, cli } from '@livekit/agents';
import * as loggerModule from './agent-lib/logger.js';
import { runSetup } from './lib/initialise.js';
import worker from './lib/worker.js';

const logger = loggerModule.default;

logger.info({ argv: process.argv }, 'worker started');

if (process.argv[2] === 'setup') {
  runSetup();
} else {
  cli.runApp(new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'realtime',
    port: 8081
  }));
}

export default worker; 