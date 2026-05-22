# Phase 2: Define — Spec (v2, post-adversarial review)

## Brand tokens (carried from existing index.html)

- Sage palette: `#5C8B6E` / `#4a7a5c` / `#3d6b4f` / `#7aaa8e` / `#eef5f1`
- Cream: `#F5F0E8` / `#ede6d6` / `#f0e9dd`
- Text: `#2c4a38` / `#5a7a68` / `#8aa898`
- Border: `#b8d4c4`, white: `#fefdfb`, error: `#c0392b`
- Fonts: **Playfair Display** (display) + **Jost** (body) via Google Fonts

## Tech stack

- Cloudflare Workers (`nodejs_compat`), Hono v4, JSX SSR (`hono/jsx-renderer`)
- D1 (SQLite) + KV (CACHE, SESSIONS), Workers Assets, Cloudflare Rate Limiting + Cron Triggers
- Email: Resend; Square SDK: `square` v40+; TypeScript

## Security model (post-review hardening)

### CSRF
- Double-submit cookie: server sets `csrf` cookie (random 32 bytes, `Secure; SameSite=Lax`, **NOT** HttpOnly). Every state-changing form/fetch must include the same value in `X-CSRF-Token` header (or `_csrf` form field). Middleware compares; mismatch → 403.
- Excludes: webhook endpoint (signature-authenticated), GET routes.

### Webhook handling (v4 — retry-safe with processing lock)
- Read raw bytes via `request.arrayBuffer()` BEFORE any parse.
- Compute `HMAC-SHA256(notification_url + rawBodyText, signature_key)`, base64-encode.
- Constant-time compare against `x-square-hmacsha256-signature` using Web Crypto subtle.
- Square's signed events use the **exact** subscription `notification_url` that was registered; must match scheme/host/path. Stored as env var.

**Retry-safe dedup**: A naive `INSERT OR IGNORE` ack-and-skips Square's retry of a previously-failed event. Use a three-state model:

```sql
-- Acquire the event with a processing lock (LOCK_TTL = 60s)
INSERT INTO webhook_events (event_id, type, payload_json, locked_at, received_at)
VALUES (?, ?, ?, unixepoch(), unixepoch())
ON CONFLICT(event_id) DO UPDATE SET
  locked_at = unixepoch()
  WHERE webhook_events.processed_at IS NULL
    AND (webhook_events.locked_at IS NULL OR webhook_events.locked_at < unixepoch() - 60)
RETURNING event_id, processed_at, error;
```

Decision tree on the row returned:
- `processed_at IS NOT NULL AND error IS NULL` → already done. Ack 200, skip.
- `processed_at IS NULL` (we acquired the lock) → process. On success: `UPDATE webhook_events SET processed_at=unixepoch(), error=NULL`. On error: `UPDATE webhook_events SET error=?, locked_at=NULL` (allow retry).
- No row returned (concurrent worker holds lock) → ack 200, let Square retry.

Schema update for `webhook_events`: add `locked_at INTEGER`.

### Magic links (v4 — same-browser binding to prevent login CSRF / session fixation)
- **D1 is the authoritative single-use marker.** Token created → row inserted in `magic_links(token_hash PK)`. Consume = `DELETE ... RETURNING *` — atomic, no race regardless of KV consistency.
- Token: 32 random bytes (`crypto.getRandomValues`), base64url. We store `SHA-256(token)` not the token itself.
- TTL: 15 min. Rate-limited per IP and per email.

