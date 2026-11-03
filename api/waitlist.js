// Vercel serverless function: POST /api/waitlist
// Saves waitlist emails to Upstash Redis in a sorted set called "waitlist",
// scored by signup time, so duplicates are ignored and signup order is kept.

import { redis, redisConfigured } from './_redis.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const email = String(body.email || '').trim().toLowerCase();

  // Honeypot field filled in → almost certainly a bot. Pretend it worked.
  if (body.company) {
    return res.status(200).json({ message: "You're on the list! 🎉" });
  }

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  if (!redisConfigured) {
    console.error('Waitlist storage is not configured: missing Redis environment variables.');
    return res.status(500).json({ error: "The waitlist isn't set up yet." });
  }

  try {
    const added = await redis(['ZADD', 'waitlist', 'NX', Date.now(), email]);
    return res.status(200).json({
      message: added === 1 ? "You're on the list! 🎉" : "You're already on the list — we'll be in touch!",
    });
  } catch (err) {
    console.error('Failed to save waitlist email:', err);
    return res.status(500).json({ error: "We couldn't save your email." });
  }
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return {}; }
}
