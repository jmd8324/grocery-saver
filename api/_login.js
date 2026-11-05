// POST /api/account?action=login  { email }
// Emails a one-time sign-in link. Uses Resend (https://resend.com):
//   RESEND_API_KEY  re_…
//   EMAIL_FROM      e.g. "CartCompare <signin@yourdomain.com>"
// Always answers the same way whether or not the email is known, so the form
// can't be used to discover who has an account.

import { redis, redisConfigured, overLimit } from './_redis.js';
import { EMAIL_RE, LOGIN_SECONDS, newToken, readBody, sha256 } from './_auth.js';
import { siteUrl } from './_stripe.js';

const SENT = { message: 'Check your email for a sign-in link. It works for 15 minutes.' };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const body = readBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  if (body.company) return res.status(200).json(SENT); // honeypot

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (!redisConfigured || !process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    console.error('Sign-in is not configured: need Redis, RESEND_API_KEY and EMAIL_FROM.');
    return res.status(503).json({ error: "Sign-in isn't set up yet." });
  }
  if (await overLimit(req, 'login', 5, 15 * 60)) {
    return res.status(429).json({ error: 'Too many tries. Please wait a few minutes.' });
  }

  try {
    const token = newToken();
    await redis(['SET', `login:${sha256(token)}`, email, 'EX', LOGIN_SECONDS]);
    const link = `${siteUrl(req)}/pro.html?token=${token}`;

    const sent = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to: email,
        subject: 'Your CartCompare sign-in link',
        text: `Sign in to CartCompare:\n\n${link}\n\nThe link works once, for 15 minutes. If you didn't ask for this, you can ignore this email.`,
        html: `<p>Sign in to CartCompare:</p><p><a href="${link}">Sign in</a></p><p>The link works once, for 15 minutes. If you didn't ask for this, you can ignore this email.</p>`,
      }),
    });
    if (!sent.ok) throw new Error(`Resend ${sent.status}: ${await sent.text()}`);
    return res.status(200).json(SENT);
  } catch (err) {
    console.error('Failed to send sign-in email:', err);
    return res.status(500).json({ error: "We couldn't send the email." });
  }
}
