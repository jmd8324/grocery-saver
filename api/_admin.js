// Password check for owner-only tools (the price update page).
// Set ADMIN_PASSWORD in Vercel → Settings → Environment Variables.

import { timingSafeEqual } from 'node:crypto';

export function isAdmin(req) {
  const expected = process.env.ADMIN_PASSWORD;
  const given = String(req.headers['x-admin-password'] || '');
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Sends the right error and returns false if the caller isn't allowed.
export function requireAdmin(req, res) {
  if (!process.env.ADMIN_PASSWORD) {
    res.status(503).json({ error: "The price tools aren't set up yet: add ADMIN_PASSWORD in Vercel." });
    return false;
  }
  if (!isAdmin(req)) {
    res.status(401).json({ error: 'Wrong password.' });
    return false;
  }
  return true;
}
