// The shift-trade board: one endpoint, one action per request.
//
// Deliberately thin.  Every rule -- who may claim what, whether a PIN is
// right, whether a shift is still open -- lives in the shift_* functions in
// Postgres, because this repo is public and a serverless function is not a
// place to keep a decision anybody can read.  What this file adds is the
// session cookie: the token stays HttpOnly so a script on the page can never
// read it, and the browser never sees a database key.
//
// The key it uses is the PUBLISHABLE one on purpose.  It reaches the shift_*
// functions and nothing else -- not the member table, not anything else in
// the project -- so the worst a leak of this environment buys is what a
// signed-out visitor could already do.

const { createClient } = require('@supabase/supabase-js');

// Vercel already had an anon key on this project under a different name, and
// the dashboard will not let you add a second one, so read whichever is there
// rather than making the name the thing that breaks the board.  Order is
// deliberate: the purpose-named one wins if it exists.
const ANON_KEY_NAMES = [
  'SUPABASE_ANON_KEY',
  'SUPABASE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'VITE_SUPABASE_ANON_KEY',
  'PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_KEY',
];

const ANON_KEY_NAME = ANON_KEY_NAMES.find((n) => process.env[n]);
const ANON_KEY = ANON_KEY_NAME ? process.env[ANON_KEY_NAME] : null;

// A missing key must say so in the logs.  createClient accepts undefined and
// then fails later as an unauthorised query, which reads like a permissions
// bug and costs an afternoon.
if (!ANON_KEY) {
  console.error(
    'shifts: no Supabase publishable key in the environment. Set one of: ' +
    ANON_KEY_NAMES.join(', '));
}

const db = createClient(
  process.env.SUPABASE_URL,
  ANON_KEY
);

const COOKIE = 'lbshift';
const SIXTY_DAYS = 60 * 60 * 24 * 60;

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setCookie(res, value, maxAge) {
  res.setHeader('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; ` +
    `SameSite=Lax; Max-Age=${maxAge}`);
}

// Postgres raises with an errcode; 28000 is "you are not who you say you are"
// and 42501 is "not yours to touch".  Everything else the functions raise is
// a plain message meant to be shown to whoever is holding the phone.
function statusFor(err) {
  if (err.code === '28000') return 401;
  if (err.code === '42501') return 403;
  return 400;
}

async function call(fn, args) {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    const e = new Error(error.message || 'Something went wrong.');
    e.status = statusFor(error);
    throw e;
  }
  return data;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const action = body.action;
  const token = readCookie(req, COOKIE);

  try {
    switch (action) {
      // Before anyone is signed in: the names that can sign in at a shop.
      // Names only, and only the two shops.
      case 'roster': {
        if (body.shop !== 'waukee' && body.shop !== 'ankeny') {
          return res.status(400).json({ error: 'Pick a shop.' });
        }
        return res.json({ roster: await call('shift_roster', { p_shop: body.shop }) });
      }

      // First time in: the shop's join code, then a PIN of their choosing.
      case 'enroll': {
        const out = await call('shift_enroll', {
          p_staff_id: body.staff_id,
          p_shop: body.shop,
          p_join_code: body.join_code,
          p_pin: body.pin,
        });
        setCookie(res, out.token, SIXTY_DAYS);
        return res.json({ me: out.me });
      }

      case 'login': {
        const out = await call('shift_login', {
          p_staff_id: body.staff_id,
          p_pin: body.pin,
        });
        setCookie(res, out.token, SIXTY_DAYS);
        return res.json({ me: out.me });
      }

      case 'signout': {
        if (token) await call('shift_signout', { p_token: token });
        setCookie(res, '', 0);
        return res.json({ ok: true });
      }

      case 'board':
        return res.json(await call('shift_board', { p_token: token }));

      case 'post':
        return res.json({ trade: await call('shift_post', {
          p_token: token,
          p_shop: body.shop,
          p_date: body.date,
          p_start: body.start || null,
          p_end: body.end || null,
          p_note: body.note || null,
        }) });

      // Chris only.  He enters a shift somebody told him about in person.
      // The trade belongs to THAT person -- see shift_post_for in the schema.
      case 'post_for':
        return res.json({ trade: await call('shift_post_for', {
          p_token: token,
          p_staff_id: body.staff_id,
          p_shop: body.shop,
          p_date: body.date,
          p_start: body.start || null,
          p_end: body.end || null,
          p_note: body.note || null,
        }) });

      case 'claim':
        return res.json({ trade: await call('shift_claim', {
          p_token: token, p_trade_id: body.trade_id }) });

      case 'unclaim':
        return res.json({ trade: await call('shift_unclaim', {
          p_token: token, p_trade_id: body.trade_id }) });

      case 'cancel':
        return res.json({ trade: await call('shift_cancel', {
          p_token: token, p_trade_id: body.trade_id }) });

      // Chris only.  Clears a PIN so they can set a new one with the join code.
      case 'reset_pin':
        return res.json(await call('shift_reset_pin', {
          p_token: token, p_staff_id: body.staff_id }));

      default:
        return res.status(400).json({ error: 'Unknown action.' });
    }
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[shifts]', action, err.message);
    // A 401 means the cookie is stale or forged; clear it so the page falls
    // back to the sign-in screen instead of looping on a dead token.
    if (status === 401 && action !== 'login' && action !== 'enroll') {
      setCookie(res, '', 0);
    }
    return res.status(status).json({
      error: status >= 500 ? 'Something went wrong. Try again.' : err.message,
    });
  }
};
