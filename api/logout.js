// POST /api/logout — ends the session on this device.

import { endSession } from './_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  try {
    await endSession(req, res);
  } catch (err) {
    console.error('Sign-out failed:', err);
  }
  return res.status(200).json({ ok: true });
}
