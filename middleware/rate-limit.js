import { rateLimit, ipKeyGenerator } from 'express-rate-limit';

// --- client IP behind Cloud Run -------------------------------------------
// Cloud Run terminates the client connection at Google's front-end and records
// the real client as the LEFTMOST X-Forwarded-For entry. We read it directly
// rather than enabling Express `trust proxy` globally (which would also change
// req.protocol / req.secure app-wide and affect better-auth). `ipKeyGenerator`
// normalises IPv6 to a /56 so one client can't trivially rotate within its
// subnet. NB: the leftmost XFF entry is ultimately client-supplied and so
// spoofable — per-IP limits here are a speed-bump against naive abuse, not a
// hard wall. (better-auth applies the same first-XFF logic for /api/auth/*.)
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  const first = typeof xff === 'string' ? xff.split(',')[0].trim() : '';
  return first || req.ip || req.socket?.remoteAddress || 'unknown';
}
const perIp = (req) => ipKeyGenerator(clientIp(req));

const common = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS', // never spend budget on CORS preflight
  // These limiters key on the XFF client IP (or a constant), never req.ip, so
  // the proxy / X-Forwarded-For validations don't apply.
  validate: { trustProxy: false, xForwardedForHeader: false },
};

/**
 * POST /api/users/signup — blanket (GLOBAL) cap: 60 requests / 60 minutes across
 * ALL clients combined. Deliberately a single shared bucket (not per-IP): can't
 * be bypassed by IP rotation and needs no proxy config. Trade-off: a burst from
 * one source can exhaust the hour's budget for everyone — acceptable on a costly,
 * abuse-prone path (creates users, sends email).
 *
 * NOTE: in-memory store, so the cap is per process — effective limit is
 * 60 × running-instances under Cloud Run autoscaling. Move to a shared store
 * (e.g. rate-limit-redis) for a hard cluster-wide limit.
 */
export const signupLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60 * 1000, // 60 minutes
  limit: 60,                // shared across all clients
  keyGenerator: () => 'signup', // one bucket for everyone — global, not per-IP
  message: { error: 'Too many sign-up attempts. Please try again later.' },
});

/**
 * /api/hooks/* — unauthenticated webhook receivers (e.g. Ultravox call-end).
 * Per-IP, so legitimate provider traffic (from the provider's own IPs) keeps its
 * own generous budget while an abusive source is capped independently. Sized as a
 * DoS / DB-load guard, NOT a correctness control — the real fix is verifying a
 * shared secret / signature on the webhook (it has no auth today). Tune the limit
 * to real provider call-completion volume.
 */
export const webhookLimiter = rateLimit({
  ...common,
  windowMs: 60 * 1000, // 1 minute
  limit: 300,          // per IP per minute
  keyGenerator: perIp,
  message: { error: 'Too many requests.' },
});

/**
 * /api/rooms/:id/join — single-use instance-token join. Per-IP cap to blunt
 * token brute-forcing (each attempt costs an Instance.findByPk). Mounted ahead
 * of the auth middleware so failed-token floods are shed before the DB lookup.
 */
export const roomJoinLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60 * 1000, // 60 minutes
  limit: 60,                // per IP per hour
  keyGenerator: perIp,
  message: { error: 'Too many requests. Please try again later.' },
});

/**
 * GET /api/oauth-handoff — OAuth → polite-ai session hand-off
 * (lib/auth/oauth-handoff.js). Per-IP: each hit can mint a one-time session
 * token (a DB write) for a browser holding a better-auth session; drive-by
 * loops are pure waste, so cap them. Legit flows use exactly one per sign-in.
 */
export const oauthHandoffLimiter = rateLimit({
  ...common,
  windowMs: 60 * 1000, // 1 minute
  limit: 30,           // per IP per minute — headroom for shared-NAT onboarding
                       // bursts; the endpoint's cost is one indexed DB insert.
  keyGenerator: perIp,
  message: { error: 'Too many requests. Please try again later.' },
});

export default signupLimiter;
