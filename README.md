fothy
=====

Custom Cloudflare Workers storefront for From Our Hand To Yours LLC, integrated with Square.

## Architecture

- Cloudflare Workers + Hono + JSX SSR
- D1 (SQLite): users, sessions, carts, orders mirror, reviews, webhook dedup, subscriptions, gift card activations, suppression list, rate limits
- KV (CACHE, SESSIONS): catalog cache, recovery tokens
- Square hosted Checkout for all payments (PCI scope: SAQ-A)
- Square APIs: Catalog, Orders, Customers, Subscriptions, Gift Cards, Webhooks
- Resend for transactional email
- Cloudflare Cron Triggers for abandoned-cart sweep + catalog refresh

## Local development

```bash
npm install
# Apply migrations (one-time, against local SQLite simulator)
CLOUDFLARE_ACCOUNT_ID=... npx wrangler d1 migrations apply fothy --local
# Create a .dev.vars file with secrets for local dev:
#   SQUARE_ACCESS_TOKEN=sandbox-token
#   SQUARE_WEBHOOK_SIGNATURE_KEY=...
#   RESEND_API_KEY=...
npm run dev
```

## Deploy

```bash
# One-time secrets (run interactively):
CLOUDFLARE_ACCOUNT_ID=... npx wrangler secret put SQUARE_ACCESS_TOKEN
CLOUDFLARE_ACCOUNT_ID=... npx wrangler secret put SQUARE_WEBHOOK_SIGNATURE_KEY
CLOUDFLARE_ACCOUNT_ID=... npx wrangler secret put RESEND_API_KEY

# Apply migrations to remote D1:
CLOUDFLARE_ACCOUNT_ID=... npm run db:migrate

# Deploy the worker:
CLOUDFLARE_ACCOUNT_ID=... npm run deploy
```

## Launch checklist

### 1. Square configuration

- [ ] Production access token issued (Square Developer Dashboard → My Apps → Production → Credentials)
- [ ] Production location ID matches `SQUARE_LOCATION_ID` in `wrangler.jsonc` (currently `L412VQTRM7RXB`)
- [ ] Webhook subscription created with URL `https://fromourhandtoyours.store/api/webhooks/square` (set after DNS cutover) and signature key set as the `SQUARE_WEBHOOK_SIGNATURE_KEY` secret
- [ ] Webhook events subscribed:
  - order.created, order.updated, order.fulfillment.updated
  - payment.created, payment.updated
  - refund.created, refund.updated
  - invoice.payment_made, invoice.payment_failed
  - subscription.created, subscription.updated
  - customer.created, customer.updated
  - inventory.count.updated
  - catalog.version.updated
- [ ] At least one Catalog item with `product_type=GIFT_CARD` (or named "Gift Card") added if gift card sales are desired
- [ ] Subscription plan + plan-variation created (one-time) if subscriptions are desired
- [ ] Discount/coupon codes configured in Square Dashboard (Square's hosted checkout renders the coupon entry field; we just pass `enable_coupon: true`)

### 2. Cloudflare resources

- [ ] D1 database `fothy` created (currently `a4302383-d088-41bf-adbe-196e61938683`)
- [ ] KV namespaces `CACHE` and `SESSIONS` created and bound
- [ ] Secrets set (see above)
- [ ] DNS cutover: point `fromourhandtoyours.store` and `www.fromourhandtoyours.store` to Cloudflare, add a Worker route binding to the `fothy` worker
- [ ] Square Online site (the old hosted store) unpublished or DNS no longer points to it
- [ ] Cron triggers active (verified in dashboard → Triggers → Cron)

### 3. Resend

- [ ] Domain verified for `fromourhandtoyours.store` (DKIM/SPF records added in Cloudflare DNS)
- [ ] `EMAIL_FROM` and `EMAIL_FROM_NAME` in `wrangler.jsonc` match a verified sender

### 4. Smoke test pre-launch

- [ ] Sign in via magic link (same browser)
- [ ] Sign in via magic link (different browser — confirmation interstitial appears)
- [ ] Add to cart → checkout → Square hosted page renders with correct prices
- [ ] Webhook receiver shows 200 in logs after a test order (use Square's webhook testing tool)
- [ ] Order appears under `/account/orders` after webhook fires
- [ ] Subscription plan (if configured) appears at `/subscriptions`
- [ ] Gift card purchase → recipient receives GAN email
- [ ] Submit review on a verified-purchase product → goes to moderation queue (`approved=0`)
- [ ] Trigger abandoned-cart cron manually (`wrangler cron trigger '0 * * * *'`) and verify email
- [ ] `/custom-order` displays the legacy intake form unchanged

## Route map

| Path | Method | Auth | Notes |
|---|:-:|:-:|---|
| `/` | GET | – | Home / featured products |
| `/catalog` | GET | – | Browse all |
| `/catalog/:category` | GET | – | Category |
| `/product/:id` | GET | – | Product detail + reviews |
| `/product/:id/review` | POST | ✓ | Submit review (verified-purchase) |
| `/cart` | GET | – | Cart page |
| `/cart/add` | POST | – | Add item |
| `/cart/update` | POST | – | Update qty |
| `/cart/remove` | POST | – | Remove |
| `/cart/email` | POST | – | Capture email for abandoned-cart |
| `/cart/recover/:token` | GET | – | Recover cart from email link |
| `/checkout` | POST | – | Create Payment Link, 303→Square |
| `/checkout/return` | GET | – | UI thank-you (does not mark paid) |
| `/login` | GET / POST | – | Email entry / send magic link |
| `/auth/magic/:token` | GET | – | Consume magic link |
| `/auth/magic/confirm` | POST | – | Cross-browser confirmation |
| `/logout` | POST | ✓ | End session |
| `/account` | GET | ✓ | Overview |
| `/account/orders` | GET | ✓ | Order history (from Square) |
| `/account/orders/:id` | GET | ✓ (own) | Order detail |
| `/account/subscriptions` | GET | ✓ | List + manage |
| `/account/subscriptions/:id/{pause,resume,cancel}` | POST | ✓ (own) | Subscription lifecycle |
| `/subscriptions` | GET | – | Browse plans |
| `/subscriptions/subscribe` | POST | ✓ | Subscribe (creates Payment Link) |
| `/gift-cards` | GET | – | Buy a gift card |
| `/custom-order` | GET | – | Legacy intake form (Workers Assets) |
| `/unsubscribe/:token` | GET | – | Email opt-out |
| `/api/webhooks/square` | POST | sig | Square webhook receiver |
| `/sitemap.xml` | GET | – | Sitemap |
| `/health` | GET | – | Health check |

## Known limitations

- **Gift card recipient capture**: Square's hosted Checkout doesn't let buyers fill recipient email/name/message at the payment page. To collect recipient details, the buyer should be redirected to an intermediate form before checkout (not yet built). For now, recipient metadata is read from `order.metadata.gift_recipient_email` if present.
- **Inventory reservation**: Square hosted Checkout does not reserve stock between Payment Link creation and payment completion. Post-payment reconciliation in the webhook handler can flag oversells (currently logs; refund-on-oversell automation is a follow-up).
- **Review moderation UI**: Reviews default to `approved=0` and require manual approval via a SQL update against D1. A `/admin/reviews` route is a planned addition.

## License

Private.