**Same-browser binding** (fix for login CSRF):
- On `POST /login`: server generates a `init_nonce` (32 random bytes, base64url) and stores `magic_links.init_nonce_hash = SHA-256(init_nonce)`. Sends a cookie `__Host-mlinit` = `init_nonce` (HttpOnly, Secure, SameSite=Strict, Path=/, 15min Max-Age).
- On `GET /auth/magic/:token`:
  1. Lookup token row.
  2. Read `__Host-mlinit` cookie.
  3. If cookie present AND `SHA-256(cookie) === row.init_nonce_hash` → proceed to set session, delete row, delete cookie. (Happy path: same browser that started login.)
  4. If cookie absent or mismatch → render **interstitial confirmation page**: shows "Sign in as `e***@d***.com`?" with a CSRF-protected `POST /auth/magic/confirm` form containing the token. Only on POST do we set the session. This forces an explicit user action and breaks the cross-browser attack.
- After successful session creation: **rotate session id immediately** (defense against fixation if any future flow ever sets session pre-auth).

Schema update for `magic_links`: add `init_nonce_hash TEXT NOT NULL`.

### Sessions (fixed)
- **D1 authoritative** for session lifetime; KV is read-through cache with 60s TTL.
- Logout: delete from D1 first, then bust KV. Cross-region revocation propagates within 60s.
- Session id: 32 random bytes base64url. Cookie `__Host-session`, `HttpOnly; Secure; SameSite=Lax; Path=/`.
- Idle timeout: 30 days rolling.

### Rate limiting
- **Primary**: Cloudflare Workers Rate Limiting binding (atomic, edge-native). Declared in wrangler:
  ```jsonc
  "ratelimits": [
    { "name": "LOGIN_RL",    "namespace_id": "1001", "simple": { "limit": 5,  "period": 60 } },
    { "name": "MAGIC_RL",    "namespace_id": "1002", "simple": { "limit": 10, "period": 60 } },
    { "name": "CART_RL",     "namespace_id": "1003", "simple": { "limit": 60, "period": 60 } },
    { "name": "CHECKOUT_RL", "namespace_id": "1004", "simple": { "limit": 10, "period": 60 } },
    { "name": "REVIEW_RL",   "namespace_id": "1005", "simple": { "limit": 5,  "period": 3600 } },
    { "name": "GIFT_RL",     "namespace_id": "1006", "simple": { "limit": 10, "period": 3600 } }
  ]
  ```
  Worker calls `env.LOGIN_RL.limit({ key: ip })` etc. Atomic at the edge.
- Webhook endpoint NOT rate-limited (signature is the auth).
- Secondary policy via Cloudflare Dashboard "Rate Limiting Rules" for per-account/per-zone defense (max requests/IP across all routes, bot fight mode).
- KV is **not** used for rate limits (no atomic INCR in KV).

### Reviews
- Default `approved=0`. Admin moderates via dashboard route.
- Verified-purchase only: require `order_id` of a paid order containing the product, owned by the reviewer.
- Render via `hono/html` (escape by default). Strip all HTML tags from title/body; allow plain text only.
- 1 review per (user, product) — UNIQUE constraint.

### Webhook ↔ checkout correlation (explicit contract)
- Every Square `CreatePaymentLink` call from our worker sets:
  - `order.reference_id = "{checkout_idempotency_key}"` (max 40 chars)
  - `order.metadata = { fothy_cart_id, fothy_user_id?, fothy_attempt_id }`
- D1 `checkout_attempts.square_order_id` is populated from the CreatePaymentLink response.
- Inbound webhooks for orders/payments lookup checkout_attempts via:
  1. `square_order_id` (preferred, indexed)
  2. `reference_id` (fallback)
- For subscriptions: `subscriptions.square_subscription_id` PK + indexed lookup; correlate via `subscription.customer_id` → `users.square_customer_id`.
- Webhook handler is responsible for the authoritative state transitions; the worker route handler never marks `status=completed` itself.

