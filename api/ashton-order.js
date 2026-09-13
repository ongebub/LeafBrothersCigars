const { ACCOUNTS, getClient } = require('./_squareAccounts');
const { BY_SKU, EVENT_DISCOUNT, TAX_PERCENT, LOCATION_KEY } = require('./_ashtonCatalog');

// Staff passcode for the event page. Set ASHTON_EVENT_PASSCODE in Vercel to
// change it without a deploy. This gate exists to keep the public out of a
// staff tool, not as a security boundary -- the endpoint creates unpaid open
// tickets and never takes money.
const PASSCODE = (process.env.ASHTON_EVENT_PASSCODE || 'ASHTON17').toUpperCase();

const MAX_LINES = 40;
const MAX_QTY = 20;

// Format phone to E.164 (+15155550100). Returns null if invalid.
// Same rule as checkout.js so a customer matches across both paths.
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

  const { passcode, name, phone, email, lines } = req.body || {};

  if (String(passcode || '').trim().toUpperCase() !== PASSCODE) {
    return res.status(401).json({ error: 'Wrong passcode' });
  }

  const customerName = String(name || '').trim();
  if (customerName.length < 2) {
    return res.status(400).json({ error: 'Need a name for the ticket' });
  }

  const e164Phone = formatPhone(phone);
  if (!e164Phone) {
    return res.status(400).json({ error: 'Need a 10-digit mobile number' });
  }

  // Email is optional. At a busy event, a customer who will not hand one over
  // should not block the order — the phone is what we actually need to call
  // them when the box lands. Validated only when supplied.
  const customerEmail = String(email || '').trim();
  if (customerEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customerEmail)) {
    return res.status(400).json({ error: 'That email does not look right' });
  }

  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: 'No boxes on the order' });
  }
  if (lines.length > MAX_LINES) {
    return res.status(400).json({ error: 'Too many different boxes on one ticket' });
  }

  // Prices are recomputed here from the SKU. Whatever the browser sent for a
  // price is ignored -- the page is a staff tool on an iPad, but an order that
  // trusts client-side money is an order anyone can rewrite.
  const built = [];
  let retail = 0;
  for (const raw of lines) {
    const item = BY_SKU[String(raw && raw.sku)];
    if (!item) return res.status(400).json({ error: `Unknown product: ${raw && raw.sku}` });

    const qty = Number(raw.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      return res.status(400).json({ error: `Bad quantity for ${item.item}` });
    }

    const eventEach = round2(item.box * (1 - EVENT_DISCOUNT));
    retail += item.box * qty;
    built.push({
      name: `${item.line} ${item.item} (box of ${item.n})`,
      quantity: String(qty),
      basePriceMoney: { amount: cents(eventEach), currency: 'USD' },
      note: item.sku,
    });
  }

  retail = round2(retail);
  const subtotal = round2(retail * (1 - EVENT_DISCOUNT));
  const account = ACCOUNTS[LOCATION_KEY];

  let client;
  try {
    client = getClient(LOCATION_KEY);
  } catch (err) {
    console.error('[ashton-order] Client init error:', err.message);
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // No Square customer is attached, deliberately: the member Customer Group
  // discount fires when one is, and this event is a flat 20% with no
  // additional discounts. See the event README.
  //
  // Contact details therefore have to ride on the order itself. Square silently
  // DROPS a top-level `note` on an order (verified against the live API
  // 2026-09-12 — it comes back null), so the phone goes in the ticket name
  // where the cashier can actually see it, and the full set goes in `metadata`,
  // which does persist.
  const prettyPhone = e164Phone.slice(2).replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
  const ticketName = `${customerName} ${prettyPhone} — Ashton pre-order`;

  try {
    const result = await client.orders.create({
      idempotencyKey: `ashton-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      order: {
        locationId: account.locationId,
        state: 'OPEN',
        ticketName: ticketName.slice(0, 255),
        referenceId: 'ashton-event',
        lineItems: built,
        taxes: [{
          name: 'Iowa Sales Tax',
          percentage: TAX_PERCENT,
          scope: 'ORDER',
        }],
        // The fulfillment is what puts the ticket on the register. An order
        // with no fulfillment is written to Square perfectly well and is
        // simply never displayed by the POS -- verified the hard way on
        // 2026-09-12, twice, with Chris standing at the counter looking at an
        // empty screen. Every ticket the POS shows carries one.
        //
        // It has to be PICKUP with schedule_type ASAP. IN_STORE is what the
        // POS puts on its own tickets but it is not in the public
        // FulfillmentType enum, and SCHEDULED is rejected without a pickup_at
        // that nobody can know -- the boxes land when Ashton ships them.
        // ASAP lets Square compute pickup_at from prep_time_duration instead.
        fulfillments: [{
          type: 'PICKUP',
          state: 'PROPOSED',
          pickupDetails: {
            scheduleType: 'ASAP',
            prepTimeDuration: 'P1D',
            recipient: {
              displayName: customerName.slice(0, 255),
              phoneNumber: e164Phone,
              ...(customerEmail && { emailAddress: customerEmail.slice(0, 255) }),
            },
            note: 'Ashton event pre-order — collect when the box lands',
          },
        }],
        metadata: {
          event: 'ashton-2026-09-17',
          customer_name: customerName.slice(0, 255),
          customer_phone: e164Phone,
          ...(customerEmail && { customer_email: customerEmail.slice(0, 255) }),
        },
      },
    });

    const order = result.order;
    const total = Number(order.totalMoney?.amount ?? 0) / 100;

    console.log('[ashton-order] Created', order.id, ticketName, 'total', total);

    return res.status(200).json({
      ok: true,
      orderId: order.id,
      ticketName,
      retail,
      discount: round2(retail - subtotal),
      subtotal,
      tax: round2(total - subtotal),
      total,
    });
  } catch (err) {
    console.error('[ashton-order] Square error:', JSON.stringify(err, (_, v) =>
      typeof v === 'bigint' ? v.toString() : v));
    const squareErrors = err.body?.errors || err.errors || [];
    const detail = squareErrors[0]?.detail;
    return res.status(err.statusCode || 500).json({
      error: detail || 'Square would not take the order. Write it down and tell Chris.',
    });
  }
};
