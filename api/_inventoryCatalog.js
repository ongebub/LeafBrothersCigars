// Read-only view of a shop's Square catalog for the inventory count page.
//
// Loads every ITEM (with its variations) once per warm function and keeps it
// for ten minutes.  It only ever calls GET /v2/catalog/list -- nothing in
// this file can change Square.
//
// Barcodes live in the variation's `sku` at both shops, a few in `upc`, so
// both are indexed.  UPC-A comes off some scanners as 13-digit EAN with a
// leading zero, so codes are also indexed with leading zeros stripped.

const { ACCOUNTS } = require('./_squareAccounts');

const SQUARE_VERSION = '2025-01-23';
const TTL_MS = 10 * 60 * 1000;
const cache = {};

function presentAt(obj, locationId) {
  if (!obj) return false;
  if (obj.present_at_all_locations) {
    return !(obj.absent_at_location_ids || []).includes(locationId);
  }
  return (obj.present_at_location_ids || []).includes(locationId);
}

async function listAll(shop) {
  const account = ACCOUNTS[shop];
  const token = process.env[account.tokenEnv];
  if (!token) throw new Error(`Missing env ${account.tokenEnv}`);
  const out = [];
  let cursor = '';
  for (let page = 0; page < 60; page++) {
    const url = 'https://connect.squareup.com/v2/catalog/list?types=ITEM' +
      (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const r = await fetch(url, {
      headers: { Authorization: 'Bearer ' + token, 'Square-Version': SQUARE_VERSION },
    });
    if (!r.ok) throw new Error(`Square catalog list ${r.status}`);
    const j = await r.json();
    out.push(...(j.objects || []));
    cursor = j.cursor || '';
    if (!cursor) break;
  }
  return out;
}

function normCode(s) {
  return String(s || '').replace(/\s+/g, '').toUpperCase();
}

function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

async function loadCatalog(shop) {
  const hit = cache[shop];
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  const locationId = ACCOUNTS[shop].locationId;
  const objects = await listAll(shop);
  const variations = [];
  const byCode = new Map();
  for (const item of objects) {
    const d = item.item_data || {};
    if (item.is_deleted || d.is_archived) continue;
    if (!presentAt(item, locationId)) continue;
    for (const v of d.variations || []) {
      const vd = v.item_variation_data || {};
      if (v.is_deleted || !presentAt(v, locationId)) continue;
      const rec = {
        item_id: item.id,
        variation_id: v.id,
        item_name: d.name || '',
        variation_name: vd.name || '',
        sku: vd.sku || '',
        upc: vd.upc || '',
        price: vd.price_money ? vd.price_money.amount : null,
      };
      rec.tokens = tokens(rec.item_name + ' ' + rec.variation_name);
      variations.push(rec);
      for (const code of [rec.sku, rec.upc]) {
        const c = normCode(code);
        if (!c) continue;
        for (const key of new Set([c, c.replace(/^0+/, '')])) {
          if (!key) continue;
          if (!byCode.has(key)) byCode.set(key, []);
          const list = byCode.get(key);
          if (!list.includes(rec)) list.push(rec);
        }
      }
    }
  }
  const fresh = { at: Date.now(), variations, byCode };
  cache[shop] = fresh;
  return fresh;
}

function publicRec(r) {
  return {
    item_id: r.item_id, variation_id: r.variation_id,
    item_name: r.item_name, variation_name: r.variation_name,
    sku: r.sku, upc: r.upc, price: r.price,
  };
}

async function lookupBarcode(shop, code) {
  const cat = await loadCatalog(shop);
  const c = normCode(code);
  if (!c) return [];
  const found = cat.byCode.get(c) || cat.byCode.get(c.replace(/^0+/, '')) || [];
  return found.map(publicRec);
}

// Catalog barcodes a scanned code is one or two digits off.  A misread still
// passes the barcode's check digit, so this is how one gets caught.
async function nearBarcodes(shop, code, limit = 5) {
  const cat = await loadCatalog(shop);
  const c = normCode(code);
  if (c.length < 8) return [];
  const found = [];
  for (const r of cat.variations) {
    let best = 3;
    for (const raw of [r.sku, r.upc]) {
      const k = normCode(raw);
      if (k.length !== c.length) continue;
      let d = 0;
      for (let i = 0; i < k.length && d < 3; i++) if (k[i] !== c[i]) d++;
      if (d < best) best = d;
    }
    if (best <= 2) found.push({ r, d: best });
  }
  found.sort((a, b) => a.d - b.d);
  return found.slice(0, limit).map((f) => publicRec(f.r));
}

async function findVariation(shop, variationId) {
  const cat = await loadCatalog(shop);
  const r = cat.variations.find((v) => v.variation_id === variationId);
  return r ? publicRec(r) : null;
}

// Words that say nothing about which cigar it is.
const STOP = new Set(['cigar', 'cigars', 'the', 'a', 'of', 'by', 'and', 'single', 'stick', 'sticks']);

function tokenHit(q, candTokens) {
  if (candTokens.includes(q)) return true;
  if (q.length >= 3) return candTokens.some((t) => t.startsWith(q) || (t.length >= 4 && q.startsWith(t)));
  return false;
}

function scoreAll(cat, text) {
  const q = tokens(text).filter((t) => !STOP.has(t));
  if (!q.length) return { q, scored: [] };
  const scored = [];
  for (const r of cat.variations) {
    let hits = 0;
    for (const t of q) if (tokenHit(t, r.tokens)) hits++;
    if (!hits) continue;
    // Tie-break toward the tighter name: fewer leftover words.
    const extra = r.tokens.filter((t) => !q.some((x) => tokenHit(x, [t]))).length;
    scored.push({ r, score: hits / q.length, extra });
  }
  scored.sort((a, b) => b.score - a.score || a.extra - b.extra ||
    (a.r.item_name + a.r.variation_name).localeCompare(b.r.item_name + b.r.variation_name));
  return { q, scored };
}

async function searchByName(shop, text, limit = 15) {
  const cat = await loadCatalog(shop);
  const { scored } = scoreAll(cat, text);
  return scored.filter((s) => s.score >= 0.5).slice(0, limit).map((s) => publicRec(s.r));
}

// Aurora's match for an unknown barcode.  Deliberately strict: it is only
// "confident" when every meaningful word the scanner typed is in exactly one
// variation's name (at least two words), so "Liga" alone, or "Padron 1964"
// with four vitolas, goes to Chris instead.
async function confidentMatch(shop, text) {
  const cat = await loadCatalog(shop);
  const { q, scored } = scoreAll(cat, text);
  const full = scored.filter((s) => s.score === 1);
  if (q.length < 2) {
    return { status: 'needs_chris', note: 'Too few words to be sure; candidates: ' +
      describe(scored.slice(0, 3)) };
  }
  if (full.length === 1) {
    return { status: 'matched_by_aurora', rec: publicRec(full[0].r),
      note: `Every word matched one item: ${full[0].r.item_name} / ${full[0].r.variation_name}` };
  }
  if (full.length > 1) {
    return { status: 'needs_chris', note: `${full.length} items match every word: ` + describe(full.slice(0, 4)) };
  }
  return { status: 'needs_chris', note: scored.length
    ? 'No item matched every word; closest: ' + describe(scored.slice(0, 3))
    : 'Nothing in the catalog matched' };
}

function describe(list) {
  return list.map((s) => `${s.r.item_name} / ${s.r.variation_name}`).join('; ') || 'none';
}

module.exports = { loadCatalog, lookupBarcode, nearBarcodes, findVariation, searchByName, confidentMatch, tokens };
