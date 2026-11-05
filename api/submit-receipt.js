// Vercel serverless function: POST /api/submit-receipt   (public, no account)
// A shopper uploads a receipt photo. Claude reads the prices, and the result
// is queued for the owner to approve on /update-prices.html before anything
// reaches the price sheet. The photo itself is never stored.
//
// Body: { image: { media_type, data }, store?: "giant" }
// Needs ANTHROPIC_API_KEY and Upstash Redis (for the review queue).
// No upload limits for now; set a monthly spend limit in the Claude Console as a safety net.

import { randomUUID } from 'node:crypto';
import { redis, redisConfigured } from './_redis.js';
import { readPrices, imageProblem, loadSheetAndStores, ReaderError, safeParse } from './_reader.js';

const KEEP_DAYS = 60;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (!process.env.ANTHROPIC_API_KEY || !redisConfigured) {
    console.error('submit-receipt: needs ANTHROPIC_API_KEY and Upstash Redis.');
    return res.status(503).json({ error: "Receipt uploads aren't open yet. Please check back soon." });
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const problem = imageProblem(body.image);
  if (problem) return res.status(400).json({ error: problem });

  let sheet, stores;
  try {
    ({ sheet, stores } = loadSheetAndStores());
  } catch (err) {
    console.error('submit-receipt: could not load prices.csv/stores.json:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again later.' });
  }

  let result;
  try {
    result = await readPrices(body.image, sheet.rows.map((r) => ({ item: r.item, brand: r.brand, size: r.size })), stores);
  } catch (err) {
    if (err instanceof ReaderError) return res.status(err.status).json({ error: err.message });
    console.error('submit-receipt read:', err);
    return res.status(500).json({ error: 'Something went wrong reading that photo.' });
  }

  // The shopper's pick wins over Claude's guess when they chose a store.
  const picked = stores.find((s) => s.id === body.store);
  const store = picked ? picked.id : result.store;
  const storeName = (stores.find((s) => s.id === store) || {}).name || null;

  if (!result.items.length) {
    return res.status(200).json({ count: 0, store: storeName, items: [] });
  }

  const submission = {
    id: randomUUID(),
    at: Date.now(),
    store,
    date: result.date,
    kind: result.kind,
    items: result.items.slice(0, 200).map(({ text, name, brand, size, price, member_price, weight_priced, rowKey }) =>
      ({ text, name, brand, size, price, member_price, weight_priced, rowKey })),
  };
  try {
    await redis(['SET', 'submission:' + submission.id, JSON.stringify(submission), 'EX', KEEP_DAYS * 24 * 60 * 60]);
    await redis(['ZADD', 'submissions', submission.at, submission.id]);
  } catch (err) {
    console.error('submit-receipt save:', err.message);
    return res.status(503).json({ error: "We read your receipt but couldn't save it. Please try again." });
  }

  return res.status(200).json({
    count: submission.items.length,
    store: storeName,
    items: submission.items.map(({ name, brand, price, member_price }) => ({ name, brand, price, member_price })),
  });
}
