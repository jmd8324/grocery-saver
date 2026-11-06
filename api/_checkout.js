// POST /api/account?action=checkout — starts a Stripe-hosted Checkout for CartCompare Pro.
// Returns { url } for the browser to go to. Pro is switched on by the
// webhook (api/stripe-webhook.js), not by coming back from this page.

import { db } from './_db.js';
import { isProUser, requireUser } from './_auth.js';
import { siteUrl, stripe, stripeConfigured } from './_stripe.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (!stripeConfigured) {
    console.error('Checkout is not configured: need STRIPE_SECRET_KEY and STRIPE_PRICE_ID.');
    return res.status(503).json({ error: "Upgrading isn't set up yet." });
  }

  const user = await requireUser(req, res);
  if (!user) return;

  try {
    if (isProUser(user)) {
      return res.status(409).json({ error: "You're already on Pro." });
    }

    // One Stripe Customer per CartCompare user, created on first upgrade.
    let customer = user.stripe_customer;
    if (!customer) {
      const created = await stripe.customers.create({ email: user.email, metadata: { user_id: String(user.id) } });
      customer = created.id;
      const sql = await db();
      await sql`UPDATE users SET stripe_customer = ${customer} WHERE id = ${user.id}`;
    }

    const base = siteUrl(req);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      // No payment_method_types: Stripe picks the best methods from Dashboard settings.
      success_url: `${base}/pro.html?checkout=success`,
      cancel_url: `${base}/pro.html?checkout=cancelled`,
      integration_identifier: 'cartcompare_pro_qkvmtrzw',
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Failed to start checkout:', err);
    return res.status(500).json({ error: "We couldn't start checkout." });
  }
}