### Square Customer linking (explicit at checkout)
- **Logged-in buyer**: Before CreatePaymentLink, if `users.square_customer_id` is null, call Square `SearchCustomers` by email; if found, store id; else call `CreateCustomer` with `email_address`, `given_name?`, `family_name?` → store id. Then pass `order.customer_id` in the payment link request so the order belongs to that customer.
- **Guest buyer**: Don't pre-create a customer. Square's hosted checkout collects email and creates a Customer automatically (visible on the resulting order's `customer_id`). Our `customer.created` webhook then matches the customer's email to any existing `users` row; if so, attach `square_customer_id`. If no matching user, leave as guest order.
- This ensures: order history works for any logged-in buyer, object-level auth on `/account/orders/:id` is valid, verified-purchase reviews work.

### Order/checkout integrity
- **Server-side price/availability re-validation at /checkout**: For each cart line, retrieve the `ITEM_VARIATION` from Square Catalog API (bypassing KV cache), confirm `is_archived = false`, `present_at_location_ids` includes our location, and use Square's `price_money` (NOT client's submitted price) when building the Payment Link.
- Reject checkout if any line fails validation; surface user-facing error.
- **Inventory** (v4 — pre + post-payment reconciliation, because Square hosted Checkout does not reserve stock):
  - At `/checkout`: `inventory.batch-retrieve-counts`; reject if `quantity < requested`. This catches the common case (no concurrent buyers).
  - **Post-payment reconciliation** on `payment.updated` (status `COMPLETED`):
    1. Look up inventory counts at moment of payment.
    2. If any line would make count go negative → mark the order as `oversold` in D1, automatically issue a Square Refund for that line (or the whole order if all lines oversold), email the buyer an apology with refund confirmation.
    3. Otherwise: call Square `BatchChangeInventory` with `IN_STOCK → SOLD` adjustment, idempotency key = `square_order_id`. Note: if Square location has "track inventory" enabled on the items, Square decrements automatically; we only adjust if Square isn't doing it. Detect via item config.
  - For press-on nails business which is likely made-to-order, true oversells will be rare; this is defense-in-depth.
- Quantity bounds: max 50/line, max 200/cart total.
- Idempotency key per checkout: `sha256(cart_id + cart_version + user_session)` → stored in D1 `checkout_attempts(idempotency_key PK, status, payment_link_id, created_at)`. Reuse existing link if same key.
- Cart row carries `version INTEGER` incremented on every mutation; checkout snapshots and locks the version.

### /checkout/return
- **UI-only "thank you" page.** Do NOT mark order complete here.
- Reads `order_id` from query but ONLY for display, treats as untrusted.
- Order completion is owned exclusively by `order.created` + `payment.updated` webhooks.
- If webhook hasn't fired yet, page says "Your order is being processed" and polls.

