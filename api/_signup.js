// POST /api/account?action=signup  { email, password }
// Creates an account in Neon and signs the new user in.

import { overLimit } from './_redis.js';
import { db, dbConfigured } from './_db.js';
import { EMAIL_RE, normalizeEmail, readBody, startSession } from './_auth.js';
import { MIN_PASSWORD, hashPassword } from './_password.js';
import { moveVisitorReceipts } from './_receipts.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  const body = readBody(req);
  if (body.company) return res.status(400).json({ error: 'Something went wrong.' }); // honeypot

  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (password.length < MIN_PASSWORD || password.length > 200) {
    return res.status(400).json({ error: `Please choose a password of at least ${MIN_PASSWORD} characters.` });
  }
  if (!dbConfigured) {
    console.error('Accounts are not configured: need DATABASE_URL (connect Neon in Vercel).');
    return res.status(503).json({ error: "Accounts aren't set up yet." });
  }
  if (await overLimit(req, 'signup', 10, 60 * 60)) {
    return res.status(429).json({ error: 'Too many tries. Please wait a while.' });
  }

  try {
    const sql = await db();
    const hash = await hashPassword(password);
    const rows = await sql`INSERT INTO users (email, password_hash) VALUES (${email}, ${hash})
                           ON CONFLICT (email) DO NOTHING RETURNING id`;
    if (!rows.length) {
      return res.status(409).json({ error: 'There is already an account with that email. Please log in.' });
    }
    await startSession(res, rows[0].id);
    await moveVisitorReceipts(req, email).catch((err) => console.error('Moving receipts failed:', err.message));
    return res.status(200).json({ email });
  } catch (err) {
    console.error('Sign-up failed:', err);
    return res.status(500).json({ error: "We couldn't create your account." });
  }
}
