const { ACCOUNTS, TIER_PRICES, resolveAccount, getClient } = require('./_squareAccounts');

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

  // Validate tier
  const tierInfo = TIER_PRICES[tier];
  if (!tierInfo) return res.status(400).json({ error: 'Invalid tier' });

  // Resolve account from home_location
  let accountKey;
  try {
    accountKey = resolveAccount(home_location);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const account = ACCOUNTS[accountKey];
  const planVariationId = account.plans[tier];
  if (!planVariationId) {
    return res.status(400).json({ error: `Tier "${tier}" not available at ${account.label}` });
  }

  // Build Square client for the selected location's account
  let client;
  try {
    client = getClient(accountKey);
  } catch (err) {
    console.error('[checkout] Client init error:', err.message);
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const e164Phone = formatPhone(phone);
  console.log('[checkout] Phone input:', phone, '→ e164:', e164Phone);
  console.log('[checkout] Account:', accountKey, 'location:', account.locationId, 'plan:', planVariationId);

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
      const updates = { customerId, note: `home_location:${home_location}` };
      if (!existing.referenceId) updates.referenceId = tier;
      await client.customers.update(updates);
      console.log('[checkout] Updated customer:', { referenceId: updates.referenceId || '(unchanged)', note: updates.note });
    } else {
      const customerRequest = {
        givenName: name.split(' ')[0],
        familyName: name.split(' ').slice(1).join(' '),
        emailAddress: email,
        referenceId: tier,
        note: `home_location:${home_location}`,
      };
      if (e164Phone) customerRequest.phoneNumber = e164Phone;

      const customerResult = await client.customers.create(customerRequest);
      customerId = customerResult.customer.id;
      console.log('[checkout] Customer created:', customerId, 'tier:', tier);
    }

    // 2. Create a subscription checkout payment link
    const linkRequest = {
      idempotencyKey: `${customerId}-${tier}-${Date.now()}`,
      quickPay: {
        name: `${tierInfo.name} — First Month`,
        priceMoney: {
          amount: BigInt(tierInfo.amount),
          currency: 'USD',
        },
        locationId: account.locationId,
      },
      checkoutOptions: {
        subscriptionPlanId: planVariationId,
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
    console.error('[checkout] Square error:', JSON.stringify(err, null, 2));
    const squareErrors = err.body?.errors || err.errors || [];
    const statusCode = err.statusCode || 500;

    const fieldErrors = {};
    let detail = err.message || 'Checkout failed';
    for (const e of squareErrors) {
      detail = e.detail || detail;
      const field = (e.field || '').toLowerCase();
      if (field.includes('phone')) fieldErrors.phone = e.detail;
      else if (field.includes('email')) fieldErrors.email = e.detail;
      else if (field.includes('given_name') || field.includes('family_name')) fieldErrors.name = e.detail;
    }

    res.status(statusCode >= 400 && statusCode < 500 ? 400 : 500).json({
      error: 'Checkout failed',
      detail,
      fieldErrors: Object.keys(fieldErrors).length > 0 ? fieldErrors : undefined,
    });
  }
}
