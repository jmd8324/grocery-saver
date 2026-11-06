// /api/account?action=…  One endpoint for sign-in, to stay under Vercel's
// free-plan limit of 12 functions. Each action's code lives in its own
// "_" file (which Vercel doesn't count as a separate function).
//   POST ?action=signup   create an account          (_signup.js)
//   POST ?action=login    log in with a password     (_login.js)
//   POST ?action=logout   sign out                   (_logout.js)
//   GET  ?action=me       who's signed in, Pro?      (_me.js)
//   POST ?action=checkout start Pro checkout         (_checkout.js)
//   POST ?action=portal   open billing management    (_portal.js)

import login from './_login.js';
import signup from './_signup.js';
import logout from './_logout.js';
import me from './_me.js';
import checkout from './_checkout.js';
import portal from './_portal.js';

const ACTIONS = { signup, login, logout, me, checkout, portal };

export default async function handler(req, res) {
  const action = ACTIONS[String(req.query?.action || '')];
  if (!action) return res.status(404).json({ error: 'Unknown action.' });
  return action(req, res);
}
