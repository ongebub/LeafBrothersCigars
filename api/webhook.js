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

// Verify the webhook signature from Square
function verifySignature(req, body) {
  const signature = req.headers['x-square-hmacsha256-signature'];
  if (!signature || !process.env.SQUARE_WEBHOOK_SECRET) return false;
  const hmac = crypto.createHmac('sha256', process.env.SQUARE_WEBHOOK_SECRET);
  hmac.update(process.env.NEXT_PUBLIC_SITE_URL + '/api/webhook' + body);
  const expected = hmac.digest('base64');
  return signature === expected;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const rawBody = JSON.stringify(req.body);

  // Verify signature in production
  if (process.env.NODE_ENV === 'production') {
    if (!verifySignature(req, rawBody)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const event = req.body;
  const type = event?.type;

  console.log('Square webhook received:', type);

  try {
    // ── Payment completed — store card on file and create subscription ──
    if (type === 'payment.completed') {
      const payment = event.data?.object?.payment;
      if (!payment?.customerId) return res.status(200).json({ received: true });

      const customerId = payment.customerId;

      // Look up the customer to get their tier from referenceId
      const custResult = await client.customers.get({ customerId });
      const tier = custResult.customer.referenceId;
      const plan = PLANS[tier];

      if (!plan) {
        console.error('No matching plan for tier:', tier);
        return res.status(200).json({ received: true });
      }

      // Store the card on file for the customer
      let cardId = null;
      if (payment.cardDetails?.card?.id) {
        cardId = payment.cardDetails.card.id;
      } else if (payment.sourceType === 'CARD' && payment.cardDetails) {
        // Create a card on file from the payment source
        const cardResult = await client.cards.create({
          idempotencyKey: `card-${customerId}-${Date.now()}`,
          sourceId: payment.id,
          card: { customerId },
        });
        cardId = cardResult.card.id;
      }

      if (!cardId) {
        console.error('Could not obtain card ID for subscription');
        return res.status(200).json({ received: true });
      }

      // Create the subscription with the stored card
      const subResult = await client.subscriptions.create({
        idempotencyKey: `sub-${customerId}-${tier}-${Date.now()}`,
        locationId: process.env.SQUARE_LOCATION_ID,
        planVariationId: plan.planId,
        customerId,
        cardId,
        startDate: new Date().toISOString().split('T')[0],
      });

      const subscriptionId = subResult.subscription.id;

      // Update the member record in Supabase
      await supabase
        .from('members')
        .update({
          status: 'active',
          square_subscription_id: subscriptionId,
        })
        .eq('square_customer_id', customerId);

      console.log('Subscription created:', subscriptionId);

    // ── Subscription status changes ──
    } else if (type === 'subscription.updated') {
      const sub = event.data?.object?.subscription;
      if (!sub) return res.status(200).json({ received: true });

      const status = sub.status?.toLowerCase() || 'unknown';
      await supabase
        .from('members')
        .update({
          status,
          renewal_date: sub.chargedThroughDate || null,
        })
        .eq('square_subscription_id', sub.id);

    } else if (type === 'subscription.deleted') {
      const sub = event.data?.object?.subscription;
      if (!sub) return res.status(200).json({ received: true });

      await supabase
        .from('members')
        .update({ status: 'cancelled' })
        .eq('square_subscription_id', sub.id);
    }

    res.status(200).json({ received: true });

  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}
