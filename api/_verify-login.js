// POST /api/account?action=verify  { token }
// Trades a one-time emailed token for a 30-day session cookie.
// This is a POST from a button on pro.html, not a plain link click, so email
// scanners that pre-open links can't use up the token.

import { redis, redisConfigured } from './_redis.js';
import { readBody, sha256, startSession } from './_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (!redisConfigured) return res.status(503).json({ error: "Sign-in isn't set up yet." });

  const token = String(readBody(req).token || '');
  if (!token || token.length > 100) {
    return res.status(400).json({ error: 'That sign-in link is not valid.' });
  }

  try {
    const key = `login:${sha256(token)}`;
    const email = await redis(['GET', key]);
    if (!email) {
      return res.status(400).json({ error: 'That sign-in link has expired or was already used.' });
    }
    await redis(['DEL', key]);
    await startSession(res, email);
    return res.status(200).json({ email });
  } catch (err) {
    console.error('Sign-in failed:', err);
    return res.status(500).json({ error: "We couldn't sign you in." });
  }
}
