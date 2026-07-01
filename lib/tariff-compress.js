/**
 * Lossless compression of a destination-tariff prefix deck.
 *
 * Carrier rate sheets (e.g. Magrathea) enumerate one row per destination, but the
 * billing engine only ever does a LONGEST-PREFIX MATCH ({@link matchTariffPrefix}).
 * So most rows are redundant: a longer prefix whose rate equals what its nearest
 * shorter ancestor already yields, or a full block of same-rate siblings expressible
 * by their shared parent. This produces the SMALLEST prefix set that bills IDENTICALLY
 * to the input for every possible call — hole-punching (drop redundant longer prefixes)
 * plus aggregation (collapse same-rate ranges up to a shorter/absent parent).
 *
 * Correctness is defined against the engine's exact rule: a queried number is
 * normalised to 6–15 international digits ({@link normaliseDestination}); the matched
 * row is the one whose `prefix` is the longest leading substring; no match ⇒ no
 * destination charge (UNCOVERED). We guarantee, for EVERY 6–15 digit number N:
 *     value(LPM(N, compressDeck(S))) === value(LPM(N, S))
 * where the billing "value" is the 4-tuple (connect, peak, offPeak, minimum) micros.
 * `label` is cosmetic — a representative label per distinct rate is carried through.
 *
 * This is the AUTHORITATIVE compression: it runs server-side inside the tariff
 * create/replace transaction, so the persisted `TariffPrefix` rows are always minimal
 * regardless of what the client uploaded (the polite-ai editor runs the same algorithm
 * client-side, purely as a preview / to shrink the upload). It is idempotent, so
 * re-compressing an already-minimal deck is a no-op.
 *
 * Algorithm — a length-aware trie DP (adversarially verified for correctness AND
 * minimality). The load-bearing invariant: a node is FORCED (its default pinned to the
 * original value) when it has a GAP (any of the ten digit children absent — a number
 * can slip into the gap) OR sits at depth ≥ 6 (a number can terminate there). Pinning
 * is what stops aggregation leaking a rate into an uncovered gap. A FULL node shallower
 * than 6 is FREE and may host an aggregated default drawn from its whole subtree. The
 * empty prefix is never emitted (illegal, and matches everything).
 *
 * @module lib/tariff-compress
 */

const RADIX = 10;
/** Queried numbers are 6–15 digits, so no in-domain number rests on a node shallower
 * than 6 — those full nodes are billing-free. Kept in lock-step with lib/tariffs.js. */
const MINLEN = 6;
/** Sentinel value key for "no row matches" (a call that gets no destination charge). */
const UNCOVERED = ' ';
/** Backstop: above this row count we skip compression rather than risk an OOM on save. */
export const COMPRESS_CAP = 400_000;

