// Vercel serverless function: POST /api/read-prices   (owner only)
// Reads prices from a photo for the owner's update page. Nothing is saved here:
// the page shows the results for review first.
//
// Body: { image: { media_type, data }, rows: [{ item, brand, size }], stores: [{ id, name }] }

import { requireAdmin } from './_admin.js';
import { overLimit } from './_redis.js';
import { readPrices, imageProblem, ReaderError, safeParse } from './_reader.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (!requireAdmin(req, res)) return;
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "The reader isn't set up yet (ANTHROPIC_API_KEY)." });
  }
  if (await overLimit(req, 'read-prices', 60, 60 * 60)) {
    return res.status(429).json({ error: 'That is a lot of photos this hour. Try again later.' });
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const problem = imageProblem(body.image);
  if (problem) return res.status(400).json({ error: problem });
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 2000) : [];
  const stores = Array.isArray(body.stores) ? body.stores.slice(0, 50) : [];

  try {
    return res.status(200).json(await readPrices(body.image, rows, stores));
  } catch (err) {
    if (err instanceof ReaderError) return res.status(err.status).json({ error: err.message });
    console.error('read-prices:', err);
    return res.status(500).json({ error: 'Something went wrong reading that photo.' });
  }
}
