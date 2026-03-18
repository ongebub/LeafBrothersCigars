const { SquareClient, SquareEnvironment } = require('square');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const client = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN,
  environment: SquareEnvironment.Production,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Reverse lookup: plan variation ID → tier slug
const PLAN_TO_TIER = {
  'WXS3UVFGTJ7Z5TOYUSMGX2GE': 'select',
  'TS5DUW65745CEVANPELUKWBY': 'lounge',
  '6YKSAN7WUNPA37ZQZEO7T5NJ': 'lounge-premium',
  'O3R7YN4EPFTZXIXJKAHKJUEC': 'half-locker',
  'H2ELZFYJ35ZOYRQ5BGD36LVL': 'locker',
};

const WEBHOOK_URL = process.env.SQUARE_WEBHOOK_URL || 'https://www.leafbrotherscigars.com/api/webhook';

function verifySignature(signature, body) {
  if (!signature || !process.env.SQUARE_WEBHOOK_SECRET) return false;
  try {
    const hmac = crypto.createHmac('sha256', process.env.SQUARE_WEBHOOK_SECRET);
    hmac.update(WEBHOOK_URL + body);
    const expected = hmac.digest('base64');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Create a Supabase Auth user so the member can log in to the portal
async function createAuthUser(email) {
  if (!email) return;
  try {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      email_confirm: false, // sends invite email with password-set link
    });
    if (error) {
      // Duplicate user is fine — they already have an auth account
      console.log('[webhook] Auth user creation skipped or failed:', error.message);
    } else {
      console.log('[webhook] Auth user created for:', email, 'id:', data.user?.id);
    }
  } catch (err) {
    console.log('[webhook] Auth createUser error (non-fatal):', err.message);
  }
}

