// POST /api/account?action=login  { email, password }
// Checks the password against Neon and starts a 30-day session.
// The same error is given for an unknown email and a wrong password.

import { overLimit } from './_redis.js';
import { dbConfigured } from './_db.js';
import { getUser, normalizeEmail, readBody, startSession } from './_auth.js';
import { checkPassword } from './_password.js';
import { moveVisitorReceipts } from './_receipts.js';

const WRONG = { error: "That email and password don't match. Please try again." };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  const body = readBody(req);
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  if (!email || !password || password.length > 200) return res.status(400).json(WRONG);
  if (!dbConfigured) {
    console.error('Accounts are not configured: need DATABASE_URL (connect Neon in Vercel).');
    return res.status(503).json({ error: "Accounts aren't set up yet." });
  }
  if (await overLimit(req, 'login', 20, 15 * 60)) {
    return res.status(429).json({ error: 'Too many tries. Please wait a few minutes.' });
  }

  try {
    const user = await getUser(email);
    if (!user || !(await checkPassword(password, user.password_hash))) return res.status(401).json(WRONG);
    await startSession(res, user.id);
    await moveVisitorReceipts(req, user.email).catch((err) => console.error('Moving receipts failed:', err.message));
    return res.status(200).json({ email: user.email });
  } catch (err) {
    console.error('Log-in failed:', err);
    return res.status(500).json({ error: "We couldn't log you in." });
  }
}
