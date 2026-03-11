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
  'select':          { name: 'Select Member',          amount: 1500, planId: 'WXS3UVFGTJ7Z5TOYUSMGX2GE' },
  'lounge':          { name: 'Lounge Member',           amount: 3900, planId: 'TS5DUW65745CEVANPELUKWBY' },
  'lounge-premium':  { name: 'Lounge Member Premium',   amount: 4900, planId: '6YKSAN7WUNPA37ZQZEO7T5NJ' },
  'half-locker':     { name: 'Half Locker Member',      amount: 5900, planId: 'O3R7YN4EPFTZXIXJKAHKJUEC' },
  'locker':          { name: 'Locker Member',           amount: 6900, planId: 'H2ELZFYJ35ZOYRQ5BGD36LVL' },
};

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

  const { tier, name, email, phone, home_location } = req.body;
  const plan = PLANS[tier];
  if (!plan) return res.status(400).json({ error: 'Invalid tier' });

  const e164Phone = formatPhone(phone);

  try {
    // 1. Create or find customer
    const customerRequest = {
      givenName: name.split(' ')[0],
      familyName: name.split(' ').slice(1).join(' '),
      emailAddress: email,
      referenceId: tier,
    };
    if (e164Phone) customerRequest.phoneNumber = e164Phone;

    const customerResult = await client.customers.create(customerRequest);

    const customerId = customerResult.customer.id;
    console.log('Customer created:', customerId, 'tier:', tier);

    // 2. Create a subscription checkout payment link.
    //    Square's Subscription Plan Checkout handles everything:
    //    collects card details, creates the subscription, and starts
    //    recurring billing — no separate order or webhook flow needed.
    const linkRequest = {
      idempotencyKey: `${customerId}-${tier}-${Date.now()}`,
      quickPay: {
        name: `${plan.name} — First Month`,
        priceMoney: {
          amount: BigInt(plan.amount),
          currency: 'USD',
        },
        locationId: process.env.SQUARE_LOCATION_ID,
      },
      checkoutOptions: {
        subscriptionPlanId: plan.planId,
        redirectUrl: `${process.env.NEXT_PUBLIC_SITE_URL}/?welcome=1`,
        acceptedPaymentMethods: {
          applePay: true,
          googlePay: true,
          cashAppPay: true,
          afterpayClearpay: false,
        },
      },
      prePopulatedData: {
        buyerEmail: email,
        ...(e164Phone && { buyerPhoneNumber: e164Phone }),
      },
    };

    console.log('Creating payment link:', JSON.stringify(linkRequest, (_, v) =>
      typeof v === 'bigint' ? v.toString() : v
    ));

    const checkoutResult = await client.checkout.paymentLinks.create(linkRequest);

    console.log('Payment link created:', checkoutResult.paymentLink?.url);

    // 3. Insert member into Supabase as pending — the subscription.created
    //    webhook will update status to active with the subscription ID
    const today = new Date().toISOString().split('T')[0];
    const { error: insertErr } = await supabase.from('members').insert({
      name,
      email,
      phone,
      tier,
      home_location: home_location || null,
      status: 'pending',
      join_date: today,
      square_customer_id: customerId,
    });
    if (insertErr) console.error('Supabase insert error:', insertErr);

    res.status(200).json({ url: checkoutResult.paymentLink.url });

  } catch (err) {
    console.error('Square checkout error:', JSON.stringify(err, null, 2));
    const detail = err.body?.errors?.[0]?.detail || err.message;
    res.status(500).json({ error: 'Checkout failed', detail });
  }
}
