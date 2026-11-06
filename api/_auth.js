// Email + password accounts, stored in Neon (see _db.js).
//
// Sessions: the browser keeps a random cookie; the database keeps only its
// SHA-256 hash, so a database leak can't be used to sign in.

import { createHash, randomBytes } from 'node:crypto';
import { db, dbConfigured } from './_db.js';
import { PRO_STATUSES } from './_stripe.js';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COOKIE = 'cc_session';
const SESSION_SECONDS = 30 * 24 * 60 * 60;

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

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

export async function startSession(res, userId) {
  const sql = await db();
  const id = newToken();
  await sql`INSERT INTO sessions (token_hash, user_id, expires_at)
            VALUES (${sha256(id)}, ${userId}, NOW() + make_interval(secs => ${SESSION_SECONDS}))`;
  await sql`UPDATE users SET last_login_at = NOW() WHERE id = ${userId}`;
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
  if (id && dbConfigured) {
    const sql = await db();
    await sql`DELETE FROM sessions WHERE token_hash = ${sha256(id)}`;
  }
  addCookie(res, `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
}

// The signed-in user's row, or null.
export async function currentUser(req) {
  if (!dbConfigured) return null;
  const id = readCookie(req, COOKIE);
  if (!id) return null;
  const sql = await db();
  const rows = await sql`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                         WHERE s.token_hash = ${sha256(id)} AND s.expires_at > NOW()`;
  return rows[0] || null;
}

export async function currentEmail(req) {
  return (await currentUser(req))?.email || null;
}

export async function getUser(email) {
  if (!dbConfigured || !email) return null;
  const sql = await db();
  const rows = await sql`SELECT * FROM users WHERE email = ${normalizeEmail(email)}`;
  return rows[0] || null;
}

// Paid subscribers, plus accounts given Pro for free (the demo account).
export const isProUser = (user) => Boolean(user && (user.free_pro || PRO_STATUSES.has(user.pro_status)));

// Sends 401 and returns null if nobody is signed in.
export async function requireUser(req, res) {
  if (!dbConfigured) {
    res.status(503).json({ error: "Accounts aren't set up yet." });
    return null;
  }
  const user = await currentUser(req);
  if (!user) {
    res.status(401).json({ error: 'Please log in first.' });
    return null;
  }
  return user;
}

// For Pro-only endpoints. Sends 402/401 and returns null unless the
// signed-in user has Pro.
export async function requirePro(req, res) {
  const user = await requireUser(req, res);
  if (!user) return null;
  if (!isProUser(user)) {
    res.status(402).json({ error: 'This is a CartCompare Pro feature.' });
    return null;
  }
  return user;
}
