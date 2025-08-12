/**
 * Draft Order Service — scalable edition
 * - Batch variant lookups
 * - In-memory cache (optional Redis)
 * - Idempotency (with TTL)
 * - Exponential backoff on Admin API
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

// ---------- Config ----------
const SHOP   = process.env.SHOP;                 // your-store.myshopify.com
const TOKEN  = process.env.ADMIN_API_TOKEN;      // Admin API token
const APIURL = `https://${SHOP}/admin/api/2024-07/graphql.json`;
const ORIGINS = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
const PORT = process.env.PORT || 8080;

// Optional Redis (set REDIS_URL to enable)
let redis = null;
if (process.env.REDIS_URL) {
  const { createClient } = await import('redis');
  redis = createClient({ url: process.env.REDIS_URL });
  redis.on('error', (e) => console.error('Redis error', e));
  await redis.connect();
}

// ---------- Utilities ----------
const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(cors({
  origin: (origin, cb) => (!origin || ORIGINS.includes(origin)) ? cb(null, true) : cb(new Error('CORS')),
}));

// small helper for backoff
async function withBackoff(fn, { tries = 3, baseMs = 250 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      // Retry only on 429/5xx-ish
      const msg = String(e?.message || '');
      if (!/rate|429|5\d\d/i.test(msg) && !e.retryable) break;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i) + Math.floor(Math.random()*100)));
    }
  }
  throw lastErr;
}

// ---------- Admin GraphQL ----------
async function adminGQL(query, variables) {
  return withBackoff(async () => {
    const r = await fetch(APIURL, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables })
    });
    if (r.status === 429) {
      const e = new Error('429 rate limited');
      e.retryable = true;
      throw e;
    }
    if (!r.ok) {
      const e = new Error(`${r.status} ${r.statusText}`);
      e.retryable = r.status >= 500;
      throw e;
    }
    const j = await r.json();
    if (j.errors?.length) throw new Error(j.errors[0].message);
    return j.data;
  });
}

// ---------- Price Cache (in-memory + optional Redis) ----------
const MEM_TTL_MS = 10 * 60 * 1000; // 10 min
const memCache = new Map(); // key -> { value, exp }
function memGet(key) {
  const v = memCache.get(key);
  if (!v) return null;
  if (v.exp < Date.now()) { memCache.delete(key); return null; }
  return v.value;
}
function memSet(key, value, ttl = MEM_TTL_MS) {
  memCache.set(key, { value, exp: Date.now() + ttl });
}

// get/set cache with optional Redis
async function cacheGet(key) {
  if (redis) {
    const val = await redis.get(key);
    if (val != null) return JSON.parse(val);
  }
  return memGet(key);
}
async function cacheSet(key, value, ttlSec = 600) {
  if (redis) {
    await redis.set(key, JSON.stringify(value), { EX: ttlSec });
  } else {
    memSet(key, value, ttlSec * 1000);
  }
}

// ---------- Idempotency ----------
async function idemGet(key) {
  return redis ? JSON.parse(await redis.get(`idem:${key}`) || 'null') : memGet(`idem:${key}`);
}
async function idemSet(key, payload, ttlSec = 600) {
  if (redis) await redis.set(`idem:${key}`, JSON.stringify(payload), { EX: ttlSec });
  else memSet(`idem:${key}`, payload, ttlSec * 1000);
}

// ---------- Pricing ----------
function computeUnitPrice({ basePrice, grade='A', cording=false }) {
  const perc = { A:0, B:.10, C:.20, D:.30, E:.40 }[(grade||'A').toUpperCase()] ?? 0;
  let u = basePrice * (1 + perc);
  if (cording) u *= 1.10;
  return Math.round(u * 100) / 100;
}

// Batch fetch variant prices (unique GIDs)
async function getVariantPricesBatch(gids = []) {
  const uniq = [...new Set(gids)];
  const prices = {};

  // Check cache first
  const missing = [];
  for (const gid of uniq) {
    const cached = await cacheGet(`vprice:${gid}`);
    if (cached != null) prices[gid] = cached;
    else missing.push(gid);
  }
  if (!missing.length) return prices;

  // Build one batched query
  const fields = missing.map((gid, i) => `v${i}: productVariant(id: "${gid}") { id price }`).join('\n');
  const query = `query { ${fields} }`;

  const data = await adminGQL(query, {});
  // Map results back
  missing.forEach((gid, i) => {
    const node = data[`v${i}`];
    if (!node) throw new Error(`Variant not found: ${gid}`);
    const priceNum = parseFloat(node.price);
    prices[gid] = priceNum;
    cacheSet(`vprice:${gid}`, priceNum, 600); // 10 min
  });

  return prices;
}

// ---------- Route ----------
app.post('/create-draft-order', async (req, res) => {
  try {
    const { items = [], note, tags = [], idempotencyKey } = req.body || {};
    if (!items.length) throw new Error('No items');

    // Idempotency check
    if (idempotencyKey) {
      const exist = await idemGet(idempotencyKey);
      if (exist?.invoiceUrl) return res.json({ invoiceUrl: exist.invoiceUrl });
    }

    // Normalize to GIDs, collect for batch lookup
    const lines = items.map(it => ({
      gid: String(it.variantId).startsWith('gid://')
        ? String(it.variantId)
        : `gid://shopify/ProductVariant/${it.variantId}`,
      quantity: Math.max(1, parseInt(it.quantity, 10) || 1),
      grade: (it.grade || 'A').toUpperCase(),
      cording: !!it.cording,
      fabricName: it.fabricName || '',
      properties: Array.isArray(it.properties) ? it.properties : []
    }));

    const gids = lines.map(l => l.gid);
    const priceMap = await getVariantPricesBatch(gids);

    // Build lineItems with authoritative server-side price
    const lineItems = lines.map(l => ({
      variantId: l.gid,
      quantity: l.quantity,
      originalUnitPrice: computeUnitPrice({ basePrice: priceMap[l.gid], grade: l.grade, cording: l.cording }).toFixed(2),
      customAttributes: [
        { key: 'Fabric',  value: l.fabricName },
        { key: 'Grade',   value: l.grade },
        { key: 'Cording', value: l.cording ? 'Yes' : 'No' },
        ...l.properties
      ]
    }));

    // Create draft order (with backoff)
    const mutation = `
      mutation($input: DraftOrderInput!){
        draftOrderCreate(input: $input){
          draftOrder { id invoiceUrl }
          userErrors { field message }
        }
      }`;
    const data = await adminGQL(mutation, { input: { lineItems, note: note || 'Fabric tool', tags: ['fabric-tool', ...tags] } });
    const err = data?.draftOrderCreate?.userErrors?.[0];
    if (err) throw new Error(err.message);

    const invoiceUrl = data?.draftOrderCreate?.draftOrder?.invoiceUrl;
    if (!invoiceUrl) throw new Error('No invoiceUrl returned');

    if (idempotencyKey) await idemSet(idempotencyKey, { invoiceUrl }, 600); // 10 min
    res.json({ invoiceUrl });
  } catch (e) {
    console.error('create-draft-order error:', e);
    res.status(400).json({ error: e.message });
  }
});

app.get('/healthz', (_, res) => res.send('ok'));
app.listen(PORT, () => console.log(`Draft Order service on :${PORT}`));
