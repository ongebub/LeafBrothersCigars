const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { ACCOUNTS, PLAN_VARIATION_LOOKUP, getClient } = require('./_squareAccounts');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Map Square subscription statuses to our canonical vocabulary:
// active, cancelled, suspended
const STATUS_MAP = {
  'ACTIVE': 'active',
  'PENDING': 'active',
  'CANCELED': 'cancelled',
  'DEACTIVATED': 'cancelled',
  'PAUSED': 'suspended',
};

function normalizeStatus(squareStatus) {
  return STATUS_MAP[(squareStatus || '').toUpperCase()] || 'suspended';
}

function verifySignature(signature, body, account) {
  const secret = process.env[account.webhookSecretEnv];
  if (!signature || !secret) return false;
  try {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(account.webhookUrl + body);
    const expected = hmac.digest('base64');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Parse home_location from Square customer note field (format: "home_location:Ankeny")
function parseHomeLocation(note) {
  if (!note) return null;
  const match = note.match(/home_location:(Ankeny|Waukee|Both)/);
  if (!match) {
    return null;
  }
  return match[1];
}

// Create a Supabase Auth user so the member can log in to the portal
async function createAuthUser(email, tag) {
  if (!email) return;
  try {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      email_confirm: false,
    });
    if (error) {
      console.log(`[${tag}] Auth user creation skipped or failed:`, error.message);
    } else {
      console.log(`[${tag}] Auth user created for:`, email, 'id:', data.user?.id);
    }
  } catch (err) {
    console.log(`[${tag}] Auth createUser error (non-fatal):`, err.message);
  }
}

// Activate a member in Supabase
async function activateMember(client, customerId, subscriptionId, tier, agreedAt, tag) {
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
    console.error(`[${tag}] Supabase update error:`, error);
    return;
  }

  if (data && data.length > 0) {
    console.log(`[${tag}] Member activated:`, data[0]?.email, 'subscription:', subscriptionId);
    await createAuthUser(data[0]?.email, tag);
    return;
  }

  // No existing row — fetch customer + subscription from Square and insert
  console.log(`[${tag}] No existing member row, creating from Square data`);
  try {
    const custResult = await client.customers.get({ customerId });
    const customer = custResult.customer;

    let renewalDate = null;
    if (subscriptionId) {
      try {
        const subResult = await client.subscriptions.get({ subscriptionId });
        renewalDate = subResult.subscription?.chargedThroughDate || null;
      } catch (subErr) {
        console.log(`[${tag}] Subscription fetch error (non-fatal):`, subErr.message);
      }
    }

    const homeLocation = parseHomeLocation(customer.note);

    const row = {
      name: [customer.givenName, customer.familyName].filter(Boolean).join(' '),
      email: customer.emailAddress,
      phone: customer.phoneNumber || null,
      tier: tier || customer.referenceId || 'unknown',
      home_location: homeLocation,
      status: 'active',
      join_date: new Date().toISOString().split('T')[0],
      square_customer_id: customerId,
      square_subscription_id: subscriptionId || null,
      renewal_date: renewalDate,
      terms_agreed_at: agreedAt || new Date().toISOString(),
    };

    console.log(`[${tag}] Inserting new member:`, { email: row.email, tier: row.tier });
    const { error: insertErr } = await supabase.from('members').insert(row);
    if (insertErr) {
      console.error(`[${tag}] Supabase insert error:`, insertErr);
    } else {
      console.log(`[${tag}] Member created from webhook:`, row.email);
      await createAuthUser(customer.emailAddress, tag);
    }
  } catch (custErr) {
    console.error(`[${tag}] Error fetching customer for insert:`, custErr.message);
  }
}

/**
 * Shared webhook handler. Called by the per-account endpoint files.
 */
