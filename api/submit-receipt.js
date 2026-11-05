// Vercel serverless function: POST /api/submit-receipt   (public, no account)
// A shopper uploads a receipt or weekly-flyer photo, or a PDF. Claude reads the prices, and the result
// is queued for the owner to approve on /update-prices.html before anything
// reaches the price sheet. The photo or PDF itself is never stored.
//
// Body: { image: { media_type, data }, store?: "giant" }
// Needs ANTHROPIC_API_KEY and Upstash Redis (for the review queue).
// No upload limits for now; set a monthly spend limit in the Claude Console as a safety net.

import { randomUUID } from 'node:crypto';
import { redis, redisConfigured } from './_redis.js';
import { whoIs, recordReceipt, accessStatus } from './_receipts.js';
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

  // Who gets credit for this receipt (also gives first-time visitors their cookie).
  let who = null;
  try { who = await whoIs(req, res); } catch (err) { console.error('submit-receipt who:', err.message); }

  if (!result.items.length) {
    const access = who ? await accessStatus(who).catch(() => null) : null;
    return res.status(200).json({ count: 0, store: storeName, items: [], access });
  }

  const submission = {
    id: randomUUID(),
    at: Date.now(),
    store,
    date: result.date,
    kind: result.kind,
    sale_ends: result.sale_ends,
    items: result.items.slice(0, 300).map(({ text, name, brand, size, price, member_price, weight_priced, deal, sale_ends, rowKey }) =>
      ({ text, name, brand, size, price, member_price, weight_priced, deal, sale_ends, rowKey })),
  };
  try {
    await redis(['SET', 'submission:' + submission.id, JSON.stringify(submission), 'EX', KEEP_DAYS * 24 * 60 * 60]);
    await redis(['ZADD', 'submissions', submission.at, submission.id]);
  } catch (err) {
    console.error('submit-receipt save:', err.message);
    return res.status(503).json({ error: "We read your receipt but couldn't save it. Please try again." });
  }

  let counted = false, access = null;
  if (who) {
    try {
      counted = await recordReceipt(who, body.image.data);
      access = await accessStatus(who);
    } catch (err) {
      console.error('submit-receipt credit:', err.message);
    }
  }

  return res.status(200).json({
    counted,
    access,
    count: submission.items.length,
    store: storeName,
    items: submission.items.map(({ name, brand, price, member_price, deal }) => ({ name, brand, price, member_price, deal })),
  });
}
