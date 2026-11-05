// /api/prices — the price sheet, for shoppers who have shared enough receipts.
// (The plain /prices.csv file is redirected away in vercel.json.)
//
//   GET                 → { status }                 where the shopper stands
//   POST                → { csv, status } if allowed, else 403 { error, status }
//                         For free shoppers this uses up 2 receipts for a visit.
//   GET with X-Admin-Password → { csv }               for /update-prices.html
//
// status: { plan: "free"|"pro", needed, shared, open, openFor }

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redisConfigured } from './_redis.js';
import { isAdmin } from './_admin.js';
import { whoIs, accessStatus, unlock } from './_receipts.js';

const readSheet = () => readFileSync(join(process.cwd(), 'prices.csv'), 'utf8');

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET' && req.headers['x-admin-password']) {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Wrong password.' });
    return res.status(200).json({ csv: readSheet() });
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (!redisConfigured) {
    return res.status(503).json({ error: "Price comparison isn't set up yet. Please check back soon." });
  }

  try {
    const who = await whoIs(req, res);
    if (req.method === 'GET') return res.status(200).json({ status: await accessStatus(who) });

    const status = await unlock(who);
    if (!status.open) {
      const left = status.needed - status.shared;
      return res.status(403).json({
        error: `Share ${left} more receipt${left === 1 ? '' : 's'} to compare your cart.`,
        status,
      });
    }
    return res.status(200).json({ csv: readSheet(), status });
  } catch (err) {
    console.error('prices:', err);
    return res.status(500).json({ error: "We couldn't load prices right now. Please try again in a moment." });
  }
}
