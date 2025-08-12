// ---------- Route ----------
let __debugOnce = false; // add this above the route for one-shot logging

app.post('/create-draft-order', async (req, res) => {
  try {
    // One-shot payload echo for debugging
    if (!__debugOnce) {
      __debugOnce = true;
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      const brief = items.map((it, i) => ({
        i,
        variantId: it.variantId,
        quantity: it.quantity,
        unitPriceCents: it.unitPriceCents,
        grade: it.grade,
        cording: it.cording,
        fabricName: it.fabricName,
        props: Array.isArray(it.properties)
          ? it.properties.filter(p =>
              [
                'Grade', 'Cording', 'Selected Fabric Name', 'Fabric',
                '_fabric_price_unit', '_fabric_compare_at', '_fabric_discount_unit'
              ].includes(p?.key)
            )
          : undefined
      }));
      console.log('[DEBUG one-shot] Origin:', req.headers.origin, 'Items:', JSON.stringify(brief));
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
      grade: (it.grade || 'A').toUpperCase(),
      cording: !!it.cording,
      fabricName: it.fabricName || '',
      properties: Array.isArray(it.properties) ? it.properties : [],
      unitPriceCents: Number.isFinite(it.unitPriceCents) ? it.unitPriceCents : null
    }));

    const gids = lines.map(l => l.gid);
    const priceMap = await getVariantPricesBatch(gids); // this is F-grade price per your setup

    const lineItems = lines.map(l => {
      const fPrice = priceMap[l.gid] ?? 0;
      const unit   = computeUnitPriceFromF({ fPrice, grade: l.grade, cording: l.cording }).toFixed(2);

      return {
        variantId: l.gid,
        quantity: l.quantity,
        originalUnitPrice: unit,
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
