// GET /api/me — who is signed in and whether they have Pro.

import { currentEmail, getUser } from './_auth.js';
import { PRO_STATUSES } from './_stripe.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const email = await currentEmail(req);
    if (!email) return res.status(200).json({ signedIn: false });
    const user = await getUser(email);
    return res.status(200).json({
      signedIn: true,
      email,
      pro: PRO_STATUSES.has(user.pro_status),
      status: user.pro_status || 'none',
      hasBilling: Boolean(user.stripe_customer),
    });
  } catch (err) {
    console.error('Failed to load account:', err);
    return res.status(500).json({ error: "We couldn't load your account." });
  }
}
