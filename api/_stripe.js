const Stripe = require('stripe');

// Memberships moved from Square to Stripe on 2026-09-29: Square stopped
// accepting card-not-present payments on both cigar accounts, so website
// signups and monthly autopay could no longer go through it.  In-store sales
// stay on Square.
//
// Prices are found by lookup_key, which is the site's tier key.  Change a
// price by creating a new one in Stripe with transfer_lookup_key -- never by
// editing this file.
const TIERS = ['select', 'lounge', 'lounge-premium', 'half-locker', 'locker'];
const LOCATIONS = ['Ankeny', 'Waukee', 'Both'];

// Tiers that are handed a door key.  Signing up for one of these means
// agreeing to the key-return terms (see checkout.js).
const KEY_TIERS = ['lounge', 'lounge-premium', 'half-locker', 'locker'];

// What members see.  Same names as the signup buttons on index.html.
const TIER_NAMES = {
  select: 'Select Member',
  lounge: 'Lounge Member',
  'lounge-premium': 'Lounge Member Premium',
  'half-locker': 'Half Locker Member',
  locker: 'Locker Member',
};

// The member-rules version a key tier ticks (index.html RULES_VERSION).  The
// upgrade route insists on exactly this one; bump both together.
const RULES_VERSION = '2026-10-23b';

let client = null;
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
  if (!client) client = new Stripe(process.env.STRIPE_SECRET_KEY);
  return client;
}

// Canonical membership status for the members table: active, cancelled, suspended.
// past_due stays active -- the card failed, Stripe is retrying, and the
// nightly roster applies the 14-day grace rule from actual payments.
const STATUS_MAP = {
  active: 'active',
  trialing: 'active',
  past_due: 'active',
  incomplete: 'suspended',
  paused: 'suspended',
  unpaid: 'suspended',
  canceled: 'cancelled',
  incomplete_expired: 'cancelled',
};

function normalizeStatus(stripeStatus) {
  return STATUS_MAP[stripeStatus] || 'suspended';
}

// current_period_end moved from the subscription onto its items in newer
// Stripe API versions; read either.
function renewalDate(sub) {
  const end = sub?.items?.data?.[0]?.current_period_end || sub?.current_period_end;
  return end ? new Date(end * 1000).toISOString().split('T')[0] : null;
}

// The tier a subscription is actually paying for: the price's lookup_key,
// falling back to the tier recorded in metadata (a price whose lookup_key was
// transferred to a newer price keeps billing, but no longer carries the key).
function tierOf(sub) {
  const key = sub?.items?.data?.[0]?.price?.lookup_key;
  if (TIERS.includes(key)) return key;
  const meta = sub?.metadata?.tier;
  return TIERS.includes(meta) ? meta : null;
}

module.exports = { TIERS, LOCATIONS, KEY_TIERS, TIER_NAMES, RULES_VERSION, getStripe, normalizeStatus, renewalDate, tierOf };
