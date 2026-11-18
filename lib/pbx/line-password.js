/**
 * The secret of a desk phone line account (`phone_registrations`, mode
 * 'registrar', kind 'device'). Only its digest hash is stored. The password
 * exists in memory while the hash is made, and is returned at most once, by
 * the reset.
 */
import { randomInt } from 'node:crypto';
import { registrarHA1, PREVIOUS_HA1_GRACE_MS } from '../database-models/phone-registration.js';

const PASSWORD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const PASSWORD_LENGTH = 32;

export function mintLinePassword() {
  return Array.from({ length: PASSWORD_LENGTH }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]).join('');
}

/** The hash to store for a new line account. The password it was made from is dropped here. */
export function mintLineHash(username, realm) {
  return registrarHA1(username, realm, mintLinePassword());
}

/** Whether this deployment lets an admin reset a line's password and read the new one. Off unless set. */
export function linePasswordResetEnabled(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(String(env.PBX_LINE_PASSWORD_RESET ?? '').trim().toLowerCase());
}

/**
 * Give a line account a new password. Stores its hash, keeps the old hash for
 * the grace time, and returns the password. Nothing can read it again.
 */
export async function resetLinePassword(account, { transaction, now = Date.now() } = {}) {
  const password = mintLinePassword();
  const ha1 = registrarHA1(account.username, account.registrar, password);
  if (account.ha1) {
    account.previousHa1 = account.ha1;
    account.previousHa1Until = new Date(now + PREVIOUS_HA1_GRACE_MS);
  }
  account.ha1 = ha1;
  account.password = '';
  await account.save({ transaction });
  return password;
}
