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

module.exports = { TIERS, LOCATIONS, getStripe, normalizeStatus, renewalDate };
