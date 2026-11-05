// POST /api/checkout — starts a Stripe-hosted Checkout for CartCompare Pro.
// Returns { url } for the browser to go to. Pro is switched on by the
// webhook (api/stripe-webhook.js), not by coming back from this page.

import { redis } from './_redis.js';
import { getUser, requireUser } from './_auth.js';
import { PRO_STATUSES, siteUrl, stripe, stripeConfigured } from './_stripe.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (!stripeConfigured) {
    console.error('Checkout is not configured: need STRIPE_SECRET_KEY and STRIPE_PRICE_ID.');
    return res.status(503).json({ error: "Upgrading isn't set up yet." });
  }

  const email = await requireUser(req, res);
  if (!email) return;

  try {
    const user = await getUser(email);
    if (PRO_STATUSES.has(user.pro_status)) {
      return res.status(409).json({ error: "You're already on Pro." });
    }

    // One Stripe Customer per CartCompare user, created on first upgrade.
    let customer = user.stripe_customer;
    if (!customer) {
      const created = await stripe.customers.create({ email });
      customer = created.id;
      await redis(['HSET', `user:${email}`, 'stripe_customer', customer]);
      await redis(['SET', `customer:${customer}`, email]);
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
