// POST /api/portal — opens Stripe's Customer Portal, where subscribers cancel,
// update their card or see invoices. Returns { url }.

import { getUser, requireUser } from './_auth.js';
import { siteUrl, stripe, stripeConfigured } from './_stripe.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (!stripeConfigured) return res.status(503).json({ error: "Billing isn't set up yet." });

  const email = await requireUser(req, res);
  if (!email) return;

  try {
    const { stripe_customer: customer } = await getUser(email);
    if (!customer) return res.status(404).json({ error: "You don't have a subscription yet." });

    const session = await stripe.billingPortal.sessions.create({
      customer,
      return_url: `${siteUrl(req)}/pro.html`,
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Failed to open billing portal:', err);
    return res.status(500).json({ error: "We couldn't open billing." });
  }
}
