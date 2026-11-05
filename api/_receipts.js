// "Share receipts to compare" rule.
//
//   Free: every visit to the list builder needs RECEIPTS_NEEDED new receipts.
//         Unlocking uses them up and opens the builder for UNLOCK_SECONDS.
//   Pro:  RECEIPTS_NEEDED receipts once (ever), then the builder is always open.
//
// A receipt counts only if we found prices on it, and the same photo never
// counts twice for the same shopper. Shoppers are identified by their email
// when signed in, otherwise by an anonymous browser cookie (cc_visitor).
//
// Redis keys (<who> is "u:<email>" or "v:<visitor id>"):
//   rc:credits:<who>       receipts shared and not yet used for a free visit
//   rc:total:<who>         receipts shared, ever
//   rc:seen:<who>:<hash>   this photo already counted (60 days)
//   rc:unlock:<who>        list builder is open (expires after UNLOCK_SECONDS)

import { redis } from './_redis.js';
import { currentEmail, getUser, sha256, visitorId } from './_auth.js';
import { PRO_STATUSES } from './_stripe.js';

export const RECEIPTS_NEEDED = 2;
export const UNLOCK_SECONDS = 60 * 60;
const SEEN_SECONDS = 60 * 24 * 60 * 60;

// Pass res to give a first-time visitor their cookie.
export async function whoIs(req, res) {
  const email = await currentEmail(req);
  if (email) return { key: 'u:' + email, email };
  const v = visitorId(req, res);
  return v ? { key: 'v:' + v, email: null } : null;
}

async function isPro(who) {
  if (!who || !who.email) return false;
  return PRO_STATUSES.has((await getUser(who.email)).pro_status);
}

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

// Where this shopper stands, for showing progress on the pages.
export async function accessStatus(who) {
  if (!who) return { plan: 'free', needed: RECEIPTS_NEEDED, shared: 0, open: false };
  const pro = await isPro(who);
  const [credits, total, ttl] = await Promise.all([
    redis(['GET', `rc:credits:${who.key}`]),
    redis(['GET', `rc:total:${who.key}`]),
    redis(['TTL', `rc:unlock:${who.key}`]),
  ]);
  const shared = pro ? Math.min(toInt(total), RECEIPTS_NEEDED) : Math.min(toInt(credits), RECEIPTS_NEEDED);
  const openFor = toInt(ttl) > 0 ? toInt(ttl) : 0;
  const open = pro ? toInt(total) >= RECEIPTS_NEEDED : openFor > 0;
  return { plan: pro ? 'pro' : 'free', needed: RECEIPTS_NEEDED, shared, open, openFor: pro ? null : openFor };
}

// Opens the list builder if allowed, using up receipts for a free visit.
// Returns the updated status; status.open tells whether it worked.
export async function unlock(who) {
  const status = await accessStatus(who);
  if (status.open || status.plan === 'pro' || !who) return status;
  if (status.shared < RECEIPTS_NEEDED) return status;

  const left = await redis(['DECRBY', `rc:credits:${who.key}`, RECEIPTS_NEEDED]);
  if (toInt(left) < 0) {
    // Another tab spent them first: put them back.
    await redis(['INCRBY', `rc:credits:${who.key}`, RECEIPTS_NEEDED]);
    return status;
  }
  await redis(['SET', `rc:unlock:${who.key}`, '1', 'EX', UNLOCK_SECONDS]);
  return { ...status, shared: Math.min(toInt(left), RECEIPTS_NEEDED), open: true, openFor: UNLOCK_SECONDS };
}

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
