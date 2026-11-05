// Shared Stripe client. Set these in Vercel → Settings → Environment Variables
// (mark them "Sensitive"), never in code:
//   STRIPE_SECRET_KEY      restricted key (rk_test_… in the sandbox, rk_live_… later)
//   STRIPE_WEBHOOK_SECRET  whsec_… from the webhook endpoint in Workbench
//   STRIPE_PRICE_ID        price_… for CartCompare Pro ($14/month)

import Stripe from 'stripe';

export const STRIPE_API_VERSION = '2026-10-28.endive';

export const stripeConfigured = Boolean(
  process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID
);

export const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION })
  : null;

// Subscription statuses that count as "Pro". past_due keeps access while
// Stripe's Smart Retries try the card again.
export const PRO_STATUSES = new Set(['active', 'trialing', 'past_due']);

// The site's own address, for Checkout and portal return links.
export function siteUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `https://${host}`;
}
