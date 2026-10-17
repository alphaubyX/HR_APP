'use strict';

/**
 * The product's own logos (the server owner uploads Broadwing's original artwork once). They live
 * in the database, so updating the app's files never replaces them.
 *   mark        the wing on its own: favicon, phone top bar
 *   horizontal  wing and name side by side: the side menu bar
 *   logo        the full stacked logo: the sign-in page
 * White versions for the blue bars are made in the browser from the same files.
 */

const { bad } = require('../lib/validate');
const { utcNow } = require('../lib/dates');

const SLOTS = ['mark', 'horizontal', 'logo'];
const IMAGE = /^data:(image\/(png|svg\+xml|webp|jpeg));base64,([A-Za-z0-9+/=]+)$/;

async function brandInfo(db) {
  const rows = await db.all("SELECT skey, updated_at FROM platform_settings WHERE skey LIKE 'brand_%'");
  const out = { v: 0 };
  for (const s of SLOTS) {
    const row = rows.find((r) => r.skey === `brand_${s}`);
    out[s] = !!row;
    if (row) out.v = Math.max(out.v, Date.parse(`${row.updated_at}Z`) || 0);
  }
  return out;
}

async function saveBrand(db, slot, dataUrl) {
  if (!SLOTS.includes(slot)) throw bad('Unknown logo.');
  const key = `brand_${slot}`;
  if (!dataUrl) { await db.run('DELETE FROM platform_settings WHERE skey = ?', [key]); return; }
  if (!IMAGE.test(dataUrl) || dataUrl.length > 1500000) throw bad('Upload a PNG, SVG or WebP image under 1 MB (transparent background works best).');
  const row = await db.get('SELECT id FROM platform_settings WHERE skey = ?', [key]);
  if (row) await db.update('platform_settings', { id: row.id }, { value: dataUrl, updated_at: utcNow() });
  else await db.insert('platform_settings', { skey: key, value: dataUrl, updated_at: utcNow() });
}

/** Express handler for /brand/:slot — the uploaded image, or the built-in wing. */
function serveBrand(db, fallbackFile) {
  return async (req, res) => {
    const slot = String(req.params.slot || '').replace(/\.\w+$/, '');
    const row = SLOTS.includes(slot) ? await db.get('SELECT value FROM platform_settings WHERE skey = ?', [`brand_${slot}`]) : null;
    const m = row && row.value && row.value.match(IMAGE);
    res.set('Cache-Control', 'public, max-age=300');
    if (!m) return res.sendFile(fallbackFile);
    res.set('Content-Type', m[1]);
    if (m[1] === 'image/svg+xml') res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.send(Buffer.from(m[3], 'base64'));
  };
}

module.exports = { brandInfo, saveBrand, serveBrand, SLOTS };
