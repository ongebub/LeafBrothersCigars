const { TIERS, LOCATIONS, KEY_TIERS, getStripe } = require('./_stripe');

// Memberships check out through Stripe since 2026-09-29 -- Square stopped
// taking card-not-present payments on the cigar accounts.  See _stripe.js.

// Format phone to E.164 (+15155550100). Returns null if invalid.
function formatPhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}

// Half Locker is a shared locker, so that tier (and only that tier) has to name
// the locker partner.  Returns the cleaned name, or null if there isn't one.
const PARTNER_MAX = 80;
function cleanPartner(raw) {
  if (typeof raw !== 'string') return null;
  return raw.replace(/\s+/g, ' ').trim().slice(0, PARTNER_MAX).trim() || null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { tier, name, email, phone, home_location, locker_partner, key_fee_agreed, rules_ack, ankeny_locker_ack } = req.body || {};

  if (!TIERS.includes(tier)) return res.status(400).json({ error: 'Invalid tier' });
  const loc = LOCATIONS.find(l => l.toLowerCase() === String(home_location || '').trim().toLowerCase());
  if (!loc) return res.status(400).json({ error: 'home_location is required (Ankeny, Waukee or Both)' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Checkout failed', detail: 'Please enter a valid email address.', fieldErrors: { email: 'invalid' } });
  }
  const e164Phone = formatPhone(phone);
  if (phone && !e164Phone) {
    return res.status(400).json({ error: 'Checkout failed', detail: 'Please enter a valid phone number.', fieldErrors: { phone: 'invalid' } });
  }

  const partner = tier === 'half-locker' ? cleanPartner(locker_partner) : null;
  if (tier === 'half-locker' && !partner) {
    return res.status(400).json({ error: 'Checkout failed', detail: "Please enter your locker partner's full name.", fieldErrors: { locker_partner: 'required' } });
  }

  // Tiers that get a key have to agree to the key-return terms.  Only a real
  // `true` counts -- the checkbox, not a string that happens to be truthy.
  const needsKeyConsent = KEY_TIERS.includes(tier);
  if (needsKeyConsent && key_fee_agreed !== true) {
    return res.status(400).json({ error: 'Checkout failed', detail: 'Please agree to the key return terms.', fieldErrors: { key_fee_agreed: 'required' } });
  }

  // Proof of the signup popups (index.html): which version of the member rules
  // they ticked, and that an Ankeny locker member saw the humidor notice.
  // Recorded, not required -- a page loaded before these popups shipped must
  // still be able to check out.  Only plain values are kept.  The rules go to
  // every tier with lounge access, which is the same list as KEY_TIERS.
  const rulesAck = KEY_TIERS.includes(tier) && typeof rules_ack === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rules_ack) ? rules_ack : null;
  const ankenyAck = /locker/.test(tier) && (loc === 'Ankeny' || loc === 'Both') && ankeny_locker_ack === true;

  let stripe;
  try {
    stripe = getStripe();
  } catch (err) {
    console.error('[checkout] Stripe init error:', err.message);
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    const prices = await stripe.prices.list({ lookup_keys: [tier], active: true, limit: 1 });
    const price = prices.data[0];
    if (!price) {
      console.error('[checkout] No active Stripe price for tier', tier);
      return res.status(500).json({ error: 'Server configuration error' });
    }

    // One Stripe customer per email, so a member who signs up twice is one person.
    const found = await stripe.customers.list({ email, limit: 1 });
    const meta = { tier, home_location: loc };
    const fields = { name, email, metadata: meta, ...(e164Phone && { phone: e164Phone }) };
    const customer = found.data[0]
      ? await stripe.customers.update(found.data[0].id, fields)
      : await stripe.customers.create(fields);

    // The partner and the key agreement belong to this subscription, not to the
    // person: they stay off the customer record so a later signup on another
    // tier can't inherit them.  A tier with nothing extra (Select) sends `meta`.
    const extra = {
      ...(partner && { locker_partner: partner }),
      ...(needsKeyConsent && { key_fee_agreed_at: new Date().toISOString() }),
      ...(rulesAck && { rules_ack: rulesAck, rules_ack_at: new Date().toISOString() }),
      ...(ankenyAck && { ankeny_locker_notice_at: new Date().toISOString() }),
    };
    const subMeta = Object.keys(extra).length ? { ...meta, ...extra } : meta;

    const site = process.env.NEXT_PUBLIC_SITE_URL;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customer.id,
      line_items: [{ price: price.id, quantity: 1 }],
      subscription_data: { metadata: subMeta },
      metadata: subMeta,
      success_url: `${site}/?welcome=1`,
      cancel_url: `${site}/`,
    });

    console.log('[checkout] Session created:', session.id, 'tier:', tier, 'lounge:', loc);
    res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('[checkout] Stripe error:', err.type, err.message);
    res.status(err.statusCode >= 400 && err.statusCode < 500 ? 400 : 500).json({
      error: 'Checkout failed',
      detail: err.message || 'Checkout failed',
    });
  }
};
