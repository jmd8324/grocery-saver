// Shared helper for Upstash Redis (connected through Vercel → Storage).
// Files starting with "_" in api/ are not turned into web endpoints by Vercel.

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const redisConfigured = Boolean(REDIS_URL && REDIS_TOKEN);

export async function redis(command) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `Redis error ${res.status}`);
  return data.result;
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
