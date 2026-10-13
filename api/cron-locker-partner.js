const { createClient } = require('@supabase/supabase-js');
const { getStripe } = require('./_stripe');
const { authorized, isLive, sendMemberEmail } = require('./_cron');

// Daily: a Half Locker whose locker partner has not signed up within 30 days
// becomes a full Locker at the full Locker rate, from the next bill on.
//
// DRY RUN unless LOCKER_SWITCH_LIVE=1 is set on the project, and always dry
// with ?dry=1.  A dry run reports what it would do and changes nothing.
//
// Who it can touch: only a Stripe subscription that is active, is tier
// half-locker, and carries `locker_partner` metadata.  Members who joined
// before the partner rule have no such key and are never switched.

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const LIVE_ENV = 'LOCKER_SWITCH_LIVE';
const GRACE_DAYS = 30;
const DAY = 86400;

// The only copy of the email wording.  {partner} is the name they typed.
const SWITCH_EMAIL_SUBJECT = 'Your Leaf Brothers Half Locker membership';
const SWITCH_EMAIL_TEXT = "Your Half Locker membership at Leaf Brothers has been changed to a full Locker. When you signed up, you agreed that your locker partner would sign up within 30 days, and we don't have a Half Locker membership for {partner}. Your next bill will be at the full Locker rate. If your partner has signed up and we missed it, reply to this email and we'll fix it.";

// Statuses that count as "a current member" when looking for a partner.
// Deliberately wider than the one status we are willing to switch.
const CURRENT = new Set(['active', 'trialing', 'past_due']);
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);

