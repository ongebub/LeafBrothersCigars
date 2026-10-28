// Staff inventory count (/inventory): one endpoint, one action per request.
//
// The passcode is checked in Postgres (inventory.gate), not here: it is
// stored hashed in the database, so it is in neither this public repo nor
// the page.  Every action, including the Square lookups, goes through that
// check first.  The key used is the PUBLISHABLE one, which reaches the
// inventory_* functions and nothing else in the project.
//
// Square is only READ here (catalog list).  Counts are stored for Chris to
// review; nothing on this site pushes them into Square.

const { createClient } = require('@supabase/supabase-js');
const cat = require('./_inventoryCatalog');

const ANON_KEY_NAMES = [
  'SUPABASE_ANON_KEY',
  'SUPABASE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'VITE_SUPABASE_ANON_KEY',
  'PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_KEY',
];
const ANON_KEY_NAME = ANON_KEY_NAMES.find((n) => process.env[n]);
if (!ANON_KEY_NAME) {
  console.error('inventory: no Supabase publishable key in the environment. Set one of: ' +
    ANON_KEY_NAMES.join(', '));
}
const db = createClient(process.env.SUPABASE_URL, ANON_KEY_NAME ? process.env[ANON_KEY_NAME] : null);

const SHOPS = new Set(['waukee', 'ankeny']);

function statusFor(err) {
  if (err.code === '28000') return 401;
  if (err.code === '42501') return 403;
  return 400;
}

async function call(fn, args) {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    const e = new Error(error.message || 'Something went wrong.');
    e.status = statusFor(error);
    throw e;
  }
  return data;
}

function bad(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

function needShop(shop) {
  if (!SHOPS.has(shop)) throw bad('Pick a shop.');
  return shop;
}

function needCount(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 0 || v > 100000) throw bad('Count must be a whole number.');
  return v;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = req.body || {};
  const code = String(body.passcode || '');
  const action = body.action;

  try {
    switch (action) {
      case 'verify':
        return res.json(await call('inventory_verify', { p_code: code }));

      // A scanned or typed barcode -> the Square variation(s) carrying it.
      case 'lookup': {
        await call('inventory_verify', { p_code: code });
        const shop = needShop(body.shop);
        const matches = await cat.lookupBarcode(shop, body.barcode);
        return res.json({ matches });
      }

      // Name search for sticks with no barcode.
      case 'search': {
        await call('inventory_verify', { p_code: code });
        const shop = needShop(body.shop);
        const q = String(body.q || '').trim();
        if (q.length < 2) return res.json({ results: [] });
        return res.json({ results: await cat.searchByName(shop, q) });
      }

      case 'submit': {
        const shop = needShop(body.shop);
        const count = needCount(body.count);
        const how = body.how;
        if (!['scan', 'search', 'unknown'].includes(how)) throw bad('Bad entry type.');
        await call('inventory_verify', { p_code: code });

        const entry = {
          device_id: body.device_id,
          scanner: body.scanner,
          shop,
          section: body.section,
          barcode: body.barcode || null,
          how,
          count,
          is_test: !!body.is_test,
        };

        if (how === 'unknown') {
          entry.typed_text = body.typed_text;
          if (body.photo) entry.photo = body.photo;
        } else {
          // Names come from Square, never from the browser.
          const rec = await cat.findVariation(shop, String(body.variation_id || ''));
          if (!rec) throw bad('That item is not in this shop\'s Square catalog.');
          Object.assign(entry, {
            item_id: rec.item_id, variation_id: rec.variation_id,
            item_name: rec.item_name, variation_name: rec.variation_name,
          });
        }

        let row = await call('inventory_submit', { p_code: code, p_entry: entry });

        // Unknown barcode: the count is already saved.  Now try to work out
        // what it is.  If this part fails the row stays 'pending' and the
        // review script treats it as Needs Chris.
        if (how === 'unknown') {
          try {
            const m = await cat.confidentMatch(shop, entry.typed_text);
            const match = { status: m.status, note: m.note };
            if (m.rec) Object.assign(match, {
              item_id: m.rec.item_id, variation_id: m.rec.variation_id,
              item_name: m.rec.item_name, variation_name: m.rec.variation_name,
            });
            row = await call('inventory_set_match', { p_code: code, p_id: row.id, p_match: match });
          } catch (err) {
            console.error('[inventory] match failed', err.message);
          }
        }
        return res.json({ entry: row });
      }

      case 'mine':
        return res.json({ entries: await call('inventory_mine', {
          p_code: code, p_device: String(body.device_id || ''), p_limit: 25 }) });

      case 'edit':
        return res.json({ entry: await call('inventory_edit', {
          p_code: code, p_device: String(body.device_id || ''), p_id: body.id,
          p_count: body.count == null ? null : needCount(body.count),
          p_section: body.section || null }) });

      case 'delete':
        return res.json(await call('inventory_delete', {
          p_code: code, p_device: String(body.device_id || ''), p_id: body.id }));

      default:
        return res.status(400).json({ error: 'Unknown action.' });
    }
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[inventory]', action, err.message);
    return res.status(status).json({
      error: status >= 500 ? 'Something went wrong. Try again.' : err.message,
    });
  }
};
