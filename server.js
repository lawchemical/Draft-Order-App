import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

// ---------- Config ----------
const SHOP   = process.env.SHOP;
const TOKEN  = process.env.ADMIN_API_TOKEN;
const APIURL = `https://${SHOP}/admin/api/2024-07/graphql.json`;
const ORIGINS = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
const PORT = process.env.PORT || 8080;

// ---------- Redis (optional) ----------
let redis = null;
if (process.env.REDIS_URL) {
  const { createClient } = await import('redis');
  redis = createClient({ url: process.env.REDIS_URL });
  redis.on('error', (e) => console.error('Redis error', e));
  await redis.connect();
}

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(cors({
  origin: (origin, cb) => (!origin || ORIGINS.includes(origin)) ? cb(null, true) : cb(new Error('CORS')),
}));

// ---------- Helpers ----------
async function withBackoff(fn, { tries = 3, baseMs = 250 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (!/rate|429|5\d\d/i.test(String(e?.message || '')) && !e.retryable) break;
      await new Promise(r => setTimeout(r, baseMs * (2 ** i) + Math.random() * 100));
    }
  }
  throw lastErr;
}

async function adminGQL(query, variables) {
  return withBackoff(async () => {
    const r = await fetch(APIURL, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables })
    });
    if (r.status === 429) {
      const e = new Error('429 rate limited'); e.retryable = true; throw e;
    }
    if (!r.ok) {
      const e = new Error(`${r.status} ${r.statusText}`); e.retryable = r.status >= 500; throw e;
    }
    const j = await r.json();
    if (j.errors?.length) throw new Error(j.errors[0].message);
    return j.data;
  });
}

// ---------- Cache ----------
const MEM_TTL_MS = 10 * 60 * 1000;
const memCache = new Map();
const memGet = key => {
  const v = memCache.get(key);
  if (!v || v.exp < Date.now()) return null;
  return v.value;
};
const memSet = (key, value, ttl = MEM_TTL_MS) => memCache.set(key, { value, exp: Date.now() + ttl });

async function cacheGet(key) {
  if (redis) {
    const val = await redis.get(key);
    if (val != null) return JSON.parse(val);
  }
  return memGet(key);
}
async function cacheSet(key, value, ttlSec = 600) {
  if (redis) await redis.set(key, JSON.stringify(value), { EX: ttlSec });
  else memSet(key, value, ttlSec * 1000);
}

async function idemGet(key) {
  return redis ? JSON.parse(await redis.get(`idem:${key}`) || 'null') : memGet(`idem:${key}`);
}
async function idemSet(key, payload, ttlSec = 600) {
  if (redis) await redis.set(`idem:${key}`, JSON.stringify(payload), { EX: ttlSec });
  else memSet(`idem:${key}`, payload, ttlSec * 1000);
}

// ---------- Pricing ----------
const F_MULTIPLIER = 2.06;
const GRADE_UPCHARGE = { A: 0, B: 0, C: 0.08, D: 0.32, E: 0.63, F: 1.06 };

function computeUnitPriceFromF({ fPrice, grade = 'A', cording = false }) {
  const g = grade.toUpperCase();
  const aPrice = (parseFloat(fPrice) || 0) / F_MULTIPLIER;
  let unit = aPrice * (1 + (GRADE_UPCHARGE[g] ?? 0));
  if (cording) unit *= 1.10;
  return Math.round(unit * 100) / 100;
}

async function getVariantPricesBatch(gids) {
  const uniq = [...new Set(gids)];
  const prices = {};
  const missing = [];
  for (const gid of uniq) {
    const cached = await cacheGet(`vprice:${gid}`);
    if (cached != null) prices[gid] = cached;
    else missing.push(gid);
  }
  if (!missing.length) return prices;

  const fields = missing.map((gid, i) => `v${i}: productVariant(id: "${gid}") { id price }`).join('\n');
  const query = `query { ${fields} }`;
  const data = await adminGQL(query, {});
  missing.forEach((gid, i) => {
    const node = data[`v${i}`];
    if (!node) throw new Error(`Variant not found: ${gid}`);
    const priceNum = parseFloat(node.price);
    prices[gid] = priceNum;
    cacheSet(`vprice:${gid}`, priceNum, 600);
  });
  return prices;
}