module.exports = async function handleWebhook(accountKey, req, res) {
  const tag = `webhook:${accountKey}`;
  const account = ACCOUNTS[accountKey];
  if (!account) {
    console.error(`[${tag}] Unknown account key`);
    return res.status(200).json({ received: true });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

  // Verify signature in production
  if (process.env.NODE_ENV === 'production') {
    const signature = req.headers['x-square-hmacsha256-signature'];
    if (!verifySignature(signature, rawBody, account)) {
      console.error(`[${tag}] Webhook signature verification failed`);
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const type = event?.type;
  console.log(`[${tag}] event type:`, type);
  console.log(`[${tag}] full payload:`, JSON.stringify(event, null, 2).slice(0, 2000));

  let client;
  try {
    client = getClient(accountKey);
  } catch (err) {
    console.error(`[${tag}] Client init error:`, err.message);
    return res.status(200).json({ received: true });
  }

  try {
    // ── Payment events ──
    if (type === 'payment.completed' || type === 'payment.updated') {
      const payment = event.data?.object?.payment;
      console.log(`[${tag}] payment object keys:`, payment ? Object.keys(payment) : 'MISSING');
      console.log(`[${tag}] payment.status:`, payment?.status);
      console.log(`[${tag}] payment.customer_id:`, payment?.customer_id);

      if (!payment) {
        console.log(`[${tag}] EXIT: no payment object`);
        return res.status(200).json({ received: true });
      }

      const status = (payment.status || '').toUpperCase();
      if (status !== 'COMPLETED') {
        console.log(`[${tag}] EXIT: payment status is`, status, '— not COMPLETED, skipping');
        return res.status(200).json({ received: true });
      }

      const customerId = payment.customer_id;
      if (!customerId) {
        console.log(`[${tag}] EXIT: no customer_id on payment`);
        return res.status(200).json({ received: true });
      }

      console.log(`[${tag}] Looking up customer:`, customerId);
      const custResult = await client.customers.get({ customerId });
      const tier = custResult.customer?.referenceId;
      console.log(`[${tag}] Customer referenceId (tier):`, tier);

      if (!tier) {
        console.log(`[${tag}] Skipping non-membership payment — no referenceId on customer`, customerId);
        return res.status(200).json({ received: true });
      }

      let subscriptionId = null;
      try {
        const subSearch = await client.subscriptions.search({
          query: {
            filter: {
              customerIds: [customerId],
              locationIds: [account.locationId],
            },
          },
        });
        const activeSub = subSearch.subscriptions?.find(
          s => s.status === 'ACTIVE' || s.status === 'PENDING'
        );
        if (activeSub) {
          subscriptionId = activeSub.id;
          console.log(`[${tag}] Found existing subscription:`, subscriptionId);
        }
      } catch (subErr) {
        console.log(`[${tag}] Subscription search error (non-fatal):`, subErr.message);
      }

      const paymentAgreedAt = payment.created_at || null;
      console.log(`[${tag}] Activating member:`, { customerId, subscriptionId, tier, agreedAt: paymentAgreedAt });
      await activateMember(client, customerId, subscriptionId, tier, paymentAgreedAt, tag);

    // ── Subscription created ──
    } else if (type === 'subscription.created') {
      const sub = event.data?.object?.subscription;
      console.log(`[${tag}] subscription object:`, sub ? { id: sub.id, customer_id: sub.customer_id, plan_variation_id: sub.plan_variation_id, status: sub.status } : 'MISSING');

      if (!sub) {
        console.log(`[${tag}] EXIT: no subscription object`);
        return res.status(200).json({ received: true });
      }

      const subscriptionId = sub.id;
      const customerId = sub.customer_id;
      const lookup = PLAN_VARIATION_LOOKUP[sub.plan_variation_id];
      let tier = lookup?.tier || null;

      if (!tier && customerId) {
        const custResult = await client.customers.get({ customerId });
        if (!custResult.customer?.referenceId) {
          console.log(`[${tag}] Skipping non-membership event (subscription.created) — no referenceId on customer`, customerId);
          return res.status(200).json({ received: true });
        }
        tier = custResult.customer.referenceId;
      } else if (!tier) {
        console.log(`[${tag}] Skipping non-membership event (subscription.created) — unknown plan variation`, sub.plan_variation_id);
        return res.status(200).json({ received: true });
      }

      const subAgreedAt = sub.created_at || null;
      console.log(`[${tag}] Activating member from subscription.created:`, { subscriptionId, customerId, tier, agreedAt: subAgreedAt });
      await activateMember(client, customerId, subscriptionId, tier, subAgreedAt, tag);

    // ── Subscription updated ──
    } else if (type === 'subscription.updated') {
      const sub = event.data?.object?.subscription;
      if (!sub) return res.status(200).json({ received: true });

      if (sub.customer_id) {
        const custResult = await client.customers.get({ customerId: sub.customer_id });
        if (!custResult.customer?.referenceId) {
          console.log(`[${tag}] Skipping non-membership event (subscription.updated) — no referenceId on customer`, sub.customer_id);
          return res.status(200).json({ received: true });
        }
      }

      const status = normalizeStatus(sub.status);
      console.log(`[${tag}] subscription.updated:`, sub.id, 'square status:', sub.status, '→ normalized:', status);

      const { error } = await supabase
        .from('members')
        .update({
          status,
          renewal_date: sub.charged_through_date || null,
        })
        .eq('square_subscription_id', sub.id);

      if (error) console.error(`[${tag}] Supabase update error:`, error);

    } else {
      console.log(`[${tag}] UNHANDLED event type:`, type, '— no action taken');
    }

    res.status(200).json({ received: true });

  } catch (err) {
    console.error(`[${tag}] CAUGHT ERROR:`, err.message || err);
    console.error(`[${tag}] Error stack:`, err.stack);
    res.status(200).json({ received: true, error: err.message });
  }
};
