import dns from "node:dns";
import net from "node:net";

/**
 * Process-wide outbound connection defaults. Applied as an import side effect so they
 * are in place before anything opens a socket; `realtime.ts` imports this first.
 *
 * ## Why
 *
 * Node ≥20 enables happy-eyeballs (`autoSelectFamily`) with an
 * `autoSelectFamilyAttemptTimeout` of **250 ms**. It resolves a hostname to every
 * address and walks them, giving each 250 ms to connect before moving on; when the
 * list is exhausted it throws `AggregateError [ETIMEDOUT]`, surfacing as
 * `TypeError: fetch failed`.
 *
 * The agent runner resolves the platform API to both an A and an AAAA record, but the
 * VM has **no IPv6 route** — a v6 connect returns `ENETUNREACH` in ~1 ms. So every
 * request walks a two-address list of which one is dead on arrival, leaving the IPv4
 * attempt a 250 ms budget. IPv4 normally connects in ~2 ms, which is why this almost
 * always works; but a SYN occasionally taking longer than 250 ms — entirely plausible
 * on a box that logs "worker is at full capacity" under eval load — exhausts the list
 * and fails the request outright, before it ever reaches the server. Observed on
 * staging as a consult-leg `POST /api/agent-db/call` failing in ~300 ms with no
 * corresponding Cloud Run request log, which aborted the whole warm transfer, and
 * separately on `POST /api/agent-db/transaction-log`: it is not endpoint-specific.
 *
 * ## What
 *
 * 1. `ipv4first` DNS ordering, so the address that actually works is tried first and
 *    the doomed IPv6 attempt never delays anything.
 * 2. A 5 s per-address budget instead of 250 ms, so a slow SYN degrades into a slow
 *    request rather than a hard failure.
 *
 * NB happy-eyeballs is deliberately left ENABLED. Disabling it
 * (`--no-network-family-autoselection`) would drop back to a single address and make
 * (2) inert — the attempt timeout only governs the multi-address walk — and would turn
 * any future IPv4 problem into an immediate hard failure instead of a v6 fallback.
 * Ordering achieves the "don't wait on IPv6" goal without giving up the fallback.
 *
 * Both settings are module-level defaults that `net.connect` reads when a caller does
 * not pass the option, and Node's built-in `fetch` does not pass either — the observed
 * failure stack runs `fetch` → `node:net` `internalConnectMultipleTimeout`, i.e. the
 * same code path that consults these defaults.
 */
export const OUTBOUND_DNS_RESULT_ORDER = "ipv4first" as const;

/**
 * Per-address connect budget. Chosen to prefer a slow worker over a hard fail; well
 * inside undici's own ~10 s connect timeout, which remains the real backstop.
 */
export const OUTBOUND_CONNECT_ATTEMPT_TIMEOUT_MS = 5_000;

dns.setDefaultResultOrder(OUTBOUND_DNS_RESULT_ORDER);
net.setDefaultAutoSelectFamilyAttemptTimeout(OUTBOUND_CONNECT_ATTEMPT_TIMEOUT_MS);

/** The defaults actually in force, for logging at startup. */
export function outboundNetworkDefaults(): {
  dnsResultOrder: string;
  autoSelectFamily: boolean;
  autoSelectFamilyAttemptTimeoutMs: number;
} {
  return {
    dnsResultOrder: OUTBOUND_DNS_RESULT_ORDER,
    autoSelectFamily: net.getDefaultAutoSelectFamily(),
    autoSelectFamilyAttemptTimeoutMs:
      net.getDefaultAutoSelectFamilyAttemptTimeout(),
  };
}
