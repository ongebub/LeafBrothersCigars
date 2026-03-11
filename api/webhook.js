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

const PLANS = {
  'select':          { planId: 'QAKPMT2OPQMEJ23DPA452PVJ' },
  'lounge':          { planId: 'OHZPZSZ7TLPVUR6C5JHYSF4J' },
  'lounge-premium':  { planId: 'F5FZK73GAQTRKS5DVG2LRQWY' },
  'half-locker':     { planId: 'BP4MUBLECF4GV6B7GDCHU6DZ' },
  'locker':          { planId: 'FWREST2ORNNAO3CSPV5XDDMA' },
};

// Square signs: HMAC-SHA256( webhook_secret, notification_url + raw_body )
// The notification URL must match exactly what's configured in Square Dashboard.
const WEBHOOK_URL = process.env.SQUARE_WEBHOOK_URL || 'https://www.leafbrotherscigars.com/api/webhook';

function verifySignature(signature, body) {
  if (!signature || !process.env.SQUARE_WEBHOOK_SECRET) return false;
  const hmac = crypto.createHmac('sha256', process.env.SQUARE_WEBHOOK_SECRET);
  hmac.update(WEBHOOK_URL + body);
  const expected = hmac.digest('base64');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Use the raw body string for signature verification — re-stringifying
  // the parsed body may not match what Square signed.
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
  console.log('Square webhook received:', type);

  try {
    // ── Payment completed — look up tier, store card, create subscription ──
    if (type === 'payment.completed') {
      // Square webhook payloads use snake_case field names
      const payment = event.data?.object?.payment;
      if (!payment) {
        console.error('No payment object in webhook payload');
        return res.status(200).json({ received: true });
      }

      const customerId = payment.customer_id;
      if (!customerId) {
        console.error('No customer_id on payment:', payment.id);
        return res.status(200).json({ received: true });
      }

      console.log('Processing payment.completed for customer:', customerId);

      // Look up the customer to get their tier from referenceId
      const custResult = await client.customers.get({ customerId });
      const tier = custResult.customer?.referenceId;
      const plan = tier ? PLANS[tier] : null;

      if (!plan) {
        console.error('No matching plan for tier:', tier, '— customer:', customerId);
        return res.status(200).json({ received: true });
      }

      console.log('Found tier:', tier, 'for customer:', customerId);

      // Get a card on file for the subscription.
      // After a checkout payment, Square stores the card on the customer.
      // List the customer's cards and use the most recent one.
      let cardId = null;
      try {
        const cardsResult = await client.cards.list({ customerId, sortOrder: 'DESC' });
        for await (const card of cardsResult) {
          if (card.enabled !== false) {
            cardId = card.id;
            console.log('Found card on file:', cardId);
            break;
          }
        }
      } catch (cardListErr) {
        console.error('Error listing customer cards:', cardListErr.message);
      }

      // Fallback: try to get card ID from the payment's card_details
      if (!cardId && payment.card_details?.card?.id) {
        cardId = payment.card_details.card.id;
        console.log('Using card from payment details:', cardId);
      }

      // Create the subscription (cardId is optional — without it Square
      // sends the customer an invoice link to pay)
      const subRequest = {
        idempotencyKey: `sub-${customerId}-${tier}-${Date.now()}`,
        locationId: process.env.SQUARE_LOCATION_ID,
        planVariationId: plan.planId,
        customerId,
        startDate: new Date().toISOString().split('T')[0],
      };
      if (cardId) {
        subRequest.cardId = cardId;
      }

      console.log('Creating subscription with:', JSON.stringify(subRequest));

      const subResult = await client.subscriptions.create(subRequest);
      const subscriptionId = subResult.subscription?.id;

      if (!subscriptionId) {
        console.error('Subscription created but no ID returned:', JSON.stringify(subResult));
        return res.status(200).json({ received: true });
      }

      console.log('Subscription created:', subscriptionId);

      // Update the member record in Supabase
      const { data, error } = await supabase
        .from('members')
        .update({
          status: 'active',
          square_subscription_id: subscriptionId,
        })
        .eq('square_customer_id', customerId)
        .select();

      if (error) {
        console.error('Supabase update error:', error);
      } else if (!data || data.length === 0) {
        // No existing row matched — insert a fresh member record.
        // This handles the case where the checkout upsert failed or was skipped.
        console.log('No existing member row found, inserting new record');
        const customer = custResult.customer;
        const { error: insertErr } = await supabase.from('members').insert({
          name: [customer.givenName, customer.familyName].filter(Boolean).join(' '),
          email: customer.emailAddress,
          phone: customer.phoneNumber,
          tier,
          status: 'active',
          join_date: new Date().toISOString().split('T')[0],
          square_customer_id: customerId,
          square_subscription_id: subscriptionId,
        });
        if (insertErr) console.error('Supabase insert error:', insertErr);
        else console.log('Member inserted via webhook fallback');
      } else {
        console.log('Member updated to active:', data[0]?.email);
      }

    // ── Subscription status changes (these payloads also use snake_case) ──
    } else if (type === 'subscription.updated') {
      const sub = event.data?.object?.subscription;
      if (!sub) return res.status(200).json({ received: true });

      const status = sub.status?.toLowerCase() || 'unknown';
      const { error } = await supabase
        .from('members')
        .update({
          status,
          renewal_date: sub.charged_through_date || null,
        })
        .eq('square_subscription_id', sub.id);

      if (error) console.error('Supabase update error (subscription.updated):', error);

    } else if (type === 'subscription.deleted') {
      const sub = event.data?.object?.subscription;
      if (!sub) return res.status(200).json({ received: true });

      const { error } = await supabase
        .from('members')
        .update({ status: 'cancelled' })
        .eq('square_subscription_id', sub.id);

      if (error) console.error('Supabase update error (subscription.deleted):', error);
    }

    res.status(200).json({ received: true });

  } catch (err) {
    console.error('Webhook handler error:', err.message || err);
    // Return 200 to prevent Square from retrying on application errors —
    // a 500 causes Square to retry up to 18 times over 3 days
    res.status(200).json({ received: true, error: err.message });
  }
}
