import { fileURLToPath } from 'node:url';
import { ServerOptions, cli } from '@livekit/agents';
import * as loggerModule from './agent-lib/logger.js';
import { runSetup } from './lib/initialise.js';
import worker from './lib/worker.js';
import { LogLevel } from 'node_modules/@livekit/rtc-node/dist/proto/ffi_pb.js';

const logger = loggerModule.default;

logger.info({ argv: process.argv }, 'worker started');
Error.stackTraceLimit = 40;

if (process.argv[2] === 'setup') {
  runSetup();
} else {
  cli.runApp(new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'realtime',
    port: 8081,
    production: true,
    // Pool of pre-spawned idle workers waiting for jobs. SDK default is 3,
    // which proved insufficient under burst load (the 7.5s assignment timeout
    // expires before new workers can spawn, causing retry storms). Override
    // via NUM_IDLE_PROCESSES at deploy time.
    numIdleProcesses: parseInt(process.env.NUM_IDLE_PROCESSES ?? '10', 10),
  }));
}

export default worker; 