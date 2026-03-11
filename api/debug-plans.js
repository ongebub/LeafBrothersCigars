const { SquareClient, SquareEnvironment } = require('square');

const client = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN,
  environment: SquareEnvironment.Production,
});

// Plan ID → tier config
const PLANS = {
  'select':          { planId: 'QAKPMT2OPQMEJ23DPA452PVJ', name: 'Select Member — Monthly',          amount: 1500 },
  'lounge':          { planId: 'OHZPZSZ7TLPVUR6C5JHYSF4J', name: 'Lounge Member — Monthly',           amount: 3900 },
  'lounge-premium':  { planId: 'F5FZK73GAQTRKS5DVG2LRQWY', name: 'Lounge Member Premium — Monthly',   amount: 4900 },
  'half-locker':     { planId: 'BP4MUBLECF4GV6B7GDCHU6DZ', name: 'Half Locker Member — Monthly',      amount: 5900 },
  'locker':          { planId: 'FWREST2ORNNAO3CSPV5XDDMA', name: 'Locker Member — Monthly',           amount: 6900 },
};

module.exports = async function handler(req, res) {
  const action = req.query?.action || req.url?.split('action=')[1] || 'list';

  // GET /api/debug-plans?action=list — show plans and existing variations
  if (action === 'list') {
    const results = {};
    for (const [tier, plan] of Object.entries(PLANS)) {
      try {
        const result = await client.catalog.object.get({
          objectId: plan.planId,
          includeRelatedObjects: true,
        });
        results[tier] = {
          planId: plan.planId,
          type: result.object?.type,
          name: result.object?.subscriptionPlanData?.name,
          variations: (result.relatedObjects || [])
            .filter(r => r.type === 'SUBSCRIPTION_PLAN_VARIATION')
            .map(r => ({
              variationId: r.id,
              name: r.subscriptionPlanVariationData?.name,
              phases: r.subscriptionPlanVariationData?.phases,
            })),
        };
      } catch (err) {
        results[tier] = { error: err.message };
      }
    }
    const body = JSON.stringify(results, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).end(body);
  }

  // GET /api/debug-plans?action=create — create variations for plans that don't have one
  if (action === 'create') {
    const results = {};
    for (const [tier, plan] of Object.entries(PLANS)) {
      try {
        // Check if variation already exists
        const existing = await client.catalog.object.get({
          objectId: plan.planId,
          includeRelatedObjects: true,
        });
        const existingVariation = (existing.relatedObjects || [])
          .find(r => r.type === 'SUBSCRIPTION_PLAN_VARIATION');

        if (existingVariation) {
          results[tier] = {
            status: 'already_exists',
            variationId: existingVariation.id,
            name: existingVariation.subscriptionPlanVariationData?.name,
          };
          continue;
        }

        // Create the variation via raw HTTP to bypass SDK field name conversion
        const rawRes = await fetch('https://connect.squareup.com/v2/catalog/object', {
          method: 'POST',
          headers: {
            'Square-Version': '2026-01-22',
            'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            idempotency_key: `create-var-${tier}-${Date.now()}`,
            object: {
              type: 'SUBSCRIPTION_PLAN_VARIATION',
              id: `#${tier}-monthly`,
              subscription_plan_variation_data: {
                name: plan.name,
                subscription_plan_id: plan.planId,
                phases: [
                  {
                    cadence: 'MONTHLY',
                    pricing: {
                      type: 'STATIC',
                      price_money: {
                        amount: plan.amount,
                        currency: 'USD',
                      },
                    },
                  },
                ],
              },
            },
          }),
        });

        const rawData = await rawRes.json();
        if (!rawRes.ok) {
          results[tier] = {
            status: 'error',
            httpStatus: rawRes.status,
            errors: rawData.errors || rawData,
          };
          continue;
        }

        results[tier] = {
          status: 'created',
          variationId: rawData.catalog_object?.id,
          name: plan.name,
        };
      } catch (err) {
        results[tier] = {
          status: 'error',
          message: err.message,
          errors: err.body?.errors || null,
        };
      }
    }

    const body = JSON.stringify(results, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).end(body);
  }

  res.status(400).json({ error: 'Use ?action=list or ?action=create' });
}
