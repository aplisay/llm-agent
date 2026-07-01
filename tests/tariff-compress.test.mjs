import { compressDeck, compressDeckStats } from '../lib/tariff-compress.js';

/**
 * Lossless prefix-deck compression — verified against the ENGINE's own longest-prefix
 * rule (an independent reference oracle, NOT the compressor's trie). The guarantee:
 * for every 6–15 digit number N, value(LPM(N, compressed)) === value(LPM(N, original)).
 * We check that exhaustively on a scaled-down alphabet (total correctness there), by
 * random fuzzing over the real digit domain, and on the exact counterexamples that
 * broke the rejected algorithm variants during design.
 */

const UNCOVERED = 'UNCOVERED';
const valueKey = (r) => (r ? `${r.connectMicros}|${r.peakPerMinuteMicros}|${r.offPeakPerMinuteMicros}|${r.minimumMicros}` : UNCOVERED);

/** Reference LPM — exactly what lib/tariffs.js matchTariffPrefix computes. */
function lpm(number, rows) {
  let best = null;
  for (const r of rows) {
    if (r.prefix && number.startsWith(r.prefix) && (!best || r.prefix.length > best.prefix.length)) best = r;
  }
  return best;
}

// deterministic xorshift32 so any failure reproduces
let _seed = 0x2545f491;
const seed = (s) => { _seed = (s >>> 0) || 1; };
function rnd() {
  _seed ^= _seed << 13; _seed >>>= 0;
  _seed ^= _seed >> 17;
  _seed ^= _seed << 5; _seed >>>= 0;
  return _seed / 0x100000000;
}
const ri = (n) => Math.floor(rnd() * n);

const mk = (prefix, v) => ({ prefix, connectMicros: v, peakPerMinuteMicros: v, offPeakPerMinuteMicros: v, minimumMicros: v, label: `v${v}` });

function randValue(nVals) {
  const v = ri(nVals);
  return { connectMicros: v * 1000, peakPerMinuteMicros: (v % 3) * 2000, offPeakPerMinuteMicros: (v % 2) * 1500, minimumMicros: (v % 4) * 500, label: `v${v}` };
}
function randDeck(alphabet, count, maxLen, nVals) {
  const seen = new Set();
  const rows = [];
  let guard = 0;
  while (rows.length < count && guard++ < count * 50) {
    const len = 1 + ri(maxLen);
    let p = '';
    for (let i = 0; i < len; i++) p += alphabet[ri(alphabet.length)];
    if (seen.has(p)) continue;
    seen.add(p);
    rows.push({ prefix: p, ...randValue(nVals) });
  }
  return rows;
}
function* allStrings(alphabet, len) {
  if (len === 0) { yield ''; return; }
  for (const s of allStrings(alphabet, len - 1)) for (const c of alphabet) yield s + c;
}

/** Assert compressed bills identically to original over numbers of length minLen..maxLen. */
function assertEquivalent(deck, alphabet, minLen, maxLen) {
  const compressed = compressDeck(deck);
  expect(compressed.length).toBeLessThanOrEqual(Math.max(deck.length, 10));
  const cseen = new Set();
  for (const r of compressed) {
    expect(r.prefix).toMatch(/^\d{1,15}$/);
    expect(cseen.has(r.prefix)).toBe(false);
    cseen.add(r.prefix);
  }
  // idempotence
  expect(compressDeck(compressed).length).toBe(compressed.length);
  for (let L = minLen; L <= maxLen; L++) {
    for (const n of allStrings(alphabet, L)) {
      if (valueKey(lpm(n, compressed)) !== valueKey(lpm(n, deck))) {
        throw new Error(`LPM mismatch N=${n}: orig=${valueKey(lpm(n, deck))} compressed=${valueKey(lpm(n, compressed))}\n  deck=${deck.map((r) => r.prefix + '=' + valueKey(r)).sort().join(' ')}\n  comp=${compressed.map((r) => r.prefix + '=' + valueKey(r)).sort().join(' ')}`);
      }
    }
  }
  return compressed;
}

