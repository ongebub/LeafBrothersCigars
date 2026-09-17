const { ACCOUNTS, getClient } = require('./_squareAccounts');
const { BY_SKU, EVENT_DISCOUNT, TAX_PERCENT, LOCATION_KEY } = require('./_ashtonCatalog');

// Passcode for the box-sale page. Set ASHTON_EVENT_PASSCODE in Vercel to change
// it without a deploy. It goes out in the mailing-list email, so it keeps the
// page off the open web -- it is not a security boundary, and this endpoint
// takes money rather than creating an unpaid ticket.
const PASSCODE = (process.env.ASHTON_EVENT_PASSCODE || 'ASHTON17').toUpperCase();

const MAX_LINES = 40;
const MAX_QTY = 20;

// Free with the order, per Chris 2026-09-17: one box gets the rocks glasses,
// two or more also get the ashtray. They ride on the order as zero-priced
// lines so whoever packs the box can see what goes in it.
const GIFT_ONE = 'San Cristobal rocks glasses (free with your box)';
const GIFT_TWO = 'Ashton ashtray (free with two boxes)';

// Format phone to E.164 (+15155550100). Returns null if invalid.
function formatPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}

const round2 = n => Math.round(n * 100) / 100;
const cents = n => BigInt(Math.round(n * 100));

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { passcode, verify, name, phone, email, lines } = req.body || {};

  if (String(passcode || '').trim().toUpperCase() !== PASSCODE) {
    return res.status(401).json({ error: 'Wrong passcode' });
  }

  // The page asks here before unlocking. The code lives in Vercel, never in
  // this repo (which is public), so the gate cannot check it in the browser.
  if (verify) return res.status(200).json({ ok: true });

  const customerName = String(name || '').trim();
  if (customerName.length < 2) {
    return res.status(400).json({ error: 'Need a name for the order' });
  }

  const e164Phone = formatPhone(phone);
  if (!e164Phone) {
    return res.status(400).json({ error: 'Need a 10-digit mobile number' });
  }

  // Email is required here, unlike the staff version. Chris wants the "your
  // boxes are in" notice sent by email rather than phoned, so there is a written
  // record that the customer was told -- and Square's receipt needs it anyway.
  const customerEmail = String(email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customerEmail)) {
    return res.status(400).json({ error: 'Need an email for the receipt' });
  }

  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: 'No boxes on the order' });
  }
  if (lines.length > MAX_LINES) {
    return res.status(400).json({ error: 'Too many different boxes on one order' });
  }

  // Prices are recomputed here from the SKU. Whatever the browser sent for a
  // price is ignored -- this page is on the open internet behind a passcode
  // that goes out by email, so client-side money cannot be trusted at all.
  const lineItems = [];
  let retail = 0;
  let boxes = 0;
  for (const raw of lines) {
    const item = BY_SKU[String(raw && raw.sku)];
    if (!item) return res.status(400).json({ error: `Unknown product: ${raw && raw.sku}` });

    const qty = Number(raw.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      return res.status(400).json({ error: `Bad quantity for ${item.item}` });
    }

    const eventEach = round2(item.box * (1 - EVENT_DISCOUNT));
    retail += item.box * qty;
    boxes += qty;
    lineItems.push({
      name: `${item.line} ${item.item} (box of ${item.n})`,
      quantity: String(qty),
      basePriceMoney: { amount: cents(eventEach), currency: 'USD' },
      note: item.sku,
    });
  }

  const freeLine = label => ({
    name: label,
    quantity: '1',
    basePriceMoney: { amount: 0n, currency: 'USD' },
  });
  if (boxes >= 1) lineItems.push(freeLine(GIFT_ONE));
  if (boxes >= 2) lineItems.push(freeLine(GIFT_TWO));

  retail = round2(retail);
  const subtotal = round2(retail * (1 - EVENT_DISCOUNT));
  const account = ACCOUNTS[LOCATION_KEY];

  let client;
  try {
    client = getClient(LOCATION_KEY);
  } catch (err) {
    console.error('[ashton-checkout] Client init error:', err.message);
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // No Square customer is attached, deliberately: attaching one fires the
  // member Customer Group discount, and this sale is a flat 20% with nothing
  // stacked on top. Contact details ride on the order instead -- a top-level
  // order `note` comes back null from the API (verified 2026-09-12), so the
  // phone goes in the line the shop reads and the rest goes in `metadata`.
  const prettyPhone = e164Phone.slice(2).replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
  const site = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.leafbrotherscigars.com';

  try {
    const linkRequest = {
      idempotencyKey: `ashton-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      order: {
        locationId: account.locationId,
        referenceId: 'ashton-box-sale',
        lineItems,
        taxes: [{ name: 'Iowa Sales Tax', percentage: TAX_PERCENT, scope: 'ORDER' }],
        metadata: {
          source: 'ashton_box_sale',
          customer_name: customerName.slice(0, 200),
          customer_phone: prettyPhone,
          customer_email: customerEmail.slice(0, 200),
          boxes: String(boxes),
        },
      },
      checkoutOptions: {
        redirectUrl: `${site}/ashton?paid=1`,
        askForShippingAddress: false,
        acceptedPaymentMethods: {
          applePay: true,
          googlePay: true,
          cashAppPay: true,
          afterpayClearpay: false,
        },
      },
      prePopulatedData: {
        buyerEmail: customerEmail,
        buyerPhoneNumber: e164Phone,
      },
      paymentNote: `${customerName} ${prettyPhone} — Ashton box sale`,
    };

    console.log('[ashton-checkout] Creating payment link:', JSON.stringify(linkRequest, (_, v) =>
      typeof v === 'bigint' ? v.toString() : v
    ));

    const result = await client.checkout.paymentLinks.create(linkRequest);
    const url = result.paymentLink?.url;
    if (!url) throw new Error('Square returned no checkout URL');

    console.log('[ashton-checkout] Link created:', result.paymentLink.id, 'boxes:', boxes);

    return res.status(200).json({
      url,
      boxes,
      retail,
      subtotal,
    });
  } catch (err) {
    console.error('[ashton-checkout] Square error:', JSON.stringify(err, (_, v) =>
      typeof v === 'bigint' ? v.toString() : v, 2));
    const squareErrors = err.body?.errors || err.errors || [];
    const detail = squareErrors[0]?.detail;
    return res.status(err.statusCode || 500).json({
      error: detail || 'Square would not create the checkout. Nothing was charged.',
    });
  }
};
