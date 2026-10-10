import { openJoinMetadata } from "../agent-lib/join-metadata.js";
import type { CallMetadata } from "./api-client.js";
import type { JobMetadata } from "./types.js";

/**
 * The caller's metadata for this call from the job dispatch: plain
 * `callMetadata` from an originate, or `sealedCallMetadata` from a WebRTC join
 * (lib/handlers/livekit.js). Throws if the sealed value will not open.
 */
export function jobCallMetadata(
  job: JobMetadata,
  secret: string | undefined,
): CallMetadata {
  if (job.sealedCallMetadata) {
    return openJoinMetadata(job.sealedCallMetadata, secret);
  }
  return job.callMetadata || {};
}

/**
 * The call record's metadata: the listener activation's, then the caller's
 * over it, then the platform's `aplisay` block, which callers cannot override.
 */
export function mergeCallMetadata(
  instanceMetadata: CallMetadata | null | undefined,
  callMetadata: CallMetadata | null | undefined,
  aplisay: CallMetadata,
): CallMetadata {
  return { ...(instanceMetadata || {}), ...(callMetadata || {}), aplisay };
}
