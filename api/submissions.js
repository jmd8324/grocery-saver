// Vercel serverless function: /api/submissions   (owner only)
// GET  → shopper receipts waiting for review, newest first
// POST { id, action: "done" | "discard" } → remove one from the queue

import { requireAdmin } from './_admin.js';
import { redis, redisConfigured } from './_redis.js';

export default async function handler(req, res) {
  if (!requireAdmin(req, res)) return;
  if (!redisConfigured) return res.status(200).json({ submissions: [], note: 'Upstash Redis is not connected.' });

  try {
    if (req.method === 'GET') {
      const ids = await redis(['ZRANGE', 'submissions', '0', '49', 'REV']);
      if (!ids || !ids.length) return res.status(200).json({ submissions: [] });
      const values = await redis(['MGET', ...ids.map((id) => 'submission:' + id)]);
      const submissions = [];
      const expired = [];
      values.forEach((v, i) => {
        if (v) { try { submissions.push(JSON.parse(v)); } catch { expired.push(ids[i]); } }
        else expired.push(ids[i]);
      });
      if (expired.length) await redis(['ZREM', 'submissions', ...expired]);
      return res.status(200).json({ submissions });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      const id = String(body.id || '');
      if (!/^[0-9a-f-]{36}$/.test(id) || !['done', 'discard'].includes(body.action)) {
        return res.status(400).json({ error: 'Bad request.' });
      }
      await redis(['ZREM', 'submissions', id]);
      await redis(['DEL', 'submission:' + id]);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    console.error('submissions:', err.message);
    return res.status(502).json({ error: "Couldn't reach the database." });
  }
}