// "  José  O'Brien-Smith Jr. " -> ['jose', 'obrien', 'smith']
// Lower case, accents off, apostrophes and full stops dropped, anything else
// that is not a letter or digit becomes a space, Jr/Sr/II/III/IV dropped.
function nameTokens(raw) {
  return String(raw || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().split(' ')
    .filter(t => t && !SUFFIXES.has(t));
}

// Two names are the same person when, after nameTokens():
//   1. they are identical, or
//   2. both have at least two words, the LAST words are equal and the FIRST
//      words start with the same letter ("Mike Smith" = "Michael J. Smith").
// Forgiving on purpose: a wrong match leaves someone on Half Locker a little
// longer; a missed match raises a member's bill by mistake.
function namesMatch(a, b) {
  const x = nameTokens(a), y = nameTokens(b);
  if (!x.length || !y.length) return false;
  if (x.join(' ') === y.join(' ')) return true;
  if (x.length < 2 || y.length < 2) return false;
  return x[x.length - 1] === y[y.length - 1] && x[0][0] === y[0][0];
}

const lower = s => String(s || '').trim().toLowerCase();

async function run({ stripe, db, now, live }) {
  const report = { job: 'locker-partner', live, now: new Date(now * 1000).toISOString(), checked: 0, not_due: [], partner_found: [], due: [], switched: [], errors: [] };

  // Every subscription, with its customer, so we know names and who is current.
  const subs = [];
  for await (const s of stripe.subscriptions.list({ status: 'all', limit: 100, expand: ['data.customer'] })) subs.push(s);
  const subById = new Map(subs.map(s => [s.id, s]));

  // The partner pool comes from BOTH places.  Stripe knows who named whom;
  // the members table also holds Half Lockers who pay in the shop and have no
  // Stripe subscription at all -- they are real partners too.
  const { data: rows, error } = await db
    .from('members').select('name, email, stripe_subscription_id')
    .eq('tier', 'half-locker').eq('status', 'active');
  if (error) throw new Error('members lookup: ' + error.message);

  const pool = [];
  for (const s of subs) {
    if (!CURRENT.has(s.status) || (s.metadata || {}).tier !== 'half-locker') continue;
    if (!s.customer || s.customer.deleted) continue;
    pool.push({ subId: s.id, name: s.customer.name, email: lower(s.customer.email), named: s.metadata.locker_partner || '' });
  }
  for (const r of rows || []) {
    const s = r.stripe_subscription_id && subById.get(r.stripe_subscription_id);
    if (s && !CURRENT.has(s.status)) continue;        // Stripe says it ended; the row is stale
    if (s && pool.some(p => p.subId === s.id)) continue; // already counted from Stripe
    pool.push({ subId: r.stripe_subscription_id || null, name: r.name, email: lower(r.email), named: '' });
  }

  let lockerPrice = null;

  for (const sub of subs) {
    const meta = sub.metadata || {};
    const partner = (meta.locker_partner || '').trim();
    // The grandfathering and the idempotency are both on this line.
    if (sub.status !== 'active' || meta.tier !== 'half-locker' || !partner || meta.switched_at) continue;
    if (sub.cancel_at_period_end) continue;            // already leaving; nothing to rebill
    if (!sub.customer || sub.customer.deleted) continue;
    report.checked++;

    const me = { subscription: sub.id, name: sub.customer.name, email: sub.customer.email, partner };
    const others = pool.filter(p => p.subId !== sub.id && (!p.email || p.email !== lower(sub.customer.email)));
    const hit = others.find(p => namesMatch(p.name, partner))            // the person they named is a member
             || others.find(p => p.named && namesMatch(p.named, sub.customer.name)); // or somebody named them
    const ageDays = Math.floor((now - (sub.start_date || sub.created)) / DAY);

    if (hit) { report.partner_found.push({ ...me, age_days: ageDays, matched: hit.name }); continue; }
    if (ageDays < GRACE_DAYS) { report.not_due.push({ ...me, age_days: ageDays }); continue; }

    report.due.push({ ...me, age_days: ageDays });
    if (!live) continue;

    try {
      if (!lockerPrice) {
        const prices = await stripe.prices.list({ lookup_keys: ['locker'], active: true, limit: 1 });
        lockerPrice = prices.data[0];
        if (!lockerPrice) throw new Error('no active Stripe price with lookup_key "locker"');
      }
      const items = sub.items.data;
      if (items.length !== 1) throw new Error('expected one subscription item, found ' + items.length);

      const switchedAt = new Date(now * 1000).toISOString();
      // proration_behavior none: nothing is charged today; the next regular
      // bill is simply at the Locker price.  Metadata merges, so
      // locker_partner and the rest stay on the subscription.
      await stripe.subscriptions.update(sub.id, {
        items: [{ id: items[0].id, price: lockerPrice.id }],
        proration_behavior: 'none',
        metadata: { tier: 'locker', switched_from: 'half-locker', switched_at: switchedAt },
      }, { idempotencyKey: 'locker-switch-' + sub.id });

      const done = { ...me, switched_at: switchedAt, members_row: 'updated', notice: 'not sent' };
      const { error: upErr } = await db.from('members').update({ tier: 'locker' }).eq('stripe_subscription_id', sub.id);
      if (upErr) { done.members_row = 'FAILED: ' + upErr.message; report.errors.push({ subscription: sub.id, error: 'members update: ' + upErr.message }); }

      const mail = await sendMemberEmail({ to: sub.customer.email, subject: SWITCH_EMAIL_SUBJECT, text: SWITCH_EMAIL_TEXT.replace('{partner}', partner) });
      done.notice = mail.sent ? 'sent' : 'NOT SENT: ' + mail.reason;
      report.switched.push(done);
    } catch (err) {
      report.errors.push({ subscription: sub.id, error: err.message });
    }
  }
  return report;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const report = await run({ stripe: getStripe(), db: supabase, now: Math.floor(Date.now() / 1000), live: isLive(req, LIVE_ENV) });
    // This log line is the record Chris (or Aurora) reads; no chat token lives here.
    console.log('[cron-locker-partner]', JSON.stringify(report));
    res.status(200).json(report);
  } catch (err) {
    console.error('[cron-locker-partner] Aborted, nothing changed:', err.message);
    res.status(500).json({ error: 'Job failed', detail: err.message });
  }
};

module.exports.run = run;
module.exports.namesMatch = namesMatch;
module.exports.nameTokens = nameTokens;
