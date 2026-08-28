/**
 * Runaway tool-call breaker.
 *
 * A realtime model that gets an unsatisfying tool result can re-issue the same
 * call as fast as it can generate — far faster than any human-paced turn. On a
 * live call that burns carrier minutes, model minutes and tokens silently, with
 * no error raised anywhere. These bounds are per tool name, per session.
 *
 * Sizing: a genuine voice turn needs speech in and speech out, so even an
 * impatient caller cannot legitimately drive one tool past a handful of calls
 * in 20s. REFUSE is set well above that; KILL is set where the loop is plainly
 * mechanical and the model has shown it will not stop on its own.
 *
 * Lives in its own module (rather than inline in agent-tools.ts) so the policy
 * is testable without standing up the LiveKit SDK — see
 * test/tool-loop-breaker.test.ts.
 */

export const TOOL_LOOP_WINDOW_MS = 20_000;
/** Stop executing the tool and hand the model an explicit error instead. */
export const TOOL_LOOP_REFUSE_CALLS = 10;
/** Unrecoverable: tear the call down rather than keep billing it. */
export const TOOL_LOOP_KILL_CALLS = 25;

/**
 * Builtins that are polls BY DESIGN and so must never trip the breaker.
 *
 * The sizing above assumes one tool call per conversational turn, which holds
 * for every tool the model calls in order to *do* something. It does not hold
 * for a poll: `transfer_status` exists precisely so the model can watch a
 * transfer that is still in flight, and the platform's own transfer result
 * tells it to ("Consultation started. Use transfer_status to check progress."
 * — see transfer-handler.ts). A dialling window routinely runs 20-30s, so a
 * model polling even twice a second crosses REFUSE within the first few
 * seconds and KILL a few seconds after that — at which point the breaker tears
 * down a live, correctly behaving call in the middle of its transfer. That is
 * strictly worse than the failure it guards against: the caller is dropped
 * rather than merely charged.
 *
 * The exemption is safe for this shape of tool and only this shape. Membership
 * requires ALL of:
 *   - the tool only reads in-process state (no network I/O, no vendor spend,
 *     no side effect a loop could amplify);
 *   - repeat calls are the documented, intended usage, not a symptom;
 *   - the state it reports is expected to change without the model acting.
 *
 * `transfer_status` returns `getTransferState()` — a synchronous read of a
 * local field — and meets all three. `metadata` also reads locally, but fails
 * the second test: nothing asks the model to poll it, so a model spinning on
 * `metadata` IS a runaway and must still be caught.
 *
 * Keyed on `platform` (the builtin's stable identity), NOT on `name`: the
 * function name is author-supplied in the agent definition and can be anything.
 */
export const TOOL_LOOP_EXEMPT_PLATFORMS: ReadonlySet<string> = new Set([
  "transfer_status",
]);

/** True when this tool is a poll-by-design builtin, so the breaker stands down. */
export function isLoopExempt(fnc: {
  implementation?: string;
  platform?: string;
}): boolean {
  return (
    fnc.implementation === "builtin" &&
    !!fnc.platform &&
    TOOL_LOOP_EXEMPT_PLATFORMS.has(fnc.platform)
  );
}

export interface LoopVerdict {
  /** Calls to this tool inside the trailing window, including this one. */
  calls: number;
  /** Do not execute; hand the model a hard error instead. */
  refuse: boolean;
  /** Tear the call down. */
  kill: boolean;
  /**
   * An exempt tool just crossed the refuse threshold. Diagnostic only — the
   * tool still runs. True on the crossing call alone so a legitimate poll logs
   * once per hot spell rather than on every call for as long as it lasts.
   */
  hot: boolean;
}

/**
 * Creates a per-session breaker. The returned function records an invocation
 * and reports what should happen to it.
 *
 * State is per instance, so counts neither leak across calls nor survive an
 * agent handover — agent-tools.ts creates one per createTools() call.
 */
export function createToolLoopBreaker(now: () => number = Date.now): (
  tool: string,
  exempt: boolean,
) => LoopVerdict {
  // Sliding window of invocation times, keyed by tool name.
  const recentCalls = new Map<string, number[]>();

  return (tool, exempt) => {
    const at = now();
    const cutoff = at - TOOL_LOOP_WINDOW_MS;
    const times = (recentCalls.get(tool) ?? []).filter((t) => t > cutoff);
    times.push(at);
    recentCalls.set(tool, times);
    return {
      calls: times.length,
      refuse: !exempt && times.length > TOOL_LOOP_REFUSE_CALLS,
      kill: !exempt && times.length > TOOL_LOOP_KILL_CALLS,
      // Exactly the crossing call. Under a sustained loop the window stays
      // saturated, so this does not recur until the tool has actually cooled.
      hot: exempt && times.length === TOOL_LOOP_REFUSE_CALLS + 1,
    };
  };
}
