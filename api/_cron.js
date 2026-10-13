const crypto = require('crypto');

// Shared by the scheduled jobs (api/cron-*.js).
//
// Vercel Cron calls the path with `Authorization: Bearer $CRON_SECRET` when
// that env var is set on the project.  No secret set means no way in -- the
// jobs are never open to the internet by default.
function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const got = Buffer.from(String(req.headers.authorization || ''));
  const want = Buffer.from('Bearer ' + secret);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// A job only changes anything when its own env switch is exactly "1" AND the
// caller did not ask for ?dry=1.  Deploying the code is not enough.
function isLive(req, envName) {
  return process.env[envName] === '1' && !(req.query && req.query.dry === '1');
}

// ---------------------------------------------------------------------------
// STUB -- THE SITE HAS NO MAILER.  Nothing in this repo sends email today
// (Supabase sends its own login links; the contact form is a mailto).  Until
// Chris picks a provider this logs the message and reports it as NOT sent, so
// the job's report lists exactly who still needs to be told by hand.
// ---------------------------------------------------------------------------
async function sendMemberEmail({ to, subject, text }) {
  console.log('[mail-stub] NOT SENT to', to, '|', subject, '|', text);
  return { sent: false, reason: 'no mailer configured' };
}

module.exports = { authorized, isLive, sendMemberEmail };
