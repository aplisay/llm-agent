#!/usr/bin/env node
/**
 * Makes a SECRETENV_BUNDLE that holds only the named variables of an env file.
 * bundle-secretenv.sh --only runs it. The key comes from SECRETENV_KEY.
 *
 *   SECRETENV_KEY=... node secretenv-subset.cjs <env file> <names>
 *
 * <names> is a comma-separated list. A name ending in _* takes every variable
 * with that prefix: at least two characters, then an underscore, as in
 * POSTGRES_*. SECRETENV_KEY and SECRETENV_BUNDLE are never bundled. The bundle
 * goes to stdout. Only names go to stderr, never a value.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');

// A whole name, or a family of names: two characters or more, an underscore, then *.
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]+_\*$/;
// The pair a bundle is delivered as. A bundle that held them would replace them at decrypt time.
const NEVER = ['SECRETENV_KEY', 'SECRETENV_BUNDLE'];

/** The variables of `parsed` that a pattern in `patterns` names. */
function pick(parsed, patterns) {
  const picked = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (NEVER.includes(name)) continue;
    if (patterns.some((pattern) => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern))) {
      picked[name] = value;
    }
  }
  return picked;
}

// The same steps as the secretenv package (installed here as `dotenv`), which decrypts the bundle at start.
const keyOf = (secret) => crypto.createHmac('sha256', 'secretenv').update(secret).digest();

function encrypt(values, secret) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', keyOf(secret), iv);
  return `${iv.toString('hex')}:${Buffer.concat([cipher.update(JSON.stringify(values)), cipher.final()]).toString('base64')}`;
}

function decrypt(bundle, secret) {
  const [iv, ...rest] = bundle.split(':');
  const decipher = crypto.createDecipheriv('aes-256-cbc', keyOf(secret), Buffer.from(iv, 'hex'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(rest.join(':'), 'base64')), decipher.final()]).toString());
}

function main([file, names]) {
  const fail = (message) => {
    process.stderr.write(`${message}\n`);
    process.exit(1);
  };
  const secret = process.env.SECRETENV_KEY;
  if (!file || !names) fail('usage: SECRETENV_KEY=... secretenv-subset.cjs <env file> <names>');
  if (!secret) fail('SECRETENV_KEY is not set');
  const patterns = names.split(',').map((name) => name.trim()).filter(Boolean);
  const bad = patterns.filter((pattern) => !NAME_RE.test(pattern) && !PREFIX_RE.test(pattern));
  if (bad.length) fail(`not a variable name, or a prefix of two characters or more that ends in _* (as in POSTGRES_*): ${bad.join(', ')}`);
  const own = patterns.filter((pattern) => NEVER.includes(pattern));
  if (own.length) fail(`never bundled: ${own.join(', ')}`);

  // The real dotenv parser, so a quoted or many-line value reads as the server reads it.
  const parsed = require('Odotenv').parse(fs.readFileSync(file));
  const picked = pick(parsed, patterns);
  const found = Object.keys(picked).sort();
  if (!found.length) fail(`none of these is in ${file}: ${patterns.join(', ')}`);
  const missing = patterns.filter((pattern) => !pattern.endsWith('*') && !(pattern in picked));

  const bundle = encrypt(picked, secret);
  if (JSON.stringify(decrypt(bundle, secret)) !== JSON.stringify(picked)) fail('the bundle did not decrypt to what went in');
  process.stderr.write(`bundled (${found.length}): ${found.join(', ')}\n`);
  if (missing.length) process.stderr.write(`not in the file, so not bundled: ${missing.join(', ')}\n`);
  process.stdout.write(`SECRETENV_BUNDLE=${bundle}\n`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { pick, encrypt, decrypt };
