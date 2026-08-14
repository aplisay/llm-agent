// Sender personas for the auth emails (lib/auth/email-brands.js). Two things
// are load-bearing: a persona is an INDEX, never an address (so a forged
// x-email-brand cannot invent a sender), and every misconfiguration degrades to
// the built-in copy instead of throwing at boot.
import { loadBrands, resolveBrand, composeMessage, render } from '../lib/auth/email-brands.js';

const POLITE = {
  from: 'hello@polite.ai',
  fromName: 'polite.ai',
  productName: 'polite.ai',
  tagline: 'Communication, reimagined.',
};

const table = (doc) => loadBrands({ EMAIL_BRANDS: JSON.stringify(doc) }, { logger: quietLogger() });

function quietLogger() {
  const errors = [];
  return { info: () => {}, error: (...a) => errors.push(a), errors };
}

describe('loadBrands', () => {
  it('is empty when nothing is configured', () => {
    expect(loadBrands({}, { logger: quietLogger() })).toEqual({ defaultKey: null, brands: {} });
  });

  it('parses the inline JSON document', () => {
    const t = table({ default: 'aplisay', brands: { aplisay: { from: 'hello@aplisay.com' }, 'polite-ai': POLITE } });
    expect(t.defaultKey).toBe('aplisay');
    expect(Object.keys(t.brands).sort()).toEqual(['aplisay', 'polite-ai']);
    expect(t.brands['polite-ai'].tagline).toBe('Communication, reimagined.');
  });

  it('reads the file form in preference to the inline form', () => {
    const readFile = () => JSON.stringify({ brands: { fromfile: { from: 'a@b.com' } } });
    const t = loadBrands(
      { EMAIL_BRANDS_FILE: '/etc/brands.json', EMAIL_BRANDS: JSON.stringify({ brands: { inline: { from: 'c@d.com' } } }) },
      { logger: quietLogger(), readFile },
    );
    expect(Object.keys(t.brands)).toEqual(['fromfile']);
  });

  it('DEGRADES to the built-ins (never throws) on bad JSON, a missing file, or no brands object', () => {
    const logger = quietLogger();
    expect(loadBrands({ EMAIL_BRANDS: '{not json' }, { logger })).toEqual({ defaultKey: null, brands: {} });
    expect(loadBrands({ EMAIL_BRANDS: '{"nope":1}' }, { logger })).toEqual({ defaultKey: null, brands: {} });
    const readFile = () => { throw new Error('ENOENT'); };
    expect(loadBrands({ EMAIL_BRANDS_FILE: '/nope.json' }, { logger, readFile })).toEqual({ defaultKey: null, brands: {} });
    expect(logger.errors).toHaveLength(3);
  });

  it('drops a persona with no from address, and an unknown default', () => {
    const t = table({ default: 'ghost', brands: { broken: { productName: 'X' }, ok: { from: 'a@b.com' } } });
    expect(Object.keys(t.brands)).toEqual(['ok']);
    expect(t.defaultKey).toBeNull();
  });

  it('drops a half-written template but keeps the persona', () => {
    const t = table({ brands: { x: { from: 'a@b.com', templates: { verification: { subject: 'Hi' } } } } });
    expect(t.brands.x.templates).toEqual({});
  });
});

describe('resolveBrand', () => {
  const t = table({ default: 'aplisay', brands: { aplisay: { from: 'hello@aplisay.com' }, 'polite-ai': POLITE } });

  it('resolves a named persona', () => {
    expect(resolveBrand(t, 'polite-ai').from).toBe('hello@polite.ai');
  });

  it('falls back to the default for an absent or FORGED key — never to an arbitrary sender', () => {
    expect(resolveBrand(t, undefined).from).toBe('hello@aplisay.com');
    expect(resolveBrand(t, 'evil@attacker.example').from).toBe('hello@aplisay.com');
    expect(resolveBrand(t, '../../etc/passwd').from).toBe('hello@aplisay.com');
  });

  it('returns null (client default sender, built-in copy) when nothing is configured', () => {
    expect(resolveBrand({ defaultKey: null, brands: {} }, 'polite-ai')).toBeNull();
  });
});

describe('render', () => {
  it('substitutes whitelisted vars and DROPS everything else', () => {
    expect(render('{{url}} {{productName}} {{secret}} {{ tagline }}', {
      url: 'https://x/v', productName: 'p', tagline: 't',
    })).toBe('https://x/v p  t');
  });
});

describe('composeMessage', () => {
  const t = table({ default: 'aplisay', brands: { aplisay: { from: 'hello@aplisay.com' }, 'polite-ai': POLITE } });

  it('names the product and signs off with the tagline for a full persona', () => {
    const msg = composeMessage({ brand: resolveBrand(t, 'polite-ai'), kind: 'verification', to: 'a@b.com', url: 'https://x/v' });
    expect(msg.from).toEqual({ email: 'hello@polite.ai', name: 'polite.ai' });
    expect(msg.subject).toBe('Confirm your polite.ai email address');
    expect(msg.text).toContain('polite.ai account');
    expect(msg.text).toContain('https://x/v');
    expect(msg.text.trim().endsWith('— polite.ai · Communication, reimagined.')).toBe(true);
    // Account-address confirmation, NOT a newsletter double opt-in: the old
    // hard-coded copy called it a "subscription" the reader had "registered
    // interest" in, which is a different audience entirely.
    expect(msg.text.toLowerCase()).not.toContain('subscription');
    expect(msg.text.toLowerCase()).not.toContain('registering your interest');
  });

  it('reads as clean English for an address-only persona (no product name, no dangling separator)', () => {
    const msg = composeMessage({ brand: resolveBrand(t, 'aplisay'), kind: 'reset-password', to: 'a@b.com', url: 'https://x/r' });
    expect(msg.from).toEqual({ email: 'hello@aplisay.com' });
    expect(msg.subject).toBe('Set your password');
    expect(msg.text).not.toMatch(/ {2}|·/);
  });

  it('omits `from` entirely with no persona, leaving the email client default in charge', () => {
    const msg = composeMessage({ brand: null, kind: 'verification', to: 'a@b.com', url: 'https://x/v' });
    expect(msg.from).toBeUndefined();
    expect(msg.subject).toBe('Confirm your email address');
  });

  it('lets a persona override the copy outright', () => {
    const custom = table({
      brands: {
        x: {
          from: 'a@b.com',
          productName: 'Widget',
          templates: { verification: { subject: 'Verify for {{productName}}', text: 'Go to {{url}} now' } },
        },
      },
    });
    const msg = composeMessage({ brand: resolveBrand(custom, 'x'), kind: 'verification', to: 'a@b.com', url: 'https://x/v' });
    expect(msg.subject).toBe('Verify for Widget');
    expect(msg.text).toBe('Go to https://x/v now');
  });
});
