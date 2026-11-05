// Email sign-in (no passwords) and the user records Pro status lives in.
//
// Redis keys:
//   login:<sha256 of token>   → email          (15 minutes, one use)
//   session:<sha256 of id>    → email          (30 days)
//   user:<email>              → hash { stripe_customer, pro_status, pro_updated }
//   customer:<cus_…>          → email          (lets webhooks find the user)
//
// Only hashes of tokens are stored, so a Redis leak can't be used to sign in.

import { createHash, randomBytes } from 'node:crypto';
import { redis, redisConfigured } from './_redis.js';
import { PRO_STATUSES } from './_stripe.js';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COOKIE = 'cc_session';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
export const LOGIN_SECONDS = 15 * 60;

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

export function readBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

export function readCookie(req, name) {
  if (req.cookies && req.cookies[name]) return req.cookies[name];
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}

// Adds a Set-Cookie header without replacing any already set.
export function addCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, cookie) : cookie);
}

export async function startSession(res, email) {
  const id = newToken();
  await redis(['SET', `session:${sha256(id)}`, email, 'EX', SESSION_SECONDS]);
  addCookie(res, `${COOKIE}=${id}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`);
}

// An anonymous ID for this browser, so shoppers without an account still get
// credit for the receipts they share. Pass res to create one if missing.
const VISITOR = 'cc_visitor';
const VISITOR_SECONDS = 365 * 24 * 60 * 60;
export function visitorId(req, res) {
  let id = readCookie(req, VISITOR);
  if (/^[A-Za-z0-9_-]{20,64}$/.test(id)) return id;
  if (!res) return null;
  id = newToken();
  addCookie(res, `${VISITOR}=${id}; Path=/; Max-Age=${VISITOR_SECONDS}; HttpOnly; Secure; SameSite=Lax`);
  return id;
}

export async function endSession(req, res) {
  const id = readCookie(req, COOKIE);
  if (id && redisConfigured) await redis(['DEL', `session:${sha256(id)}`]);
  addCookie(res, `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
}

// The signed-in user's email, or null.
export async function currentEmail(req) {
  if (!redisConfigured) return null;
  const id = readCookie(req, COOKIE);
  if (!id) return null;
  return (await redis(['GET', `session:${sha256(id)}`])) || null;
}

export async function getUser(email) {
  const flat = (await redis(['HGETALL', `user:${email}`])) || [];
  const user = {};
  for (let i = 0; i < flat.length; i += 2) user[flat[i]] = flat[i + 1];
  return user;
}

// Sends 401 and returns null if nobody is signed in.
export async function requireUser(req, res) {
  if (!redisConfigured) {
    res.status(503).json({ error: "Sign-in isn't set up yet." });
    return null;
  }
  const email = await currentEmail(req);
  if (!email) {
    res.status(401).json({ error: 'Please sign in first.' });
    return null;
  }
  return email;
}

// For Pro-only endpoints (saved lists, price history…). Sends 402/401 and
// returns null unless the signed-in user has an active Pro subscription.
export async function requirePro(req, res) {
  const email = await requireUser(req, res);
  if (!email) return null;
  const user = await getUser(email);
  if (!PRO_STATUSES.has(user.pro_status)) {
    res.status(402).json({ error: 'This is a CartCompare Pro feature.' });
    return null;
  }
  return email;
}
