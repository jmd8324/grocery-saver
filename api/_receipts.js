// Who is using the site, whether they can compare their cart (Pro only),
// and a count of the receipts each shopper has shared.
//
// Anyone can share receipts, signed in or not. A receipt counts only if we
// found prices on it, and the same photo never counts twice for the same
// shopper. Shoppers are identified by their email when signed in, otherwise
// by an anonymous browser cookie (cc_visitor).
//
// Redis keys (<who> is "u:<email>" or "v:<visitor id>"):
//   rc:credits:<who>       receipts shared (kept from the old receipt rule)
//   rc:total:<who>         receipts shared, ever
//   rc:seen:<who>:<hash>   this photo already counted (60 days)

import { redis } from './_redis.js';
import { currentUser, isProUser, sha256, visitorId } from './_auth.js';

const SEEN_SECONDS = 60 * 24 * 60 * 60;

// Pass res to give a first-time visitor their cookie.
export async function whoIs(req, res) {
  const user = await currentUser(req).catch((err) => { console.error('Account lookup failed:', err.message); return null; });
  if (user) return { key: 'u:' + user.email, email: user.email, pro: isProUser(user), demo: user.is_demo };
  const v = visitorId(req, res);
  return v ? { key: 'v:' + v, email: null } : null;
}

const isPro = (who) => Boolean(who && who.pro);

const toInt = (v) => Number(v) || 0;

// Counts a receipt for this shopper. Returns false if this photo already counted.
export async function recordReceipt(who, imageData) {
  const hash = sha256(String(imageData)).slice(0, 32);
  const fresh = await redis(['SET', `rc:seen:${who.key}:${hash}`, '1', 'NX', 'EX', SEEN_SECONDS]);
  if (fresh !== 'OK') return false;
  await redis(['INCR', `rc:credits:${who.key}`]);
  await redis(['INCR', `rc:total:${who.key}`]);
  return true;
}

// Where this shopper stands. Comparing your cart is a Pro feature
// (paid subscribers and the demo account). Anyone can still share receipts.
export async function accessStatus(who) {
  const pro = isPro(who);
  return { plan: pro ? 'pro' : 'free', signedIn: Boolean(who && who.email), open: pro };
}

// Kept so callers don't change: opening the builder needs Pro, nothing else.
export const unlock = accessStatus;

// When someone signs in, receipts they shared on this browser move to their account.
export async function moveVisitorReceipts(req, email) {
  const v = visitorId(req);
  if (!v) return;
  const from = 'v:' + v, to = 'u:' + email;
  for (const name of ['credits', 'total']) {
    const n = toInt(await redis(['GET', `rc:${name}:${from}`]));
    if (n > 0) {
      await redis(['INCRBY', `rc:${name}:${to}`, n]);
      await redis(['DEL', `rc:${name}:${from}`]);
    }
  }
  const ttl = toInt(await redis(['TTL', `rc:unlock:${from}`]));
  if (ttl > 0) await redis(['SET', `rc:unlock:${to}`, '1', 'EX', ttl]);
}
