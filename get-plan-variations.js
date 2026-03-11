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

(async () => {
  for (const [tier, planId] of Object.entries(PLAN_IDS)) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`TIER: ${tier}  |  PLAN ID: ${planId}`);
    console.log('='.repeat(60));

    try {
      // Fetch the plan object with related objects (variations are children)
      const result = await client.catalog.object.get({
        objectId: planId,
        includeRelatedObjects: true,
      });

      const obj = result.object;
      console.log('\nObject type:', obj?.type);
      console.log('Object ID:', obj?.id);

      // Log subscription plan data
      if (obj?.subscriptionPlanData) {
        console.log('\nsubscriptionPlanData:', JSON.stringify(obj.subscriptionPlanData, (_, v) =>
          typeof v === 'bigint' ? v.toString() : v, 2));
      }

      // Log any related objects (these should include the variations)
      if (result.relatedObjects?.length) {
        console.log(`\nRelated objects (${result.relatedObjects.length}):`);
        for (const rel of result.relatedObjects) {
          console.log(`\n  Type: ${rel.type}  |  ID: ${rel.id}`);
          if (rel.subscriptionPlanVariationData) {
            console.log('  subscriptionPlanVariationData:', JSON.stringify(rel.subscriptionPlanVariationData, (_, v) =>
              typeof v === 'bigint' ? v.toString() : v, 2));
          }
          // Log the full object for debugging
          console.log('  Full object:', JSON.stringify(rel, (_, v) =>
            typeof v === 'bigint' ? v.toString() : v, 2));
        }
      } else {
        console.log('\nNo related objects returned');
      }
    } catch (err) {
      console.error(`Error fetching ${tier}:`, err.message);
      if (err.body) console.error('Error body:', JSON.stringify(err.body, null, 2));
    }
  }
})();