// Activate a member in Supabase — shared by both payment and subscription handlers.
// If a row already exists for this square_customer_id, update it to active.
// Otherwise, fetch full details from Square and insert a new row.
async function activateMember(customerId, subscriptionId, tier) {
  // Try to update existing row first
  const { data, error } = await supabase
    .from('members')
    .update({
      status: 'active',
      square_subscription_id: subscriptionId || undefined,
      tier: tier || undefined,
    })
    .eq('square_customer_id', customerId)
    .select();

  if (error) {
    console.error('[webhook] Supabase update error:', error);
    return;
  }

  if (data && data.length > 0) {
    console.log('[webhook] Member activated:', data[0]?.email, 'subscription:', subscriptionId);
    await createAuthUser(data[0]?.email);
    return;
  }

  // No existing row — fetch customer + subscription from Square and insert
  console.log('[webhook] No existing member row, creating from Square data');
  try {
    const custResult = await client.customers.get({ customerId });
    const customer = custResult.customer;

    // Get renewal date from subscription if available
    let renewalDate = null;
    if (subscriptionId) {
      try {
        const subResult = await client.subscriptions.get({ subscriptionId });
        renewalDate = subResult.subscription?.chargedThroughDate || null;
      } catch (subErr) {
        console.log('[webhook] Subscription fetch error (non-fatal):', subErr.message);
      }
    }

    const row = {
      name: [customer.givenName, customer.familyName].filter(Boolean).join(' '),
      email: customer.emailAddress,
      phone: customer.phoneNumber || null,
      tier: tier || customer.referenceId || 'unknown',
      status: 'active',
      join_date: new Date().toISOString().split('T')[0],
      square_customer_id: customerId,
      square_subscription_id: subscriptionId || null,
      renewal_date: renewalDate,
      terms_agreed_at: new Date().toISOString(),
    };

    console.log('[webhook] Inserting new member:', { email: row.email, tier: row.tier });
    const { error: insertErr } = await supabase.from('members').insert(row);
    if (insertErr) {
      console.error('[webhook] Supabase insert error:', insertErr);
    } else {
      console.log('[webhook] Member created from webhook:', row.email);
      await createAuthUser(customer.emailAddress);
    }
  } catch (custErr) {
    console.error('[webhook] Error fetching customer for insert:', custErr.message);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

  // Verify signature in production
  if (process.env.NODE_ENV === 'production') {
    const signature = req.headers['x-square-hmacsha256-signature'];
    if (!verifySignature(signature, rawBody)) {
      console.error('Webhook signature verification failed');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const type = event?.type;
  console.log('[webhook] event type:', type);
  console.log('[webhook] full payload:', JSON.stringify(event, null, 2).slice(0, 2000));

  try {
    // ── Payment events (payment.completed or payment.updated with COMPLETED status) ──
    // Square fires these when the subscription checkout payment succeeds.
    // The subscription may not exist yet at this point, so we activate the
    // member from the payment and let the subscription event update the ID later.
    if (type === 'payment.completed' || type === 'payment.updated') {
      const payment = event.data?.object?.payment;
      console.log('[webhook] payment object keys:', payment ? Object.keys(payment) : 'MISSING');
      console.log('[webhook] payment.status:', payment?.status);
      console.log('[webhook] payment.customer_id:', payment?.customer_id);
      console.log('[webhook] payment.order_id:', payment?.order_id);

      if (!payment) {
        console.log('[webhook] EXIT: no payment object');
        return res.status(200).json({ received: true });
      }

      // Only act on completed payments
      const status = (payment.status || '').toUpperCase();
      if (status !== 'COMPLETED') {
        console.log('[webhook] EXIT: payment status is', status, '— not COMPLETED, skipping');
        return res.status(200).json({ received: true });
      }

      const customerId = payment.customer_id;
      if (!customerId) {
        console.log('[webhook] EXIT: no customer_id on payment');
        return res.status(200).json({ received: true });
      }

      // Look up customer to get tier from referenceId
      console.log('[webhook] Looking up customer:', customerId);
      const custResult = await client.customers.get({ customerId });
      const tier = custResult.customer?.referenceId;
      console.log('[webhook] Customer referenceId (tier):', tier);

      // Check if this customer already has a subscription (may have been created by Square)
      let subscriptionId = null;
      try {
        const subSearch = await client.subscriptions.search({
          query: {
            filter: {
              customerIds: [customerId],
              locationIds: [process.env.SQUARE_LOCATION_ID],
            },
          },
        });
        const activeSub = subSearch.subscriptions?.find(
          s => s.status === 'ACTIVE' || s.status === 'PENDING'
        );
        if (activeSub) {
          subscriptionId = activeSub.id;
          console.log('[webhook] Found existing subscription:', subscriptionId);
        }
      } catch (subErr) {
        console.log('[webhook] Subscription search error (non-fatal):', subErr.message);
      }

      console.log('[webhook] Activating member:', { customerId, subscriptionId, tier });
      await activateMember(customerId, subscriptionId, tier);

    // ── Subscription created (Square fires this after subscription checkout) ──
    } else if (type === 'subscription.created') {
      const sub = event.data?.object?.subscription;
      console.log('[webhook] subscription object:', sub ? { id: sub.id, customer_id: sub.customer_id, plan_variation_id: sub.plan_variation_id, status: sub.status } : 'MISSING');

      if (!sub) {
        console.log('[webhook] EXIT: no subscription object');
        return res.status(200).json({ received: true });
      }

      const subscriptionId = sub.id;
      const customerId = sub.customer_id;
      const tier = PLAN_TO_TIER[sub.plan_variation_id] || null;

      console.log('[webhook] Activating member from subscription.created:', { subscriptionId, customerId, tier });
      await activateMember(customerId, subscriptionId, tier);

    // ── Subscription updated ──
    } else if (type === 'subscription.updated') {
      const sub = event.data?.object?.subscription;
      if (!sub) return res.status(200).json({ received: true });

      const status = sub.status?.toLowerCase() || 'unknown';
      console.log('[webhook] subscription.updated:', sub.id, 'status:', status);

      const { error } = await supabase
        .from('members')
        .update({
          status,
          renewal_date: sub.charged_through_date || null,
        })
        .eq('square_subscription_id', sub.id);

      if (error) console.error('[webhook] Supabase update error:', error);

    // ── Subscription deleted ──
    } else if (type === 'subscription.deleted') {
      const sub = event.data?.object?.subscription;
      if (!sub) return res.status(200).json({ received: true });

      console.log('[webhook] subscription.deleted:', sub.id);

      const { error } = await supabase
        .from('members')
        .update({ status: 'cancelled' })
        .eq('square_subscription_id', sub.id);

      if (error) console.error('[webhook] Supabase update error:', error);

    } else {
      console.log('[webhook] UNHANDLED event type:', type, '— no action taken');
    }

    res.status(200).json({ received: true });

  } catch (err) {
    console.error('[webhook] CAUGHT ERROR:', err.message || err);
    console.error('[webhook] Error stack:', err.stack);
    res.status(200).json({ received: true, error: err.message });
  }
}