### Authorization (object-level)
- Order detail `/account/orders/:id`: load order via Square API, verify `order.customer_id === user.square_customer_id`; else 404 (not 403 — don't leak existence).
- Subscription mgmt: same — verify `subscription.customer_id === user.square_customer_id` before mutating.
- Gift card redeem: only the buyer or recipient (when implemented) can apply the GAN; for now, simple balance check via Square.

### Gift cards (v4 — webhook-driven activation, idempotent)

**Redemption**: We never handle GAN entry in our UI. Square's hosted Checkout natively supports the buyer entering a Square gift card GAN as a tender at the payment step. Zero work on our side.

**Selling a gift card** — single, idempotent, webhook-driven flow:
1. We create a Catalog `ITEM` named "Gift Card" in Square with several `ITEM_VARIATION`s for common denominations ($25, $50, $100). This is done as a one-time setup during sub-phase 5 via `BatchUpsertCatalogObjects`.
2. Buyer adds to cart + checks out via the normal flow. CreatePaymentLink includes a line item with the gift card variation. Buyer fills in `recipient_email`, `recipient_name`, `sender_name`, `gift_message` via our custom checkout fields, which we pass through `order.metadata`.
3. After payment completes, the `payment.updated` webhook (status `COMPLETED`) fires.
4. Handler: lookup `gift_card_activations(square_order_id PK)`. If row exists → skip (idempotent). Else INSERT row with `status='pending'`.
5. Call Square `CreateGiftCard` → get `gift_card_id` + `GAN`.
6. Call Square `CreateGiftCardActivity({ type: 'ACTIVATE', gift_card_id, gift_card_activity_details: { amount_money: { amount, currency }, order_id: square_order_id }})`.
7. UPDATE `gift_card_activations` SET `status='active'`, `gift_card_id`, `gan`.
8. Send Resend email to `recipient_email` with the GAN, gift message, redemption instructions.

Schema addition:
```sql
CREATE TABLE gift_card_activations (
  square_order_id TEXT PRIMARY KEY,
  square_payment_id TEXT,
  buyer_user_id INTEGER REFERENCES users(id),
  recipient_email TEXT NOT NULL,
  recipient_name TEXT,
  sender_name TEXT,
  gift_message TEXT,
  amount_cents INTEGER NOT NULL,
  gift_card_id TEXT,
  gan TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|active|failed
  error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  activated_at INTEGER
);
CREATE INDEX idx_gc_recipient ON gift_card_activations(recipient_email);
```

The `square_order_id` PRIMARY KEY makes activation idempotent even if the webhook is delivered twice. The `status` field lets us retry failed activations via cron sweep.

### Catalog freshness for checkout
- Two-tier read: KV cache for browse pages (5min stale OK); direct Square API call for checkout validation (always fresh).
- On `catalog.version.updated` webhook: KV bust + warm.
- Stale-while-revalidate at edge for `/product/:id` to absorb traffic spikes, but checkout always force-fresh.

### PII / log redaction
- Helper `redact(obj)` strips:
  - Email → `e***@d***.com` pattern
  - Phone → last 4 only
  - All `Authorization`, `Cookie`, `Square-Webhook-Signature`, `X-Forwarded-For` headers
  - All `access_token`, `card_number`, `cvv`, `password`, `token`, `secret` keys (recursively, case-insensitive)
- All `console.log` of request/response objects goes through `redact()`.

### Abandoned-cart consent
- Cart-email capture requires explicit checkbox: "Email me reminders about my cart (you can unsubscribe anytime)" — default unchecked.
- Persist consent on `carts.consent_at`. No consent → no email.
- Every abandoned-cart email includes unsubscribe link → adds email to `suppression_list` D1 table; future sends skip.

## File structure

```
src/
  index.ts                      # Hono app entry, middleware chain
  routes/
    home.tsx                    # /
    catalog.tsx                 # /catalog, /catalog/:category
    product.tsx                 # /product/:id
    cart.tsx                    # /cart, POST /api/cart/*
    checkout.tsx                # POST /checkout, GET /checkout/return
    auth.tsx                    # /login, GET /auth/magic/:token, POST /logout
    account.tsx                 # /account/*
    subscriptions.tsx           # /subscriptions, POST /subscribe
    giftcards.tsx               # /gift-cards/*
    reviews.tsx                 # POST /product/:id/review
    custom-order.tsx            # /custom-order
    webhooks-square.ts          # POST /api/webhooks/square
    health.ts                   # /health
  lib/
    square.ts                   # Square client wrapper (raw fetch, with redact)
    catalog.ts                  # KV-cached catalog
    cart.ts                     # cart ops (KV anon + D1 persisted) + version
    auth.ts                     # magic-link + session (D1-authoritative)
    money.ts                    # BigInt minor-unit helpers
    crypto.ts                   # token gen + HMAC verify + constant-time
    csrf.ts                     # double-submit cookie middleware
    rate-limit.ts               # in-Worker KV-counter fallback
    email.ts                    # Resend wrapper
    db.ts                       # D1 helpers, prepared statements
    redact.ts                   # PII redaction helper
    webhook.ts                  # signature verify + dedup + dispatch
  views/
    layout.tsx                  # base layout
    components/
      product-card.tsx
      cart-icon.tsx
      flash.tsx
      csrf-input.tsx
  middleware/
    auth.ts                     # session loader
    csrf.ts                     # csrf check
    rate-limit.ts               # in-Worker rate limiter
    log.ts                      # request log w/ redact
public/
  global.css
  /js/cart.js
  favicon.ico
  logo.png
migrations/
  0001_init.sql
package.json
tsconfig.json
wrangler.jsonc
```

## D1 schema (migrations/0001_init.sql)

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  square_customer_id TEXT UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_users_square ON users(square_customer_id);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,             -- SHA-256 of session token; never store raw
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE magic_links (
  token_hash TEXT PRIMARY KEY,
  init_nonce_hash TEXT NOT NULL,         -- SHA-256 of __Host-mlinit cookie value
  email TEXT NOT NULL,
  redirect_to TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_magic_email ON magic_links(email, created_at);
CREATE INDEX idx_magic_expires ON magic_links(expires_at);

CREATE TABLE carts (
  id TEXT PRIMARY KEY,                  -- uuid
  user_id INTEGER REFERENCES users(id),
  email TEXT,
  consent_at INTEGER,                   -- abandoned-cart consent timestamp
  items_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 0,   -- bumped on every mutation
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  discount_code TEXT,
  gift_card_gan TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  abandoned_email_sent_at INTEGER,
  recovered_at INTEGER,
  checked_out_at INTEGER
);
CREATE INDEX idx_carts_email ON carts(email);
CREATE INDEX idx_carts_user ON carts(user_id);
CREATE INDEX idx_carts_recovery ON carts(updated_at, abandoned_email_sent_at, recovered_at, checked_out_at);

CREATE TABLE checkout_attempts (
  idempotency_key TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL,
  cart_version INTEGER NOT NULL,
  user_id INTEGER REFERENCES users(id),
  payment_link_id TEXT,
  payment_link_url TEXT,
  square_order_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|created|completed|cancelled|failed
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_checkout_cart ON checkout_attempts(cart_id);
CREATE INDEX idx_checkout_status ON checkout_attempts(status);

CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,               -- verified-purchase requirement
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title TEXT,
  body TEXT,
  approved INTEGER NOT NULL DEFAULT 0,  -- moderation required
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(product_id, user_id)
);
CREATE INDEX idx_reviews_product ON reviews(product_id, approved);
CREATE INDEX idx_reviews_moderation ON reviews(approved, created_at);

CREATE TABLE webhook_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  square_created_at INTEGER,
  received_at INTEGER NOT NULL DEFAULT (unixepoch()),
  locked_at INTEGER,                     -- processing lock; cleared on completion
  processed_at INTEGER,                  -- success timestamp; presence + null error = done
  error TEXT,                            -- last failure reason (nullable; presence = retryable)
  attempts INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL
);
CREATE INDEX idx_webhooks_type ON webhook_events(type);
CREATE INDEX idx_webhooks_received ON webhook_events(received_at);

CREATE TABLE suppression_list (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  reason TEXT NOT NULL,                 -- 'unsubscribe' | 'bounce' | 'complaint'
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Subscriptions mirror (see Subscriptions section)
CREATE TABLE subscriptions (
  square_subscription_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  square_customer_id TEXT NOT NULL,
  plan_variation_id TEXT NOT NULL,
  status TEXT NOT NULL,
  start_date TEXT NOT NULL,
  next_billing_date TEXT,
  charged_through_date TEXT,
  card_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_subs_user ON subscriptions(user_id);
CREATE INDEX idx_subs_status ON subscriptions(status);
CREATE INDEX idx_subs_customer ON subscriptions(square_customer_id);

-- Gift card activation log (idempotent webhook handling)
CREATE TABLE gift_card_activations (
  square_order_id TEXT PRIMARY KEY,
  square_payment_id TEXT,
  buyer_user_id INTEGER REFERENCES users(id),
  recipient_email TEXT NOT NULL,
  recipient_name TEXT,
  sender_name TEXT,
  gift_message TEXT,
  amount_cents INTEGER NOT NULL,
  gift_card_id TEXT,
  gan TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  activated_at INTEGER
);
CREATE INDEX idx_gc_recipient ON gift_card_activations(recipient_email);

-- Add square_order_id index to checkout_attempts for webhook correlation
CREATE INDEX idx_checkout_square_order ON checkout_attempts(square_order_id);
```

## Wrangler bindings

```jsonc
{
  "name": "fothy",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-21",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "assets": { "directory": "public", "binding": "ASSETS" },
  "d1_databases": [
    { "binding": "DB", "database_name": "fothy", "database_id": "<populated>", "migrations_dir": "migrations" }
  ],
  "kv_namespaces": [
    { "binding": "CACHE", "id": "<populated>" },
    { "binding": "SESSIONS", "id": "<populated>" }
  ],
  "vars": {
    "SQUARE_API_BASE": "https://connect.squareup.com",
    "SQUARE_VERSION": "2026-04-16",
    "SQUARE_LOCATION_ID": "L412VQTRM7RXB",
    "SITE_ORIGIN": "https://fromourhandtoyours.store",
    "WEBHOOK_NOTIFICATION_URL": "https://fromourhandtoyours.store/api/webhooks/square",
    "EMAIL_FROM": "noreply@fromourhandtoyours.store",
    "EMAIL_FROM_NAME": "From Our Hand To Yours"
  },
  "triggers": { "crons": ["0 * * * *", "*/15 * * * *"] }
}
```

Secrets via `wrangler secret put`:
- `SQUARE_ACCESS_TOKEN`
- `SQUARE_WEBHOOK_SIGNATURE_KEY`
- `RESEND_API_KEY`
- `SESSION_HMAC_KEY` (signs session cookie value to detect tampering)

## Subscriptions — full flow (was missing in v1)

### Plan creation (one-time setup; happens during sub-phase 4)
- Currently 0 subscription plans in this Square account. We create 1 example via Square Catalog API:
  - `SUBSCRIPTION_PLAN` named "Press-On Club" with `eligible_item_ids: [<existing ITEM_VARIATION ids>]`.
  - `SUBSCRIPTION_PLAN_VARIATION` child object: `phases: [{ cadence: "MONTHLY", periods: null (open-ended), recurring_price_money: { amount: 3500, currency: "USD" } }]`.
- After creation we store the plan + variation IDs as wrangler `vars` (or fetch dynamically). Per Square docs, the variation_id is what's used in checkout.

### Subscribe (buyer flow)
- Buyer visits `/subscriptions` → sees plan card → click "Subscribe" → POST `/subscribe` with `plan_variation_id`.
- Server creates Payment Link with `order.line_items: [{ catalog_object_id: <subscription_plan_variation_id>, quantity: "1" }]` — Square's hosted Checkout handles card capture + subscription enrollment in one step.
- After Square redirects back: `subscription.created` webhook fires; we mirror into D1 `subscriptions` table.

### Subscriptions mirror table (add to schema)
```sql
CREATE TABLE subscriptions (
  square_subscription_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  square_customer_id TEXT NOT NULL,
  plan_variation_id TEXT NOT NULL,
  status TEXT NOT NULL,                  -- ACTIVE|PAUSED|CANCELED|DEACTIVATED
  start_date TEXT NOT NULL,              -- YYYY-MM-DD
  next_billing_date TEXT,
  charged_through_date TEXT,
  card_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_subs_user ON subscriptions(user_id);
CREATE INDEX idx_subs_status ON subscriptions(status);
CREATE INDEX idx_subs_customer ON subscriptions(square_customer_id);
```

### Pause / Resume / Cancel
- All flow through Square API:
  - Pause: `POST /v2/subscriptions/{id}/pause` with optional `pause_effective_date`
  - Resume: `POST /v2/subscriptions/{id}/resume` with optional `resume_effective_date`
  - Cancel: `POST /v2/subscriptions/{id}/cancel`
- Authorization gate: load Square subscription, assert `subscription.customer_id === user.square_customer_id`, else 404.
- D1 row updates happen via webhook (`subscription.updated`), not synchronously, to avoid drift.

### Webhook events handled
- `subscription.created` → INSERT into D1 `subscriptions`
- `subscription.updated` → UPDATE status / dates / card
- `invoice.published` → notify user (email)
- `invoice.payment_made` → confirmation email
- `invoice.payment_failed` → dunning email + flag in D1
- `payment.updated` (for sub payments) → audit log

### Fallback for "no plans exist"
- The `/subscriptions` route always renders, but if Square API returns 0 active SUBSCRIPTION_PLAN_VARIATION objects, render a friendly "Subscriptions coming soon" page instead of error. This prevents launch-day breakage if the example plan creation fails.

## Route table (re-included; auth + CSRF + rate-limit binding per route)

| Method | Path | Auth | CSRF | Rate Limit | Purpose |
|---|---|:-:|:-:|---|---|
| GET | `/` | – | – | – | Home |
| GET | `/catalog` | – | – | – | All products |
| GET | `/catalog/:category` | – | – | – | Category |
| GET | `/product/:id` | – | – | – | Product detail + reviews |
| POST | `/product/:id/review` | required | ✓ | REVIEW_RL | Submit review (verified-purchase) |
| GET | `/cart` | – | – | – | Cart view |
| POST | `/api/cart/add` | – | ✓ | CART_RL | Add item |
| POST | `/api/cart/update` | – | ✓ | CART_RL | Update qty |
| POST | `/api/cart/remove` | – | ✓ | CART_RL | Remove |
| POST | `/api/cart/discount` | – | ✓ | CART_RL | Apply discount code |
| POST | `/api/cart/email` | – | ✓ | CART_RL | Capture email + consent |
| POST | `/checkout` | – | ✓ | CHECKOUT_RL | Create Payment Link, 303→Square |
| GET | `/checkout/return` | – | – | – | UI thank-you only (does NOT mark order paid) |
| GET | `/login` | – | – | – | Email entry form |
| POST | `/login` | – | ✓ | LOGIN_RL | Send magic link |
| GET | `/auth/magic/:token` | – | – | MAGIC_RL | Consume link, set session |
| POST | `/logout` | required | ✓ | – | Destroy session |
| GET | `/account` | required | – | – | Overview |
| GET | `/account/orders` | required | – | – | Order history (Square) |
| GET | `/account/orders/:id` | required (own only) | – | – | Order detail (404 if not owner) |
| GET | `/account/subscriptions` | required | – | – | List own subs |
| POST | `/account/subscriptions/:id/pause` | required (own only) | ✓ | – | Pause |
| POST | `/account/subscriptions/:id/resume` | required (own only) | ✓ | – | Resume |
| POST | `/account/subscriptions/:id/cancel` | required (own only) | ✓ | – | Cancel |
| GET | `/subscriptions` | – | – | – | Browse subs (graceful "coming soon" if 0 plans) |
| POST | `/subscribe` | required | ✓ | CHECKOUT_RL | Create subscription Payment Link (requires auth so we have Square customer_id) |
| GET | `/gift-cards` | – | – | – | Sell gift card (no redeem UI) |
| POST | `/gift-cards/purchase` | – | ✓ | GIFT_RL | Buy gift card via Payment Link |
| GET | `/custom-order` | – | – | – | Existing intake form (migrated) |
| POST | `/api/webhooks/square` | sig | – | – | Square webhook (signature is auth) |
| GET | `/health` | – | – | – | Health check |
| GET | `/unsubscribe/:token` | – | – | – | Email unsubscribe link (adds to suppression_list) |

## Cron schedule

- `0 * * * *` (hourly): abandoned-cart sweep + suppression cleanup
- `*/15 * * * *` (every 15min): catalog cache refresh fallback + webhook-event garbage collection
