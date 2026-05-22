# Phase 1: Discover — Synthesis

Inline synthesis (orchestrate.sh was hanging). Sources: Square Developer docs + internal patterns + prior Workers/Hono experience.

## Architecture decisions locked in

- **Worker runtime**: Single Hono router. SSR via JSX (`hono/jsx-renderer`). Workers Static Assets for CSS/JS/images only.
- **Catalog cache**: KV keyed `catalog:v{square_version}`. Invalidate via `catalog.version.updated` webhook.
- **Page cache**: Cloudflare Cache API per URL, 5min TTL, bypass for signed-in users.
- **Money**: BigInt minor units everywhere. Display via `(n / 100).toFixed(2)`.
- **Square SDK**: `square` npm package v40+ (fetch-based, Workers-compatible), `nodejs_compat` flag.
- **Webhook events**: Dedup in D1 by `event_id` PK. Verify HMAC-SHA256 over `notificationUrl + rawBody` using Web Crypto, constant-time compare.
- **Auth**: Magic links — 32-byte random, SHA-256 hashed in KV with 15min TTL, single-use. Session via `__Host-session` cookie + KV session record.
- **Customer linking**: `users.square_customer_id` in D1.
- **Subscriptions**: Catalog `SUBSCRIPTION_PLAN` + `SUBSCRIPTION_PLAN_VARIATION` linked to `ITEM_VARIATION`. Subscribe via Payment Link with `subscription_plan_id`.
- **Abandoned cart**: D1 row on email capture; Cloudflare Cron hourly; Resend email; freq cap 1/cart, 1/email/7d.
- **PCI scope**: SAQ-A — Worker never sees card data.
- **Idempotency**: UUID per checkout attempt, scoped to cart in KV.
- **Webhooks**: `order.created`, `order.updated`, `order.fulfillment.updated`, `payment.created`, `payment.updated`, `refund.created`, `refund.updated`, `invoice.payment_made`, `invoice.payment_failed`, `subscription.created`, `subscription.updated`, `customer.created`, `customer.updated`, `inventory.count.updated`, `catalog.version.updated`.

## Open items for Define

- Exact route table
- D1 schema
- Wrangler bindings (D1, KV, secrets, R2?)
- Brand tokens to extract from existing `index.html`
- Error handling / observability strategy
- Cron trigger schedule
