import type { JobContext } from "@livekit/agents";
import logger from "./logger.js";

/**
 * What a job does once, at its end: upload the call recording and save the
 * InvocationLog. `reason` is the end reason to save when the attempt has none
 * of its own.
 */
export type JobFinaliser = (reason?: string) => Promise<void>;

/** How long a path that exits the process itself waits for the finaliser. */
export const EXIT_FINALISE_TIMEOUT_MS = 10_000;

type JobCtx = Pick<JobContext, "addShutdownCallback">;

const jobs = new WeakMap<JobCtx, { finaliser: JobFinaliser; done?: Promise<void> }>();

/**
 * Makes `finaliser` the one the job runs at its end, in place of an earlier
 * fallback attempt's. The job registers one shutdown callback, so it saves one
 * InvocationLog and uploads one recording however many attempts it makes.
 */
export function setJobFinaliser(ctx: JobCtx, finaliser: JobFinaliser): void {
  const job = jobs.get(ctx);
  if (job) {
    job.finaliser = finaliser;
    return;
  }
  jobs.set(ctx, { finaliser });
  ctx.addShutdownCallback(() => finaliseJob(ctx));
}

/** Runs the job's finaliser once. A later call waits for that run. */
export function finaliseJob(ctx: JobCtx, reason?: string): Promise<void> {
  const job = jobs.get(ctx);
  if (!job) return Promise.resolve();
  job.done ??= job.finaliser(reason).catch((e) => {
    logger.warn({ e }, "job finaliser failed");
  });
  return job.done;
}

/**
 * For a path that ends the process itself. agents-js runs the shutdown
 * callbacks only after the entry function returns and the room disconnects,
 * so a process.exit() soon after ctx.shutdown() skips them.
 */
export async function finaliseJobBeforeExit(ctx: JobCtx, reason?: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    finaliseJob(ctx, reason),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        logger.warn({ timeoutMs: EXIT_FINALISE_TIMEOUT_MS }, "job finaliser timed out before exit");
        resolve();
      }, EXIT_FINALISE_TIMEOUT_MS);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
}
