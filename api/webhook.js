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
  'QAKPMT2OPQMEJ23DPA452PVJ': 'select',
  'OHZPZSZ7TLPVUR6C5JHYSF4J': 'lounge',
  'F5FZK73GAQTRKS5DVG2LRQWY': 'lounge-premium',
  'BP4MUBLECF4GV6B7GDCHU6DZ': 'half-locker',
  'FWREST2ORNNAO3CSPV5XDDMA': 'locker',
};

// Square signs: HMAC-SHA256( webhook_secret, notification_url + raw_body )
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
  console.log('Square webhook received:', type, JSON.stringify(event.data?.object || {}).slice(0, 500));

  try {
    // ── Subscription created (fired automatically by Square Subscription Checkout) ──
    if (type === 'subscription.created') {
      const sub = event.data?.object?.subscription;
      if (!sub) {
        console.error('No subscription object in subscription.created payload');
        return res.status(200).json({ received: true });
      }

      const subscriptionId = sub.id;
      const customerId = sub.customer_id;
      const planVariationId = sub.plan_variation_id;
      const tier = PLAN_TO_TIER[planVariationId] || null;

      console.log('subscription.created:', { subscriptionId, customerId, planVariationId, tier });

      // Try to update existing pending member row (created during checkout)
      const { data, error } = await supabase
        .from('members')
        .update({
          status: 'active',
          square_subscription_id: subscriptionId,
          tier: tier || undefined,
        })
        .eq('square_customer_id', customerId)
        .select();

      if (error) {
        console.error('Supabase update error:', error);
      } else if (!data || data.length === 0) {
        // No pending row found — create one from the Square customer record
        console.log('No pending member row found, creating from Square customer data');
        try {
          const custResult = await client.customers.get({ customerId });
          const customer = custResult.customer;

          const { error: insertErr } = await supabase.from('members').insert({
            name: [customer.givenName, customer.familyName].filter(Boolean).join(' '),
            email: customer.emailAddress,
            phone: customer.phoneNumber,
            tier: tier || customer.referenceId || 'unknown',
            status: 'active',
            join_date: new Date().toISOString().split('T')[0],
            square_customer_id: customerId,
            square_subscription_id: subscriptionId,
          });
          if (insertErr) console.error('Supabase insert error:', insertErr);
          else console.log('Member created from webhook:', customer.emailAddress);
        } catch (custErr) {
          console.error('Error fetching customer for fallback insert:', custErr.message);
        }
      } else {
        console.log('Member activated:', data[0]?.email, 'subscription:', subscriptionId);
      }

    // ── Subscription updated (status change, renewal, etc.) ──
    } else if (type === 'subscription.updated') {
      const sub = event.data?.object?.subscription;
      if (!sub) return res.status(200).json({ received: true });

      const status = sub.status?.toLowerCase() || 'unknown';
      console.log('subscription.updated:', sub.id, 'status:', status);

      const { error } = await supabase
        .from('members')
        .update({
          status,
          renewal_date: sub.charged_through_date || null,
        })
        .eq('square_subscription_id', sub.id);

      if (error) console.error('Supabase update error (subscription.updated):', error);

    // ── Subscription deleted ──
    } else if (type === 'subscription.deleted') {
      const sub = event.data?.object?.subscription;
      if (!sub) return res.status(200).json({ received: true });

      console.log('subscription.deleted:', sub.id);

      const { error } = await supabase
        .from('members')
        .update({ status: 'cancelled' })
        .eq('square_subscription_id', sub.id);

      if (error) console.error('Supabase update error (subscription.deleted):', error);
    }

    res.status(200).json({ received: true });

  } catch (err) {
    console.error('Webhook handler error:', err.message || err);
    res.status(200).json({ received: true, error: err.message });
  }
}
