const { SquareClient, SquareEnvironment } = require('square');

const ACCOUNTS = {
  waukee: {
    label: 'Waukee',
    tokenEnv: 'SQUARE_ACCESS_TOKEN_WAUKEE',
    webhookSecretEnv: 'SQUARE_WEBHOOK_SECRET_WAUKEE',
    webhookUrl: 'https://www.leafbrotherscigars.com/api/webhook-waukee',
    locationId: 'X3YPTX6YD3SHQ',
    plans: {
      'select': '4OM6XF4B2GEX73NJRRYK4TOF',
      'lounge': '5JNUPOX5C2QIZASZLZS5TMJV',
      'lounge-premium': 'MMORG7OT4SLP66LB4OBGISJS',
      'half-locker': 'JHT6K3V2ADVVP2LXZJRCUYN6',
      'locker': 'WCL23Y6XZ4V5MOCSKHNKJACF',
    },
  },
  ankeny: {
    label: 'Ankeny',
    tokenEnv: 'SQUARE_ACCESS_TOKEN_ANKENY',
    webhookSecretEnv: 'SQUARE_WEBHOOK_SECRET_ANKENY',
    webhookUrl: 'https://www.leafbrotherscigars.com/api/webhook',
    locationId: 'KGBZ7RVNAWRT8',
    plans: {
      'select': 'WXS3UVFGTJ7Z5TOYUSMGX2GE',
      'lounge': 'TS5DUW65745CEVANPELUKWBY',
      'lounge-premium': '6YKSAN7WUNPA37ZQZEO7T5NJ',
      'half-locker': 'O3R7YN4EPFTZXIXJKAHKJUEC',
      'locker': 'H2ELZFYJ35ZOYRQ5BGD36LVL',
    },
  },
};

const TIER_PRICES = {
  'select': { name: 'Select Member', amount: 1500 },
  'lounge': { name: 'Lounge Member', amount: 3900 },
  'lounge-premium': { name: 'Lounge Member Premium', amount: 4900 },
  'half-locker': { name: 'Half Locker Member', amount: 5900 },
  'locker': { name: 'Locker Member', amount: 6900 },
};

// Build a reverse lookup: plan variation ID → { accountKey, tier }
const PLAN_VARIATION_LOOKUP = {};
for (const [accountKey, account] of Object.entries(ACCOUNTS)) {
  for (const [tier, variationId] of Object.entries(account.plans)) {
    PLAN_VARIATION_LOOKUP[variationId] = { accountKey, tier };
  }
}

/**
 * Normalize a home_location string to an account key ('waukee' or 'ankeny').
 * Accepts label forms like 'Waukee', 'ANKENY', '  ankeny  ', etc.
 */
function resolveAccount(homeLocation) {
  if (!homeLocation || typeof homeLocation !== 'string') {
    throw new Error('home_location is required (Waukee or Ankeny)');
  }
  const normalized = homeLocation.trim().toLowerCase();
  if (ACCOUNTS[normalized]) return normalized;
  // Try matching by label
  for (const [key, account] of Object.entries(ACCOUNTS)) {
    if (account.label.toLowerCase() === normalized) return key;
  }
  throw new Error(`Invalid home_location: "${homeLocation}". Must be Waukee or Ankeny.`);
}

/**
 * Build a Square v44 client for the given account key.
 */
function getClient(accountKey) {
  const account = ACCOUNTS[accountKey];
  if (!account) throw new Error(`Unknown account key: "${accountKey}"`);
  const token = process.env[account.tokenEnv];
  if (!token) throw new Error(`Missing env ${account.tokenEnv}`);
  return new SquareClient({
    token,
    environment: SquareEnvironment.Production,
  });
}

module.exports = {
  ACCOUNTS,
  TIER_PRICES,
  PLAN_VARIATION_LOOKUP,
  resolveAccount,
  getClient,
};
