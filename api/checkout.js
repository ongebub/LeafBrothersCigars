const { SquareClient, SquareEnvironment } = require('square');
const client = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN,
  environment: SquareEnvironment.Production,
});

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
  console.log('[checkout] Phone input:', phone, '→ e164:', e164Phone);

  try {
    // 1. Find existing customer by email, or create a new one
    let customerId;
    const searchResult = await client.customers.search({
      query: { filter: { emailAddress: { exact: email } } },
    });
    const existing = searchResult.customers?.[0];

    if (existing) {
      customerId = existing.id;
      console.log('[checkout] Found existing customer:', customerId, 'email:', email);
      // Update referenceId to current tier if not already set
      if (!existing.referenceId) {
        await client.customers.update({ customerId, referenceId: tier });
        console.log('[checkout] Updated customer referenceId to:', tier);
      }
    } else {
      const customerRequest = {
        givenName: name.split(' ')[0],
        familyName: name.split(' ').slice(1).join(' '),
        emailAddress: email,
        referenceId: tier,
      };
      if (e164Phone) customerRequest.phoneNumber = e164Phone;

      const customerResult = await client.customers.create(customerRequest);
      customerId = customerResult.customer.id;
      console.log('[checkout] Customer created:', customerId, 'tier:', tier);
    }

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

    res.status(200).json({ url: checkoutResult.paymentLink.url });

  } catch (err) {
    console.error('Square checkout error:', JSON.stringify(err, null, 2));
    const detail = err.body?.errors?.[0]?.detail || err.message;
    res.status(500).json({ error: 'Checkout failed', detail });
  }
}
