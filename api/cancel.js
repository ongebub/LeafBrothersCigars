const { SquareClient, SquareEnvironment } = require('square');
const { createClient } = require('@supabase/supabase-js');

const client = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN,
  environment: SquareEnvironment.Production,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify Supabase JWT
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = authHeader.replace('Bearer ', '');
  const { data: userData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !userData?.user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const { subscriptionId } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  if (!subscriptionId) {
    return res.status(400).json({ error: 'subscriptionId is required' });
  }

  try {
    await client.subscriptions.cancel({ subscriptionId });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[cancel] Square error:', err.message);
    return res.status(500).json({ error: 'Failed to cancel subscription', detail: err.message });
  }
};
