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

const ADMIN_EMAIL = 'ongebub@gmail.com';

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

  const userEmail = userData.user.email;
  const isAdmin = userEmail === ADMIN_EMAIL;

  const { subscriptionId } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  if (!subscriptionId) {
    return res.status(400).json({ error: 'subscriptionId is required' });
  }

  // Non-admin users can only cancel their own subscription
  if (!isAdmin) {
    const { data: member, error: lookupErr } = await supabase
      .from('members')
      .select('square_subscription_id')
      .eq('email', userEmail)
      .eq('square_subscription_id', subscriptionId)
      .maybeSingle();

    if (lookupErr || !member) {
      console.log('[cancel] Non-admin user', userEmail, 'attempted to cancel subscription', subscriptionId, '— denied');
      return res.status(403).json({ error: 'You can only cancel your own subscription' });
    }
  }

  try {
    console.log('[cancel] Cancelling subscription:', subscriptionId, 'by:', userEmail, isAdmin ? '(admin)' : '(member)');
    await client.subscriptions.cancel({ subscriptionId });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[cancel] Square error:', err.message);
    return res.status(500).json({ error: 'Failed to cancel subscription', detail: err.message });
  }
};
