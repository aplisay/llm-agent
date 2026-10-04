import { voice } from "@livekit/agents";

/** Same budget as runAgentWorker's setup timeout. */
export const START_WINDOW_MS = 15_000;

/** Whether an agent has a fallback step, and so whether a start failure has anywhere to go. */
export function fallbackConfigured(options: { fallback?: Record<string, unknown> } | undefined): boolean {
  const fallback = options?.fallback;
  return Boolean(fallback && (fallback.agent || fallback.model || fallback.message || fallback.number));
}

/**
 * One agent attempt's start-up window: a failure before the agent first speaks,
 * within START_WINDOW_MS of the session starting, sends the call down
 * options.fallback instead of ending it. See docs/agent-failover.md.
 */
export class StartupWindow {
  #closed = false;
  #failure: Error | null = null;
  #timer: NodeJS.Timeout | null = null;
  readonly #capMs: number;
  #resolveSettled!: () => void;
  #rejectSettled!: (error: Error) => void;
  #rejectFailed!: (error: Error) => void;

  /** Resolves when the window closes, rejects with the failure. */
  readonly settled: Promise<void>;
  /** Rejects with the failure and never resolves, to race a step that could hang on a dead session. */
  readonly failed: Promise<never>;

  constructor(capMs: number = START_WINDOW_MS) {
    this.settled = new Promise<void>((resolve, reject) => {
      this.#resolveSettled = resolve;
      this.#rejectSettled = reject;
    });
    this.failed = new Promise<never>((_, reject) => {
      this.#rejectFailed = reject;
    });
    // Either may never be awaited, and an unobserved rejection would be reported as unhandled.
    this.settled.catch(() => {});
    this.failed.catch(() => {});
    this.#capMs = capMs;
  }

  /** Starts the cap. Until then the window stays open. */
  beginCountdown(): void {
    if (this.#timer || !this.open) return;
    this.#timer = setTimeout(() => this.close(), this.#capMs);
    this.#timer.unref?.();
  }

  get open(): boolean {
    return !this.#closed && this.#failure === null;
  }

  get failure(): Error | null {
    return this.#failure;
  }

  /** Records a start failure. Returns false, and records nothing, once the window is not open. */
  fail(error: Error): boolean {
    if (!this.open) return false;
    this.#failure = error;
    this.#clearTimer();
    this.#rejectSettled(error);
    this.#rejectFailed(error);
    return true;
  }

  /** The agent has spoken, the cap has passed, or the call is committed elsewhere. */
  close(): void {
    if (!this.open) return;
    this.#closed = true;
    this.#clearTimer();
    this.#resolveSettled();
  }

  throwIfFailed(): void {
    if (this.#failure) throw this.#failure;
  }

  #clearTimer(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}

/** The error behind a session Error event, or null when the SDK marked it recoverable. */
export function startFailureFromError(ev: voice.ErrorEvent): Error | null {
  const err = ev?.error as { recoverable?: boolean; error?: unknown; message?: string } | undefined;
  if (err?.recoverable === true) return null;
  if (err?.error instanceof Error) return err.error;
  if (err instanceof Error) return err;
  return new Error(err?.message || "agent session error during start-up");
}

/**
 * Feeds a session's events into its attempt's window: an unrecoverable error or
 * an SDK close with reason "error" fails it, and the agent's first speech closes it.
 * Returns a function that detaches the listeners.
 */
export function watchStartup(session: voice.AgentSession, window: StartupWindow): () => void {
  const onError = (ev: voice.ErrorEvent) => {
    const error = startFailureFromError(ev);
    if (error) window.fail(error);
  };
  const onClose = (ev: voice.CloseEvent) => {
    if (ev.reason !== voice.CloseReason.ERROR) return;
    const inner = (ev.error as { error?: unknown } | null)?.error;
    window.fail(
      inner instanceof Error ? inner : new Error("agent session closed with an error during start-up"),
    );
  };
  const onState = (ev: voice.AgentStateChangedEvent) => {
    if (ev.newState === "speaking") window.close();
  };
  session.on(voice.AgentSessionEventTypes.Error, onError);
  session.on(voice.AgentSessionEventTypes.Close, onClose);
  session.on(voice.AgentSessionEventTypes.AgentStateChanged, onState);
  return () => {
    session.off(voice.AgentSessionEventTypes.Error, onError);
    session.off(voice.AgentSessionEventTypes.Close, onClose);
    session.off(voice.AgentSessionEventTypes.AgentStateChanged, onState);
  };
}
