const { TIERS, LOCATIONS, getStripe } = require('./_stripe');

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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { tier, name, email, phone, home_location } = req.body || {};

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

    const site = process.env.NEXT_PUBLIC_SITE_URL;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customer.id,
      line_items: [{ price: price.id, quantity: 1 }],
      subscription_data: { metadata: meta },
      metadata: meta,
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
