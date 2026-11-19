/**
 * The secret part of a phone's settings address. 130 random bits as 26 base32
 * characters. Only its SHA-256 is stored (`devices.token_hash`).
 */
import { createHash, randomInt } from 'node:crypto';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
export const TOKEN_RE = /^[a-z2-7]{26}$/;
// A phone can sit in its box for a while once a redirect service knows its address.
export const TOKEN_DAYS = 7;
export const TOKEN_DAYS_REDIRECTED = 30;

export const mintToken = () => Array.from({ length: 26 }, () => BASE32[randomInt(32)]).join('');

export const hashToken = (token) => createHash('sha256').update(String(token), 'utf8').digest('hex');

export const tokenExpiry = (days, now = Date.now()) => new Date(now + days * 24 * 60 * 60 * 1000);
