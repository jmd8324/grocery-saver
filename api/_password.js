// Password scrambling with scrypt (built into Node, no extra package).
// Stored as "scrypt$<salt>$<hash>", so a database leak doesn't reveal passwords.

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const KEYLEN = 64;

export const MIN_PASSWORD = 8;

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('base64url');
  const hash = await scrypt(String(password), salt, KEYLEN);
  return `scrypt$${salt}$${hash.toString('base64url')}`;
}

export async function checkPassword(password, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64url');
  const got = await scrypt(String(password), salt, want.length);
  return want.length === got.length && timingSafeEqual(want, got);
}
