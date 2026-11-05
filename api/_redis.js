// Shared Redis helper (connected through Vercel → Storage).
// Files starting with "_" in api/ are not turned into web endpoints by Vercel.
//
// Works with either kind of connection Vercel may add:
//   - REST style: KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_*)
//   - Plain style: REDIS_URL (redis:// or rediss://)

import { createClient } from 'redis';

const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const PLAIN_URL = process.env.REDIS_URL || process.env.KV_URL;

const useRest = Boolean(REST_URL && REST_TOKEN);

export const redisConfigured = useRest || Boolean(PLAIN_URL);

// One connection is reused while the function stays warm.
let clientPromise = null;
function getClient() {
  if (!clientPromise) {
    const client = createClient({ url: PLAIN_URL });
    client.on('error', (err) => console.error('Redis error:', err.message));
    clientPromise = client.connect().then(() => client).catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

// Runs one Redis command, e.g. redis(['SET', 'key', 'value']).
export async function redis(command) {
  if (useRest) {
    const res = await fetch(REST_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `Redis error ${res.status}`);
    return data.result;
  }
  const client = await getClient();
  return client.sendCommand(command.map(String));
}

// Returns true if this caller has made more than `limit` requests in the
// current window. If Redis isn't set up (or errors), it never blocks.
export async function overLimit(req, name, limit, windowSeconds) {
  if (!redisConfigured) return false;
  const ip = String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  const key = `ratelimit:${name}:${ip}`;
  try {
    const count = await redis(['INCR', key]);
    if (count === 1) await redis(['EXPIRE', key, windowSeconds]);
    return count > limit;
  } catch {
    return false;
  }
}
