const { createClient } = require('@supabase/supabase-js');
const { TIERS, LOCATIONS, KEY_TIERS, TIER_NAMES, RULES_VERSION, getStripe, renewalDate, tierOf } = require('./_stripe');

// Self-serve membership upgrade from the member portal (member.html).
//
//   GET  /api/upgrade?subscriptionId=sub_...   what they can move up to
//   POST /api/upgrade { subscriptionId, tier, ... }   do it
//
// Upgrades only: the new tier must cost strictly more per month than the one
// they pay for now, by the live Stripe prices.  It takes effect at once: the
// subscription's price is swapped, Stripe invoices just the prorated
// difference for the rest of this period and charges the card on file, and
// the renewal date does not move.  If that charge fails, nothing changes
// (payment_behavior error_if_incomplete) -- nobody ends up upgraded unpaid.
//
// Downgrades, lounge changes and Square-billed members go through the shop.

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ADMIN_EMAIL = 'ongebub@gmail.com';
const PARTNER_MAX = 80;
const UPGRADABLE = ['active', 'trialing'];

function cleanPartner(raw) {
  if (typeof raw !== 'string') return null;
  return raw.replace(/\s+/g, ' ').trim().slice(0, PARTNER_MAX).trim() || null;
}

const isLocker = t => /locker/.test(t || '');

// What moving from `from` to `to` asks of the member.  The same function
// drives the portal's form (GET) and the server's refusal (POST).
//  - Select -> a key tier: the key-return terms and the five member rules,
//    exactly as a new signup for that tier.
//  - Into a locker tier from a non-locker one, lounge Ankeny or Both: the
//    Ankeny humidor-locker notice.
//  - Half Locker: the locker partner's name.
function requirements(from, to) {
  const intoKeys = KEY_TIERS.includes(to) && !KEY_TIERS.includes(from);
  return {
    key_fee_agreed: intoKeys,
    rules: intoKeys,
    ankeny_notice_if_ankeny: isLocker(to) && !isLocker(from),
    locker_partner: to === 'half-locker',
  };
}

function fail(res, status, detail, fieldErrors) {
  return res.status(status).json({ error: detail, detail, ...(fieldErrors && { fieldErrors }) });
}

