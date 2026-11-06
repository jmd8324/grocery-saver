// /api/prices — the price sheet, for CartCompare Pro members.
// (The plain /prices.csv file is redirected away in vercel.json.)
//
//   GET                 → { status }                 where the shopper stands
//   POST                → { csv, status } for Pro, else 403 { error, status }
//   GET with X-Admin-Password → { csv }               for /update-prices.html
//
// status: { plan: "free"|"pro", signedIn, open }

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  try {
    const who = await whoIs(req, res);
    if (req.method === 'GET') return res.status(200).json({ status: await accessStatus(who) });

    const status = await unlock(who);
    if (!status.open) {
      return res.status(403).json({ error: 'Comparing your cart is a CartCompare Pro feature.', status });
    }
    return res.status(200).json({ csv: readSheet(), status });
  } catch (err) {
    console.error('prices:', err);
    return res.status(500).json({ error: "We couldn't load prices right now. Please try again in a moment." });
  }
}