// ---------- Route ----------
let __debugOnce = false;
app.post('/create-draft-order', async (req, res) => {
  try {
    if (!__debugOnce) {
      __debugOnce = true;
      console.log('[DEBUG one-shot]', {
        origin: req.headers.origin,
        items: (req.body?.items || []).map((it, i) => ({
          i,
          variantId: it?.variantId,
          quantity: it?.quantity,
          unitPriceCents: it?.unitPriceCents,
          grade: it?.grade,
          cording: it?.cording,
          fabricName: it?.fabricName
        }))
      });
    }

    const { items = [], note, tags = [], idempotencyKey } = req.body || {};
    if (!items.length) throw new Error('No items');

    if (idempotencyKey) {
      const exist = await idemGet(idempotencyKey);
      if (exist?.invoiceUrl) return res.json({ invoiceUrl: exist.invoiceUrl });
    }

    const lines = items.map(it => ({
      gid: String(it.variantId).startsWith('gid://')
        ? String(it.variantId)
        : `gid://shopify/ProductVariant/${it.variantId}`,
      quantity: Math.max(1, parseInt(it.quantity, 10) || 1),
      grade: String(it.grade || 'A').toUpperCase(),
      cording: !!it.cording,
      fabricName: it.fabricName || '',
      properties: Array.isArray(it.properties) ? it.properties : [],
      unitPriceCents: Number.isFinite(it.unitPriceCents) ? it.unitPriceCents : null
    }));

    const priceMap = await getVariantPricesBatch(lines.map(l => l.gid));

    const lineItems = lines.map(l => {
      const fPrice   = priceMap[l.gid] ?? 0;
      const computed = computeUnitPriceFromF({ fPrice, grade: l.grade, cording: l.cording });
      const looksFabric =
        !!l.fabricName ||
        (Array.isArray(l.properties) && l.properties.some(p =>
          /^(Fabric|Selected Fabric Name)$/i.test(p?.key || '')
        ));
      const unit = (looksFabric && Number.isFinite(l.unitPriceCents) && l.unitPriceCents > 0)
        ? (l.unitPriceCents / 100)
        : computed;

      console.log('[price]', { gid: l.gid, variant: fPrice, used: unit });

      if (unit <= fPrice) {
        const off = fPrice - unit;
        return {
          variantId: l.gid,
          quantity: l.quantity,
          appliedDiscount: off > 0 ? {
            title: 'DISCOUNT',
            valueType: 'FIXED_AMOUNT',
            value: Number(off.toFixed(2))
          } : null,
          customAttributes: [
            { key: 'Fabric',  value: l.fabricName },
            { key: 'Grade',   value: l.grade },
            { key: 'Cording', value: l.cording ? 'Yes' : 'No' },
            ...l.properties
          ]
        };
      }

      return {
        title: l.fabricName || 'Custom item',
        custom: true,
        quantity: l.quantity,
        originalUnitPrice: Number(unit.toFixed(2)),
        customAttributes: [
          { key: 'Fabric',  value: l.fabricName },
          { key: 'Grade',   value: l.grade },
          { key: 'Cording', value: l.cording ? 'Yes' : 'No' },
          ...l.properties
        ]
      };
    });

    const mutation = `
      mutation($input: DraftOrderInput!){
        draftOrderCreate(input: $input){
          draftOrder { id invoiceUrl }
          userErrors { field message }
        }
      }`;
    const data = await adminGQL(mutation, {
      input: { lineItems, note: note || 'Fabric tool', tags: ['fabric-tool', ...tags] }
    });

    const err = data?.draftOrderCreate?.userErrors?.[0];
    if (err) throw new Error(err.message);

    const invoiceUrl = data?.draftOrderCreate?.draftOrder?.invoiceUrl;
    if (!invoiceUrl) throw new Error('No invoiceUrl returned');

    if (idempotencyKey) await idemSet(idempotencyKey, { invoiceUrl }, 600);
    res.json({ invoiceUrl });
  } catch (e) {
    console.error('create-draft-order error:', e);
    res.status(400).json({ error: e.message });
  }
});

app.get('/healthz', (_, res) => res.send('ok'));
app.listen(PORT, () => console.log(`Draft Order service on :${PORT}`));
