// Neon Postgres: where user accounts and sign-in sessions live.
// Connecting Neon to the project in Vercel (Storage tab) sets DATABASE_URL.
//
// Tables (created automatically on first use):
//   users     one row per account: email, scrambled password, Pro status
//   sessions  one row per signed-in device (only a hash of the cookie is kept)
//
// The grader's demo account (demo@demo.com) is created here too, with free Pro.

import { neon } from '@neondatabase/serverless';
import { hashPassword } from './_password.js';

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
export const dbConfigured = Boolean(url);
export const sql = dbConfigured ? neon(url) : null;

export const DEMO_EMAIL = 'demo@demo.com';
const DEMO_PASSWORD = 'password123!'; // published in the class assignment on purpose

let ready = null;
export function ensureSchema() {
  if (!ready) {
    ready = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS users (
        id              SERIAL PRIMARY KEY,
        email           TEXT NOT NULL UNIQUE,
        password_hash   TEXT NOT NULL,
        stripe_customer TEXT UNIQUE,
        pro_status      TEXT NOT NULL DEFAULT 'none',
        pro_updated     TIMESTAMPTZ,
        free_pro        BOOLEAN NOT NULL DEFAULT FALSE,
        is_demo         BOOLEAN NOT NULL DEFAULT FALSE,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login_at   TIMESTAMPTZ
      )`;
      await sql`CREATE TABLE IF NOT EXISTS sessions (
        token_hash  TEXT PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at  TIMESTAMPTZ NOT NULL
      )`;
      // The demo account always exists, always has this password and always has Pro.
      const hash = await hashPassword(DEMO_PASSWORD);
      await sql`INSERT INTO users (email, password_hash, free_pro, is_demo)
                VALUES (${DEMO_EMAIL}, ${hash}, TRUE, TRUE)
                ON CONFLICT (email) DO UPDATE
                SET password_hash = EXCLUDED.password_hash, free_pro = TRUE, is_demo = TRUE`;
    })().catch((err) => { ready = null; throw err; });
  }
  return ready;
}

// Runs ensureSchema first, so every query can assume the tables exist.
export async function db() {
  if (!dbConfigured) throw new Error('DATABASE_URL is not set.');
  await ensureSchema();
  return sql;
}