describe('tariff-compress (lossless prefix-deck compression)', () => {
  it('exhaustive small-alphabet sweep: bills identically for all in-domain numbers', () => {
    let orig = 0, comp = 0, decks = 0;
    for (let s = 1; s <= 1500; s++) {
      seed(s * 2654435761);
      const deck = randDeck('012', 1 + ri(14), 4, 1 + ri(3));
      orig += deck.length;
      comp += assertEquivalent(deck, '012', 6, 8).length;
      decks++;
    }
    expect(decks).toBe(1500);
    expect(comp).toBeLessThanOrEqual(orig); // never grows overall
  });

  it('random full-digit fuzz: no mispricing over sampled 6–15 digit numbers', () => {
    for (let s = 1; s <= 120; s++) {
      seed(1013904223 ^ (s * 2246822519));
      const deck = randDeck('0123456789', 5 + ri(60), 6, 2 + ri(6));
      const compressed = compressDeck(deck);
      expect(compressed.length).toBeLessThanOrEqual(deck.length);
      for (let t = 0; t < 2000; t++) {
        const L = 6 + ri(10);
        let n = '';
        for (let i = 0; i < L; i++) n += '0123456789'[ri(10)];
        expect(valueKey(lpm(n, compressed))).toBe(valueKey(lpm(n, deck)));
      }
    }
  });

  it('hole-punches a redundant longer prefix', () => {
    const out = assertEquivalent([mk('44', 1), mk('447', 2), mk('4470', 2), mk('4471', 2)], '0123456789', 6, 6);
    expect(out.length).toBe(2);
  });

  it('aggregates all-ten same-rate siblings up to their absent parent', () => {
    const deck = [mk('44', 1), ...Array.from({ length: 10 }, (_, d) => mk('447' + d, 2))];
    const out = assertEquivalent(deck, '0123456789', 6, 6);
    expect(out.length).toBe(2);
  });

  it('finds a deep aggregation (F2): 100 leaves + 2 overrides → 3 rows', () => {
    const deck = [];
    for (let x = 0; x < 10; x++) for (let y = 0; y < 10; y++) deck.push(mk('4444' + x + y, 1));
    for (const r of deck) if (r.prefix === '444400') Object.assign(r, mk('444400', 2));
    for (const r of deck) if (r.prefix === '444410') Object.assign(r, mk('444410', 9));
    const out = assertEquivalent(deck, '0123456789', 6, 6);
    expect(out.length).toBe(3);
  });

  it('ADVERSARY: a gap must not fabricate coverage (001xxx stays UNCOVERED)', () => {
    const deck = [mk('000', 3), mk('1', 3)];
    const c = compressDeck(deck);
    expect(valueKey(lpm('001000', c))).toBe(UNCOVERED);
    expect(valueKey(lpm('000111', c))).toBe('3|3|3|3');
    expect(valueKey(lpm('100000', c))).toBe('3|3|3|3');
    expect(valueKey(lpm('222222', c))).toBe(UNCOVERED);
    assertEquivalent(deck, '0123456789', 6, 6);
  });

  it('ADVERSARY: nine same-rate children with a missing 10th do not aggregate over the gap', () => {
    const deck = [mk('44', 1), ...Array.from({ length: 9 }, (_, d) => mk('447' + d, 2))];
    const c = compressDeck(deck);
    expect(valueKey(lpm('447000', c))).toBe('2|2|2|2');
    expect(valueKey(lpm('447900', c))).toBe('1|1|1|1'); // falls back to the parent default
    expect(valueKey(lpm('448000', c))).toBe('1|1|1|1');
    assertEquivalent(deck, '0123456789', 6, 6);
  });

  it('ADVERSARY: nine children, no parent → the gap region stays UNCOVERED', () => {
    const deck = Array.from({ length: 9 }, (_, d) => mk('447' + d, 8));
    const c = compressDeck(deck);
    expect(valueKey(lpm('447000', c))).toBe('8|8|8|8');
    expect(valueKey(lpm('447900', c))).toBe(UNCOVERED);
    expect(valueKey(lpm('448000', c))).toBe(UNCOVERED);
    assertEquivalent(deck, '0123456789', 6, 6);
  });

  it('preserves a matched all-zero (free) rate as distinct from UNCOVERED', () => {
    const deck = [{ prefix: '44', connectMicros: 0, peakPerMinuteMicros: 0, offPeakPerMinuteMicros: 0, minimumMicros: 0, label: 'free' }];
    const c = compressDeck(deck);
    expect(valueKey(lpm('447777', c))).toBe('0|0|0|0'); // matched, free
    expect(valueKey(lpm('337777', c))).toBe(UNCOVERED); // unmatched
  });

  it('whole-space-uniform tariff surfaces as ten length-1 rows', () => {
    // Every first digit 0..9 covered with the same rate at depth 1 -> uniform.
    const deck = Array.from({ length: 10 }, (_, d) => mk(String(d), 5));
    const out = compressDeck(deck);
    expect(out.length).toBe(10);
    for (let d = 0; d < 10; d++) expect(valueKey(lpm(`${d}00000`, out))).toBe('5|5|5|5');
  });

  it('reports before/after counts and is a no-op on empty', () => {
    expect(compressDeckStats([]).after).toBe(0);
    const s = compressDeckStats([mk('44', 1), mk('447', 1)]);
    expect(s.before).toBe(2);
    expect(s.after).toBe(1); // 447 is redundant with 44
    expect(s.skipped).toBe(false);
  });

  it('rejects an illegal or duplicate prefix rather than mis-billing', () => {
    expect(() => compressDeck([{ prefix: '4a', connectMicros: 1, peakPerMinuteMicros: 1, offPeakPerMinuteMicros: 1, minimumMicros: 1 }])).toThrow(/illegal prefix/);
    expect(() => compressDeck([mk('44', 1), mk('44', 2)])).toThrow(/duplicate prefix/);
  });
});
