const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Format phone to E.164 (+15155550100). Returns null if invalid.
function formatPhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { first_name, phone, location, consent, consent_text, terms_agreed, terms_agreed_text } = req.body;

    // Validate both consents
    if (consent !== true) {
      console.log('[sms-signup] Rejected: SMS consent not true');
      return res.status(400).json({ error: 'You must consent to receive text messages.' });
    }
    if (terms_agreed !== true) {
      console.log('[sms-signup] Rejected: terms consent not true');
      return res.status(400).json({ error: 'You must agree to the Terms and Privacy Policy.' });
    }

    // Validate and format phone
    const e164Phone = formatPhone(phone);
    if (!e164Phone) {
      console.log('[sms-signup] Rejected: invalid phone:', phone);
      return res.status(400).json({ error: 'Please enter a valid 10-digit US phone number.' });
    }

    // Validate location
    const validLocations = ['Waukee', 'Ankeny', 'Both'];
    if (!location || !validLocations.includes(location)) {
      console.log('[sms-signup] Rejected: invalid location:', location);
      return res.status(400).json({ error: 'Please select a valid location.' });
    }

    console.log('[sms-signup] Processing:', { phone: e164Phone, location, first_name: first_name || '(none)' });

    // Get IP and user agent
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;
    const userAgent = req.headers['user-agent'] || null;

    // Insert into Supabase
    const { error } = await supabase
      .from('sms_subscribers')
      .insert({
        first_name: first_name || null,
        phone: e164Phone,
        location_preference: location,
        consent: true,
        consent_text: consent_text || null,
        terms_agreed: true,
        terms_agreed_text: terms_agreed_text || null,
        source: 'web_form',
        ip_address: ip,
        user_agent: userAgent,
      });

    if (error) {
      // Handle unique phone conflict gracefully
      if (error.code === '23505') {
        console.log('[sms-signup] Already subscribed:', e164Phone);
        return res.status(200).json({ ok: true, already: true });
      }
      console.error('[sms-signup] Supabase insert error:', error);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }

    console.log('[sms-signup] Subscribed:', e164Phone);
    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('[sms-signup] Unexpected error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
