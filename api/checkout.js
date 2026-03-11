const { SquareClient, SquareEnvironment } = require('square');
const { createClient } = require('@supabase/supabase-js');

const client = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN,
  environment: SquareEnvironment.Production,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const PLANS = {
  'select':          { name: 'Select Member',          amount: 1500, planId: 'QAKPMT2OPQMEJ23DPA452PVJ' },
  'lounge':          { name: 'Lounge Member',           amount: 3900, planId: 'OHZPZSZ7TLPVUR6C5JHYSF4J' },
  'lounge-premium':  { name: 'Lounge Member Premium',   amount: 4900, planId: 'F5FZK73GAQTRKS5DVG2LRQWY' },
  'half-locker':     { name: 'Half Locker Member',      amount: 5900, planId: 'BP4MUBLECF4GV6B7GDCHU6DZ' },
  'locker':          { name: 'Locker Member',           amount: 6900, planId: 'FWREST2ORNNAO3CSPV5XDDMA' },
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { tier, name, email, phone, home_location } = req.body;
  const plan = PLANS[tier];
  if (!plan) return res.status(400).json({ error: 'Invalid tier' });

  try {
    // 1. Create or find customer
    const customerResult = await client.customers.create({
      givenName: name.split(' ')[0],
      familyName: name.split(' ').slice(1).join(' '),
      emailAddress: email,
      phoneNumber: phone,
      referenceId: tier, // Store tier so webhook can look it up
    });

    const customerId = customerResult.customer.id;

    // 2. Create a checkout link to collect card details and first payment.
    //    Square subscriptions require a card on file — the subscription itself
    //    is created by the webhook after the customer completes checkout and
    //    their card is stored.
    const checkoutResult = await client.checkout.paymentLinks.create({
      idempotencyKey: `${customerId}-${tier}-${Date.now()}`,
      order: {
        locationId: process.env.SQUARE_LOCATION_ID,
        customerId,
        lineItems: [
          {
            name: `${plan.name} — First Month`,
            quantity: '1',
            basePriceMoney: {
              amount: BigInt(plan.amount),
              currency: 'USD',
            },
          },
        ],
      },
      checkoutOptions: {
        redirectUrl: `${process.env.NEXT_PUBLIC_SITE_URL}/member-welcome`,
        askForShippingAddress: false,
        acceptedPaymentMethods: {
          applePay: true,
          googlePay: true,
          cashAppPay: true,
          afterpayClearpay: false,
        },
      },
    });

    // 3. Insert member into Supabase as pending — the webhook will activate
    //    the subscription and update the record once payment completes
    const today = new Date().toISOString().split('T')[0];
    await supabase.from('members').upsert(
      {
        name,
        email,
        phone,
        tier,
        home_location: home_location || null,
        status: 'pending',
        join_date: today,
        square_customer_id: customerId,
      },
      { onConflict: 'email' }
    );

    res.status(200).json({ url: checkoutResult.paymentLink.url });

  } catch (err) {
    console.error('Square checkout error:', err);
    res.status(500).json({ error: 'Checkout failed', detail: err.message });
  }
}
