// Vercel serverless function: POST /api/save-prices   (owner only)
// Applies reviewed price updates to prices.csv in the GitHub repo.
// Body: { updates: [{ key | newRow, column, price, checkedOn }], source: "receipt from GIANT" }

import { requireAdmin } from './_admin.js';
import { githubConfigured, readFile, writeFile } from './_github.js';
import { parseCSV, toCSV, applyUpdates } from '../sheet.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (!requireAdmin(req, res)) return;
  if (!githubConfigured) {
    return res.status(503).json({ error: "Saving to GitHub isn't set up yet (add GITHUB_TOKEN). Use “Download updated sheet” instead.", code: 'no_github' });
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const updates = Array.isArray(body.updates) ? body.updates.slice(0, 500) : [];
  if (!updates.length) return res.status(400).json({ error: 'Nothing to save.' });
  const source = String(body.source || 'photo').replace(/[\r\n]+/g, ' ').slice(0, 80);

  // Retry once if someone else saved at the same moment.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await readFile('prices.csv');
      const { sheet, applied } = applyUpdates(parseCSV(file.text), updates);
      if (!applied) return res.status(400).json({ error: 'None of those prices matched the sheet.' });
      const csv = toCSV(sheet);
      const commit = await writeFile('prices.csv', csv, file.sha, `Update ${applied} price${applied === 1 ? '' : 's'} (${source})`);
      return res.status(200).json({ applied, commit, csv });
    } catch (err) {
      if (err.status === 409 && attempt === 0) continue;
      console.error('save-prices:', err.message);
      if (err.status === 401 || err.status === 403) return res.status(503).json({ error: 'GitHub refused the token. Check GITHUB_TOKEN has Contents read/write on this repo.' });
      if (err.status === 404) return res.status(503).json({ error: "Couldn't find prices.csv on GitHub. Is the price comparison PR merged into main?" });
      return res.status(502).json({ error: 'Saving to GitHub failed. Try again, or download the sheet instead.' });
    }
  }
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return {}; }
}
