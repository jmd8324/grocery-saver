// POST /api/stripe-webhook — Stripe tells us when a subscription starts,
// renews, fails, changes or ends. This is the only place Pro gets switched
// on or off.
//
// Instead of trusting what each event says, every subscription event re-reads
// the customer's subscriptions from Stripe. That makes the handler safe if
// events arrive twice or out of order.
//
// Subscribe the endpoint (Workbench → Webhooks) to exactly these events:
//   checkout.session.completed, checkout.session.async_payment_succeeded,
//   customer.subscription.created, customer.subscription.updated,
//   customer.subscription.deleted, invoice.paid, invoice.payment_failed,
//   charge.refunded, charge.dispute.created, radar.early_fraud_warning.created

import { redis, redisConfigured } from './_redis.js';
import { PRO_STATUSES, stripe } from './_stripe.js';

const SUBSCRIPTION_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]);

const RISK_EVENTS = new Set([
  'charge.refunded',
  'charge.dispute.created',
  'radar.early_fraud_warning.created',
]);

// Status ranking for a customer with more than one subscription.
const RANK = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused', 'canceled', 'incomplete_expired'];

const rank = (status) => (RANK.includes(status) ? RANK.indexOf(status) : RANK.length);

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

async function syncCustomer(customerId) {
  const email = await redis(['GET', `customer:${customerId}`]);
  if (!email) {
    console.warn(`Webhook for unknown customer ${customerId}; ignoring.`);
    return;
  }
  const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 20 });
  const best = subs.data
    .map((s) => s.status)
    .sort((a, b) => rank(a) - rank(b))[0] || 'none';

  await redis(['HSET', `user:${email}`, 'pro_status', best, 'pro_updated', String(Date.now())]);
  console.log(`Customer ${customerId}: status ${best} (Pro: ${PRO_STATUSES.has(best)})`);
}

async function customerForRiskEvent(obj) {
  if (obj.customer) return obj.customer; // charge
  const chargeId = typeof obj.charge === 'string' ? obj.charge : obj.charge?.id; // dispute, fraud warning
  if (!chargeId) return null;
  const charge = await stripe.charges.retrieve(chargeId);
  return charge.customer;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET || !redisConfigured) {
    console.error('Webhook is not configured: need STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and Redis.');
    return res.status(503).json({ error: 'Not configured.' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      await rawBody(req),
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    console.error('Webhook signature check failed:', err.message);
    return res.status(400).json({ error: 'Bad signature.' });
  }

  try {
    const obj = event.data.object;

    if (SUBSCRIPTION_EVENTS.has(event.type)) {
      // Checkout sessions that are still waiting on a slow payment method
      // get picked up later by async_payment_succeeded.
      if (event.type === 'checkout.session.completed' && obj.payment_status === 'unpaid') {
        return res.status(200).json({ received: true });
      }
      const customerId = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
      if (customerId) await syncCustomer(customerId);
    } else if (RISK_EVENTS.has(event.type)) {
      // Keep a list the owner can check, and refresh Pro status in case the
      // subscription was cancelled because of it.
      const customerId = await customerForRiskEvent(obj);
      await redis(['LPUSH', 'stripe:alerts', JSON.stringify({
        type: event.type, id: obj.id, customer: customerId, at: new Date().toISOString(),
      })]);
      await redis(['LTRIM', 'stripe:alerts', 0, 199]);
      console.error(`Stripe alert ${event.type} for customer ${customerId}: check the Dashboard.`);
      if (customerId) await syncCustomer(customerId);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    // A 500 makes Stripe retry the event later.
    console.error(`Webhook ${event.type} (${event.id}) failed:`, err);
    return res.status(500).json({ error: 'Handler failed.' });
  }
}
