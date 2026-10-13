const { createClient } = require('@supabase/supabase-js');
const { getStripe } = require('./_stripe');
const { authorized, isLive } = require('./_cron');

// Daily: a member who agreed to the key-return terms, whose membership ended
// 10 or more days ago, and whose key has not been ticked as returned in
// admin.html, is charged the key replacement fee once.
//
// DRY RUN unless KEY_FEE_LIVE=1 is set on the project, and always dry with
// ?dry=1.  A dry run lists who would be charged and changes nothing.
//
// Who it can touch: only rows with key_fee_agreed_at.  Everyone who joined
// before the checkbox existed has NULL there and is exempt for good.
//
// Needs supabase/members_locker_partner_keys.sql.  Without those columns the
// lookup fails and the job stops having done nothing.

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const LIVE_ENV = 'KEY_FEE_LIVE';
const KEY_FEE_CENTS = 1500;
const RETURN_DAYS = 10;
const DAY = 86400;
const FEE_DESCRIPTION = 'Leaf Brothers Cigars key replacement fee';

async function findCard(stripe, customerId) {
  const customer = await stripe.customers.retrieve(customerId);
  if (!customer || customer.deleted) return null;
  const preferred = customer.invoice_settings && customer.invoice_settings.default_payment_method;
  if (preferred) return typeof preferred === 'string' ? preferred : preferred.id;
  // Checkout saves the card on the subscription, not as the customer default,
  // so once the subscription is gone the card has to be looked up.
  const cards = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
  return cards.data[0] ? cards.data[0].id : null;
}

async function run({ stripe, db, now, live }) {
  const nowIso = new Date(now * 1000).toISOString();
  const cutoff = new Date((now - RETURN_DAYS * DAY) * 1000).toISOString();
  const report = { job: 'key-fee', live, now: nowIso, due: [], charged: [], failed: [], skipped: [], errors: [] };

  const { data: rows, error } = await db
    .from('members')
    .select('id, name, email, stripe_customer_id, cancelled_at')
    .eq('status', 'cancelled')
    .not('key_fee_agreed_at', 'is', null)
    .not('cancelled_at', 'is', null)
    .lte('cancelled_at', cutoff)
    .is('key_returned_at', null)
    .is('key_fee_charged_at', null)
    .is('key_fee_failed_at', null);
  if (error) throw new Error('members lookup: ' + error.message);

  for (const m of rows || []) {
    const who = { member: m.id, name: m.name, email: m.email, cancelled_at: m.cancelled_at };
    if (!m.stripe_customer_id) { report.skipped.push({ ...who, reason: 'no Stripe customer' }); continue; }
    report.due.push(who);
    if (!live) continue;

    // Claim the row BEFORE touching the card.  If anything after this goes
    // wrong the worst case is a fee that was not taken, never one taken twice.
    // The claim also loses, on purpose, to a key ticked back in a moment ago.
    const { data: claimed, error: claimErr } = await db
      .from('members').update({ key_fee_charged_at: nowIso })
      .eq('id', m.id).is('key_fee_charged_at', null).is('key_returned_at', null)
      .select('id');
    if (claimErr) { report.errors.push({ ...who, error: 'claim: ' + claimErr.message }); continue; }
    if (!claimed || !claimed.length) { report.skipped.push({ ...who, reason: 'already charged or key returned' }); continue; }

    try {
      const card = await findCard(stripe, m.stripe_customer_id);
      if (!card) throw new Error('no card on file');
      // One PaymentIntent, confirmed now, off-session: a single call that
      // either takes the fee or throws.  An invoice would leave an open bill
      // behind on a decline and Stripe would keep retrying it.
      const pi = await stripe.paymentIntents.create({
        amount: KEY_FEE_CENTS,
        currency: 'usd',
        customer: m.stripe_customer_id,
        payment_method: card,
        off_session: true,
        confirm: true,
        description: FEE_DESCRIPTION,
        receipt_email: m.email || undefined,
        metadata: { member_id: m.id, reason: 'key_replacement_fee' },
      }, { idempotencyKey: 'key-fee-' + m.id });
      if (pi.status !== 'succeeded') throw new Error('payment ' + pi.status);

      const { error: recErr } = await db.from('members').update({ key_fee_payment_id: pi.id }).eq('id', m.id);
      if (recErr) report.errors.push({ ...who, error: 'charged ' + pi.id + ' but could not record the payment id: ' + recErr.message });
      report.charged.push({ ...who, payment: pi.id, amount_cents: KEY_FEE_CENTS });
    } catch (err) {
      // Declined, no card, needs authentication: record it once and leave it.
      // key_fee_failed_at keeps this row out of every later run until somebody
      // clears it by hand.
      const reason = String(err.message || err).slice(0, 300);
      const { error: failErr } = await db.from('members')
        .update({ key_fee_charged_at: null, key_fee_failed_at: nowIso, key_fee_error: reason })
        .eq('id', m.id);
      if (failErr) report.errors.push({ ...who, error: 'charge failed (' + reason + ') and the row still reads as charged: ' + failErr.message });
      report.failed.push({ ...who, reason });
    }
  }
  return report;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const report = await run({ stripe: getStripe(), db: supabase, now: Math.floor(Date.now() / 1000), live: isLive(req, LIVE_ENV) });
    console.log('[cron-key-fee]', JSON.stringify(report));
    res.status(200).json(report);
  } catch (err) {
    console.error('[cron-key-fee] Aborted, nothing changed:', err.message);
    res.status(500).json({ error: 'Job failed', detail: err.message });
  }
};

module.exports.run = run;