function money(cents) {
  return (cents / 100).toFixed(2);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Who is asking (same as cancel.js) ──
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const { data: userData, error: authError } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
  if (authError || !userData?.user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  const userEmail = (userData.user.email || '').toLowerCase();
  const isAdmin = userEmail === ADMIN_EMAIL;

  let body = {};
  if (req.method === 'POST') {
    try {
      body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) || {};
    } catch {
      return fail(res, 400, 'Bad request');
    }
  }
  const subscriptionId = String((req.method === 'GET' ? req.query?.subscriptionId : body.subscriptionId) || '');
  if (!subscriptionId) return fail(res, 400, 'subscriptionId is required');
  if (!subscriptionId.startsWith('sub_')) {
    return fail(res, 400, 'Your membership is billed in the shop. Please contact the shop to change it.');
  }

  // ── Their own membership only (admins may act on anyone's) ──
  const { data: rows, error: lookupErr } = await supabase
    .from('members')
    .select('id, email, name, tier, home_location, stripe_subscription_id')
    .eq('stripe_subscription_id', subscriptionId)
    .limit(1);
  const member = rows && rows[0];
  if (lookupErr || !member) {
    console.log('[upgrade] Subscription not found in members table:', subscriptionId);
    return fail(res, 404, 'Membership not found');
  }
  if (!isAdmin && String(member.email || '').toLowerCase() !== userEmail) {
    console.log('[upgrade] Non-admin user', userEmail, 'attempted to upgrade subscription', subscriptionId, '— denied');
    return fail(res, 403, 'You can only change your own membership');
  }

  let stripe, sub;
  try {
    stripe = getStripe();
    sub = await stripe.subscriptions.retrieve(subscriptionId);
  } catch (err) {
    console.error('[upgrade] Stripe retrieve error:', err.message);
    return fail(res, 500, 'Could not load your membership. Please try again.');
  }

  // ── Is this membership in a state that can be upgraded online? ──
  if (!UPGRADABLE.includes(sub.status)) {
    const why = sub.status === 'past_due'
      ? 'Your last payment did not go through, so your membership can’t be upgraded online right now. Please contact the shop.'
      : 'This membership isn’t active, so it can’t be upgraded. Please contact the shop.';
    return fail(res, 409, why);
  }
  if (sub.cancel_at_period_end || sub.cancel_at) {
    return fail(res, 409, 'This membership is set to cancel, so it can’t be upgraded online. Please contact the shop.');
  }
  const items = sub.items?.data || [];
  const item = items[0];
  const current = item?.price;
  const from = tierOf(sub);
  if (items.length !== 1 || !current || current.unit_amount == null || !current.recurring || !from) {
    console.error('[upgrade] Unexpected subscription shape:', subscriptionId, 'items:', items.length, 'tier:', from);
    return fail(res, 409, 'This membership can’t be upgraded online. Please contact the shop.');
  }

  // ── The tiers that cost more, at the live prices ──
  let prices;
  try {
    const list = await stripe.prices.list({ lookup_keys: TIERS, active: true, limit: 20 });
    prices = list.data;
  } catch (err) {
    console.error('[upgrade] Stripe price list error:', err.message);
    return fail(res, 500, 'Could not load membership prices. Please try again.');
  }
  const higher = TIERS
    .map(t => prices.find(p => p.lookup_key === t))
    .filter(p => p
      && p.unit_amount > current.unit_amount
      && p.currency === current.currency
      && p.recurring?.interval === current.recurring.interval
      && (p.recurring?.interval_count || 1) === (current.recurring.interval_count || 1))
    .sort((a, b) => a.unit_amount - b.unit_amount);

  const loc = member.home_location || sub.metadata?.home_location || null;

  if (req.method === 'GET') {
    // An estimate of today's charge per option, from Stripe's own proration
    // maths.  Best effort: the picker still works without it.
    const options = await Promise.all(higher.map(async p => {
      let due_now = null;
      try {
        const preview = await stripe.invoices.createPreview({
          customer: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
          subscription: sub.id,
          subscription_details: {
            items: [{ id: item.id, price: p.id }],
            proration_behavior: 'always_invoice',
          },
        });
        due_now = preview.amount_due;
      } catch (err) {
        console.log('[upgrade] Preview failed (non-fatal):', p.lookup_key, err.message);
      }
      return {
        tier: p.lookup_key,
        name: TIER_NAMES[p.lookup_key],
        monthly: p.unit_amount,
        due_now,
        requires: requirements(from, p.lookup_key),
      };
    }));
    return res.status(200).json({
      current: { tier: from, name: TIER_NAMES[from], monthly: current.unit_amount },
      home_location: loc,
      renewal_date: renewalDate(sub),
      rules_version: RULES_VERSION,
      options,
    });
  }

  // ── POST: check everything before touching Stripe ──
  const to = body.tier;
  if (!TIERS.includes(to)) return fail(res, 400, 'Please choose a membership.');
  const target = higher.find(p => p.lookup_key === to);
  if (!target) {
    return fail(res, 400, 'Online changes are upgrades only. To move to that membership, please contact the shop.');
  }

  let homeLocation = loc;
  if (!homeLocation) {
    homeLocation = LOCATIONS.find(l => l.toLowerCase() === String(body.home_location || '').trim().toLowerCase()) || null;
    if (!homeLocation) return fail(res, 400, 'Please choose your home lounge.', { home_location: 'required' });
  }

  const need = requirements(from, to);
  const partner = need.locker_partner ? cleanPartner(body.locker_partner) : null;
  if (need.locker_partner && !partner) {
    return fail(res, 400, "Please enter your locker partner's full name.", { locker_partner: 'required' });
  }
  // Only a real `true` counts -- the checkbox, not a truthy string.
  if (need.key_fee_agreed && body.key_fee_agreed !== true) {
    return fail(res, 400, 'Please agree to the key return terms.', { key_fee_agreed: 'required' });
  }
  if (need.rules && body.rules_ack !== RULES_VERSION) {
    return fail(res, 400, 'Please tick each of the member rules.', { rules_ack: 'required' });
  }
  const needsAnkeny = need.ankeny_notice_if_ankeny && (homeLocation === 'Ankeny' || homeLocation === 'Both');
  if (needsAnkeny && body.ankeny_locker_ack !== true) {
    return fail(res, 400, 'Please confirm you’ve read the Ankeny locker note.', { ankeny_locker_ack: 'required' });
  }

  // Same metadata fields as checkout.js, plus where they came from.  Stripe
  // merges metadata, so what checkout recorded stays.
  const now = new Date().toISOString();
  const metadata = {
    tier: to,
    upgraded_from: from,
    upgraded_at: now,
    ...(!sub.metadata?.home_location && { home_location: homeLocation }),
    ...(partner && { locker_partner: partner }),
    // Leaving a shared locker: the partner no longer applies ('' deletes it).
    ...(from === 'half-locker' && to !== 'half-locker' && { locker_partner: '' }),
    ...(need.key_fee_agreed && { key_fee_agreed_at: now }),
    ...(need.rules && { rules_ack: RULES_VERSION, rules_ack_at: now }),
    ...(needsAnkeny && { ankeny_locker_notice_at: now }),
  };

  let updated;
  try {
    console.log('[upgrade] Upgrading', subscriptionId, from, '->', to, 'by:', userEmail, isAdmin ? '(admin)' : '(member)');
    updated = await stripe.subscriptions.update(subscriptionId, {
      items: [{ id: item.id, price: target.id }],
      proration_behavior: 'always_invoice',
      payment_behavior: 'error_if_incomplete',
      metadata,
      expand: ['latest_invoice'],
    });
  } catch (err) {
    console.error('[upgrade] Stripe update refused:', subscriptionId, err.type, err.code, err.message);
    // A card problem: Stripe made no change at all.
    if (err.type === 'StripeCardError' || err.statusCode === 402) {
      return fail(res, 402, 'Your card on file was declined, so your membership was not changed. Please update your card with the shop, or try again later.');
    }
    return fail(res, 500, 'The upgrade didn’t go through, and your membership was not changed. Please try again or contact the shop.');
  }

  const invoice = updated.latest_invoice && typeof updated.latest_invoice === 'object' ? updated.latest_invoice : null;
  const charged = invoice ? invoice.amount_paid : null;

  // Update the row now so the portal shows the new tier straight away.  The
  // customer.subscription.updated webhook writes the same tier, so a failure
  // here heals itself.
  const fields = {
    tier: to,
    renewal_date: renewalDate(updated),
    ...(!member.home_location && { home_location: homeLocation }),
    ...(partner && { locker_partner: partner }),
    ...(from === 'half-locker' && to !== 'half-locker' && { locker_partner: null }),
    ...(need.key_fee_agreed && { key_fee_agreed_at: now }),
  };
  const { error: updErr } = await supabase.from('members').update(fields).eq('id', member.id);
  if (updErr) console.error('[upgrade] members update failed (webhook will retry the tier):', updErr.message);

  // No notification channel exists on the site (no Telegram/email/SMS keys),
  // so this line in the Vercel logs is the record.  Grep for MEMBER UPGRADE.
  console.log('[upgrade] MEMBER UPGRADE', JSON.stringify({
    email: member.email, name: member.name, subscription: subscriptionId,
    from, to, home_location: homeLocation,
    charged_now: charged != null ? money(charged) : 'unknown',
    invoice: invoice?.id || null, at: now,
  }));

  return res.status(200).json({
    success: true,
    tier: to,
    name: TIER_NAMES[to],
    monthly: target.unit_amount,
    charged_now: charged,
    renewal_date: renewalDate(updated),
  });
};
