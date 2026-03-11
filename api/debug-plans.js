const { SquareClient, SquareEnvironment } = require('square');

const client = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN,
  environment: SquareEnvironment.Production,
});

const PLAN_IDS = {
  'select':          'QAKPMT2OPQMEJ23DPA452PVJ',
  'lounge':          'OHZPZSZ7TLPVUR6C5JHYSF4J',
  'lounge-premium':  'F5FZK73GAQTRKS5DVG2LRQWY',
  'half-locker':     'BP4MUBLECF4GV6B7GDCHU6DZ',
  'locker':          'FWREST2ORNNAO3CSPV5XDDMA',
};

module.exports = async function handler(req, res) {
  const results = {};

  for (const [tier, planId] of Object.entries(PLAN_IDS)) {
    try {
      const result = await client.catalog.object.get({
        objectId: planId,
        includeRelatedObjects: true,
      });

      const obj = result.object;
      const entry = {
        objectType: obj?.type,
        objectId: obj?.id,
        subscriptionPlanData: obj?.subscriptionPlanData || null,
        relatedObjects: (result.relatedObjects || []).map(rel => ({
          type: rel.type,
          id: rel.id,
          subscriptionPlanVariationData: rel.subscriptionPlanVariationData || null,
        })),
      };

      results[tier] = entry;
    } catch (err) {
      results[tier] = { error: err.message, body: err.body || null };
    }
  }

  // BigInt-safe JSON serialization
  const body = JSON.stringify(results, (_, v) =>
    typeof v === 'bigint' ? v.toString() : v, 2);

  res.setHeader('Content-Type', 'application/json');
  res.status(200).end(body);
}
