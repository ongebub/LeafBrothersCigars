const { createClient } = require('@supabase/supabase-js');
const { getStripe, normalizeStatus, renewalDate } = require('./_stripe');

// No hyphen in this route's name on purpose: a hyphenated Stripe webhook URL
// failed on the English All Stars site and nobody found out why.

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Signature verification needs the exact bytes Stripe sent, so the body is
// read off the stream rather than through Vercel's JSON parser.
function rawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Create a Supabase Auth user so the member can log in to the portal
async function createAuthUser(email) {
  if (!email) return;
  const { error } = await supabase.auth.admin.createUser({ email, email_confirm: false });
  if (error) console.log('[stripewebhook] Auth user creation skipped or failed:', error.message);
}

// A paid checkout: make sure the member has a row, keyed on email so that an
// existing member moving over from Square keeps their row and history.
async function activateFromCheckout(stripe, session) {
  const sub = await stripe.subscriptions.retrieve(session.subscription);
  const customer = await stripe.customers.retrieve(session.customer);
  const meta = { ...customer.metadata, ...sub.metadata };
  const email = (customer.email || '').trim();

  const fields = {
    status: normalizeStatus(sub.status),
    tier: meta.tier || 'unknown',
    stripe_customer_id: customer.id,
    stripe_subscription_id: sub.id,
    renewal_date: renewalDate(sub),
  };

  const { data: existing, error: findErr } = await supabase
    .from('members').select('id, home_location')
    .ilike('email', email.replace(/[\\%_]/g, '\\$&'))   // _ and % are ILIKE wildcards
    .limit(1);
  if (findErr) throw new Error('members lookup: ' + findErr.message);

  if (existing && existing.length) {
    // Never overwrite a lounge somebody set by hand.
    if (!existing[0].home_location && meta.home_location) fields.home_location = meta.home_location;
    const { error } = await supabase.from('members').update(fields).eq('id', existing[0].id);
    if (error) throw new Error('members update: ' + error.message);
    console.log('[stripewebhook] Member moved to Stripe:', email, sub.id);
  } else {
    const row = {
      ...fields,
      name: customer.name || email,
      email,
      phone: customer.phone || null,
      home_location: meta.home_location || null,
      join_date: new Date().toISOString().split('T')[0],
      terms_agreed_at: new Date(session.created * 1000).toISOString(),
    };
    const { error } = await supabase.from('members').insert(row);
    if (error) throw new Error('members insert: ' + error.message);
    console.log('[stripewebhook] Member created:', email, sub.id);
  }
  await createAuthUser(email);
}

async function syncSubscription(sub) {
  const { error } = await supabase
    .from('members')
    .update({ status: normalizeStatus(sub.status), renewal_date: renewalDate(sub) })
    .eq('stripe_subscription_id', sub.id);
  if (error) throw new Error('members update: ' + error.message);
  console.log('[stripewebhook] Subscription', sub.id, '->', sub.status);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let stripe, event;
  try {
    stripe = getStripe();
    event = stripe.webhooks.constructEvent(
      await rawBody(req),
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[stripewebhook] Rejected:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    const obj = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed':
        if (obj.mode === 'subscription' && obj.subscription) await activateFromCheckout(stripe, obj);
        break;
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await syncSubscription(obj);
        break;
      case 'invoice.paid':
      case 'invoice.payment_failed': {
        // Newer API versions moved the subscription id under parent.
        const subId = obj.parent?.subscription_details?.subscription || obj.subscription;
        if (subId) await syncSubscription(await stripe.subscriptions.retrieve(subId));
        break;
      }
      default:
        console.log('[stripewebhook] Ignored event type:', event.type);
    }
    res.status(200).json({ received: true });
  } catch (err) {
    // A 500 makes Stripe retry, which is what we want when the database blinked.
    console.error('[stripewebhook] Error handling', event.type, event.id, err.message);
    res.status(500).json({ error: 'Handler failed' });
  }
};

module.exports.config = { api: { bodyParser: false } };