const n0 = (x) => {
  const v = Number(x);
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/** Canonical billing key: two rows are equivalent iff these four micros are equal. */
const canonOf = (r) =>
  `${n0(r.connectMicros)}|${n0(r.peakPerMinuteMicros)}|${n0(r.offPeakPerMinuteMicros)}|${n0(r.minimumMicros)}`;

/** Compress and return the new prefix rows only. */
export function compressDeck(rows) {
  return compressDeckStats(rows).prefixes;
}

/** Compress, returning the new rows plus before/after counts (and skipped=true if capped). */
export function compressDeckStats(rows) {
  const before = Array.isArray(rows) ? rows.length : 0;
  if (!Array.isArray(rows) || rows.length === 0) return { prefixes: rows || [], before, after: before, skipped: false };
  if (rows.length > COMPRESS_CAP) return { prefixes: rows, before, after: before, skipped: true };

  // --- 0. validate + index a representative row (value + first-seen label) per rate ---
  const valueOf = new Map();
  const seen = new Set();
  for (const r of rows) {
    if (!r || typeof r.prefix !== 'string' || !/^\d{1,15}$/.test(r.prefix)) {
      throw new Error(`compressDeck: illegal prefix ${JSON.stringify(r && r.prefix)} (need 1–15 digits)`);
    }
    if (seen.has(r.prefix)) throw new Error(`compressDeck: duplicate prefix ${r.prefix}`);
    seen.add(r.prefix);
    const c = canonOf(r);
    if (!valueOf.has(c)) {
      valueOf.set(c, {
        connectMicros: n0(r.connectMicros),
        peakPerMinuteMicros: n0(r.peakPerMinuteMicros),
        offPeakPerMinuteMicros: n0(r.offPeakPerMinuteMicros),
        minimumMicros: n0(r.minimumMicros),
        label: r.label != null ? r.label : null,
      });
    }
  }
  const mkRow = (prefix, canon) => ({ prefix, ...valueOf.get(canon) });

  // --- 1. build trie ---
  const root = { children: new Map(), depth: 0, effOrig: UNCOVERED };
  for (const r of rows) {
    let node = root;
    for (const ch of r.prefix) {
      let next = node.children.get(ch);
      if (!next) {
        next = { children: new Map(), depth: node.depth + 1, effOrig: UNCOVERED };
        node.children.set(ch, next);
      }
      node = next;
    }
    node.own = canonOf(r);
  }

  // --- 2. annotate effOrig (top-down): the value the ORIGINAL deck bills at each node ---
  const annotate = (node, inh) => {
    node.effOrig = node.own !== undefined ? node.own : inh;
    for (const child of node.children.values()) annotate(child, node.effOrig);
  };
  annotate(root, UNCOVERED);

  // --- 3. subtreeVals (bottom-up): every value an in-domain number under `node` can bill ---
  const subtreeVals = (node) => {
    if (node.subtree) return node.subtree;
    const s = new Set();
    if (node.depth >= MINLEN) s.add(node.effOrig); // a number may terminate exactly here
    if (node.children.size < RADIX) s.add(node.effOrig); // a gap: absent child inherits effOrig
    for (const child of node.children.values()) for (const v of subtreeVals(child)) s.add(v);
    node.subtree = s;
    return s;
  };

  // --- 4. bottom-up DP: fewest emitted rows for `node`'s subtree, given inherited value ---
  const dp = (node, inh) => {
    if (!node.memo) node.memo = new Map();
    const hit = node.memo.get(inh);
    if (hit) return hit;

    const isRoot = node.depth === 0;
    const forced = node.children.size < RADIX || node.depth >= MINLEN;

    let candidates;
    if (isRoot) candidates = [UNCOVERED]; // empty prefix is illegal + matches everything
    else if (forced) candidates = [node.effOrig]; // pinned: a gap or length-exact number reads it
    else {
      const rest = [...subtreeVals(node)].filter((v) => v !== inh).sort();
      candidates = [inh, ...rest]; // `inh` first: prefer emitting nothing on a tie
    }

    let best = null;
    for (const E of candidates) {
      const emitHere = !isRoot && E !== inh;
      // Emitting UNCOVERED is impossible — LPM only ADDS coverage, it can never punch an
      // uncovered hole back into a covered region. So covering a genuine uncovered hole is
      // infeasible (Infinity), which forces the DP to leave such a region open instead of
      // aggregating a rate over it.
      let cost = emitHere ? (E === UNCOVERED ? Infinity : 1) : 0;
      if (cost !== Infinity) {
        for (const child of node.children.values()) {
          cost += dp(child, E).cost;
          if (cost === Infinity) break;
        }
      }
      if (best === null || cost < best.cost) best = { cost, choice: E };
    }
    node.memo.set(inh, best);
    return best;
  };

  // --- 5. whole-space-uniform: length-0 is illegal, so surface a single rate at length 1 ---
  const rootVals = subtreeVals(root);
  if (rootVals.size === 1) {
    const only = [...rootVals][0];
    if (only !== UNCOVERED) {
      const out = [];
      for (let d = 0; d < RADIX; d += 1) out.push(mkRow(String(d), only));
      return { prefixes: out, before, after: out.length, skipped: false };
    }
  }

  // --- 6. DP + emit (follow the chosen defaults top-down) ---
  dp(root, UNCOVERED);
  const out = [];
  const emit = (node, inh, prefix) => {
    const { choice } = node.memo.get(inh) || dp(node, inh);
    if (node.depth > 0 && choice !== inh) {
      if (choice === UNCOVERED) throw new Error('compressDeck: interior UNCOVERED hole (un-representable input)');
      out.push(mkRow(prefix, choice));
    }
    for (const [ch, child] of node.children) emit(child, choice, prefix + ch);
  };
  emit(root, UNCOVERED, '');
  return { prefixes: out, before, after: out.length, skipped: false };
}

export default { compressDeck, compressDeckStats, COMPRESS_CAP };
