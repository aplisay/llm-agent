// FIRST import: applies process-wide outbound connect defaults as a side effect, so
// they are in force before anything can open a socket. See net-defaults.ts — without it
// a >250ms SYN fails the request outright.
import { outboundNetworkDefaults } from './lib/net-defaults.js';
import { fileURLToPath } from 'node:url';
import { ServerOptions, cli } from '@livekit/agents';
import * as loggerModule from './agent-lib/logger.js';
import { installExitForensics } from './lib/exit-forensics.js';
import { runSetup } from './lib/initialise.js';
import { startRuntimeTelemetry } from './lib/runtime-telemetry.js';
import worker from './lib/worker.js';

const logger = loggerModule.default;

// Periodic event-loop-delay + CPU sample, off unless RUNTIME_STATS_MS is set.
// This runs in the supervisor and in every job process, because this module is
// evaluated in both. For a profile that also covers the module loading above,
// see lib/profile-hook.ts — it has to be attached with --import, since ESM
// hoisting means those imports are already resolved before this line runs.
startRuntimeTelemetry();

// Logged so the settings are verifiable in production rather than assumed. This entry
// runs in the parent worker AND in every spawned job process, which is where the
// outbound API calls actually happen.
logger.info(
  { argv: process.argv, net: outboundNetworkDefaults() },
  'worker started',
);
Error.stackTraceLimit = 40;

const isJobProcess = typeof process.send === 'function';

// Records who decided to stop this process, so a clean-but-unexplained exit
// (staging saw RestartCount=2 / ExitCode=0 / not OOM-killed) leaves evidence in
// `docker logs` instead of needing another deploy round trip to reproduce.
installExitForensics(isJobProcess ? 'job' : 'supervisor');

if (process.argv[2] === 'setup') {
  runSetup();
} else if (isJobProcess) {
  process.on('SIGTERM', () => process.exit(143));
  process.on('SIGINT', () => process.exit(130));
} else {
  // Drain backstop.
  //
  // The SDK's drain() only closes processes it believes are idle:
  //
  //     if (!proc.runningJob) { proc.close(); }   // -> SIGTERM after 5s
  //     return proc.join();                       // busy: wait, forever
  //
  // Job processes that finish a call without exiting are still counted as
  // busy, so drain() awaits join() on them and never signals them at all.
  // With those accumulating (15 alive under a pool of 3, oldest 16 hours),
  // every stop runs out stop_grace_period and docker force-kills — measured
  // at five stops today, five SIGKILLs, no clean shutdown.
  //
  // Registered BEFORE cli.runApp so this listener runs first, and armed only
  // on SIGTERM: if the SDK's own handler manages to drain and exit, the timer
  // never fires. unref'd so it can never hold the process open by itself.
  //
  // This bounds the damage, it does not fix it — a force-exit still cuts any
  // genuinely live call. The real fix is whatever stops job processes exiting;
  // `activeResources` in the runtime-stats line is there to identify it.
  const drainTimeoutMs = parseInt(process.env.DRAIN_TIMEOUT_MS ?? '30000', 10);
  if (Number.isFinite(drainTimeoutMs) && drainTimeoutMs > 0) {
    process.on('SIGTERM', () => {
      logger.warn(
        { drainTimeoutMs },
        'SIGTERM: arming drain backstop — will force-exit if drain has not completed',
      );
      setTimeout(() => {
        logger.error(
          { drainTimeoutMs },
          'drain did not complete within the backstop; forcing exit',
        );
        process.exit(143);
      }, drainTimeoutMs).unref();
    });
  }

  cli.runApp(new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'realtime',
    port: 8081,
    production: true,
    // Pool of pre-spawned idle workers waiting for jobs. SDK default is 3,
    // which proved insufficient in production under burst load (the 7.5s
    // assignment timeout expires before new workers can spawn, causing retry
    // storms). Dev and staging don't see that traffic, so keep them at 3 to
    // reduce local/staging resource usage. Override via NUM_IDLE_PROCESSES at
    // deploy time.
    numIdleProcesses: parseInt(
      process.env.NUM_IDLE_PROCESSES
        ?? (process.env.NODE_ENV === 'production' ? '10' : '3'),
      10,
    ),
  }));
}

export default worker;
