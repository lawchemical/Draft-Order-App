# Draft Order Service

Creates Shopify Draft Orders with custom per-line pricing (grade uplift + optional cording +10%).  
Built for Railway. Includes caching, idempotency, batched variant price lookups, and retry.

## Run locally
1. Copy `.env.example` to `.env` and fill values.
2. `npm install`
3. `npm start`
4. `curl http://localhost:8080/healthz` → `ok`

## Deploy (Railway)
- Link repo → set Variables (SHOP, ADMIN_API_TOKEN, ALLOWED_ORIGIN, optional REDIS_URL).
- Deploy. Note public URL for `/create-draft-order`.

## Request shape
POST `/create-draft-order`
```json
{
  "items": [
    { "variantId": 1234567890, "quantity": 2, "fabricName": "Canvas Navy", "grade": "B", "cording": true }
  ],
  "idempotencyKey": "abc123:290101",
  "note": "Fabric tool",
  "tags": ["checkout"]
}
