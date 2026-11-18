/**
 * The settings file of a Snom desk phone. Pure: the same profile always gives
 * the same file, so tests/fixtures/provisioning holds golden files.
 *
 * One SIP identity for each line. An identity carries the digest hash
 * (`user_hash`) with `user_pass` empty, so the file never holds a password.
 */

const escapeXml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  // Control characters are not allowed in XML 1.0.
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

// perm="R": the user cannot change it on the phone.
const setting = (name, value, { idx, perm = 'R' } = {}) =>
  `    <${name}${idx ? ` idx="${idx}"` : ''} perm="${perm}">${escapeXml(value)}</${name}>`;

// An identity with no line is switched off and emptied, so a removed line leaves the phone.
const IDENTITY_CLEARED = ['user_realname', 'user_name', 'user_pname', 'user_hash', 'user_pass', 'user_host', 'user_outbound'];

/**
 * @param {object} profile
 * @param {string} profile.settingServer   the phone's own settings address, with `{mac}` left for the phone to fill
 * @param {number} profile.identities      how many SIP identities the model has
 * @param {'d7'|'d8'} [profile.family]     D8xx names its web login settings differently
 * @param {string} profile.adminPassword   the phone's own admin and web password
 * @param {Array<{ key: number, label: string, username: string, ha1: string, registrar: string, port: number }>} profile.lines
 * @returns {string} the XML document
 */
export function renderSnomSettings(profile) {
  const lines = [...profile.lines].sort((a, b) => a.key - b.key);
  const out = ['<?xml version="1.0" encoding="utf-8"?>', '<settings>', '  <phone-settings e="2">'];
  out.push(
    setting('setting_server', profile.settingServer),
    setting('update_policy', 'settings_only'),
    setting('settings_refresh_timer', 86400),
    setting('challenge_checksync', 'on'),
    setting('webserver_type', 'https'),
    setting('use_hidden_tags', 'on'),
    setting('admin_mode_password', profile.adminPassword),
  );
  if (profile.family === 'd8') {
    out.push(setting('webserver_admin_name', 'admin'), setting('webserver_admin_password', profile.adminPassword));
  } else {
    out.push(setting('http_user', 'admin'), setting('http_pass', profile.adminPassword));
  }
  lines.forEach((line, i) => {
    const idx = i + 1;
    out.push(
      setting('user_active', 'on', { idx }),
      setting('user_realname', String(line.label).slice(0, 50), { idx }),
      setting('user_name', line.username, { idx }),
      setting('user_pname', line.username, { idx }),
      setting('user_hash', line.ha1, { idx }),
      setting('user_pass', '', { idx }),
      setting('user_host', line.registrar, { idx }),
      setting('user_outbound', `${line.registrar}:${line.port};transport=tls`, { idx }),
      setting('user_server_type', 'default', { idx }),
      setting('user_expiry', 300, { idx }),
      setting('user_srtp', 'on', { idx }),
      setting('user_savp', 'mandatory', { idx }),
      setting('user_symmetrical_rtp', 'on', { idx }),
      setting('user_dtmf_info', 'off', { idx }),
      setting('keepalive_interval', 30, { idx }),
    );
  });
  for (let idx = lines.length + 1; idx <= profile.identities; idx += 1) {
    out.push(setting('user_active', 'off', { idx }), ...IDENTITY_CLEARED.map((name) => setting(name, '', { idx })));
  }
  out.push('  </phone-settings>', '  <functionKeys e="2">');
  // Key N on the phone is fkey idx N-1. `context` is the identity the key belongs to.
  lines.forEach((line, i) => {
    out.push(`    <fkey idx="${line.key - 1}" context="${i + 1}" label="${escapeXml(line.label)}" perm="R">line</fkey>`);
  });
  out.push('  </functionKeys>', '</settings>', '');
  return out.join('\n');
}

/**
 * The model and firmware a Snom phone names in its User-Agent, for example
 * `Mozilla/4.0 (compatible; snomD785-SIP 10.1.184.14 ...)`. Null when it is not one.
 */
export function parseSnomUserAgent(userAgent) {
  const match = /\bsnom([A-Za-z]?\d{3}[A-Za-z]?)-SIP\s+(\d+(?:\.\d+){1,3})/.exec(String(userAgent ?? ''));
  return match ? { model: match[1], firmware: match[2] } : null;
}
