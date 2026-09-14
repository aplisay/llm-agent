import dns from "node:dns";
import net from "node:net";

/**
 * Apply IPv4-first ordering and a longer per-address timeout before opening sockets; keep family autoselection
 * enabled. The timeout only applies to the multi-address connection path; see PR #189.
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
