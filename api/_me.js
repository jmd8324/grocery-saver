// GET /api/account?action=me — who is logged in and whether they have Pro.

import { currentUser, isProUser } from './_auth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await currentUser(req);
    if (!user) return res.status(200).json({ signedIn: false });
    return res.status(200).json({
      signedIn: true,
      email: user.email,
      pro: isProUser(user),
      status: user.free_pro ? 'free' : user.pro_status,
      demo: user.is_demo,
      hasBilling: Boolean(user.stripe_customer),
    });
  } catch (err) {
    console.error('Failed to load account:', err);
    return res.status(500).json({ error: "We couldn't load your account." });
  }
}
