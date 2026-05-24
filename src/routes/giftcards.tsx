import { Hono } from 'hono';
import { html } from 'hono/html';
import { Layout } from '../views/layout';
import { csrfToken } from '../lib/csrf';
import { getCatalog } from '../lib/catalog';
import { squareFetch } from '../lib/square';
import { sha256Hex } from '../lib/crypto';
import { formatMoneyCents } from '../lib/money';
import { consume } from '../lib/rate-limit';
import type { Env, HonoVars } from '../types';

const gifts = new Hono<{ Bindings: Env; Variables: HonoVars }>();

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const RL_GIFT_IP = { name: 'gift-ip', limit: 10, periodSec: 3600 };

/** GET /gift-cards — standalone gift page removed; gifts live inline on /subscriptions#gift. */
gifts.get('/', (c) => c.redirect('/subscriptions#gift', 301));

/** POST /gift-cards/purchase — creates a one-shot Payment Link with recipient metadata. */
gifts.post('/purchase', async (c) => {
  const form = await c.req.parseBody();
  const variationId = String(form.variation_id ?? '');
  const recipientEmail = String(form.recipient_email ?? '').trim().toLowerCase();
  const recipientName = String(form.recipient_name ?? '').trim().slice(0, 120);
  const senderName = String(form.sender_name ?? '').trim().slice(0, 120);
  const giftMessage = String(form.gift_message ?? '').trim().slice(0, 500);

  if (!/^[A-Z0-9]{16,32}$/.test(variationId)) {
    return c.redirect('/gift-cards?error=invalid_amount', 303);
  }
  if (!EMAIL_RE.test(recipientEmail)) {
    return c.redirect('/gift-cards?error=invalid_email', 303);
  }

  // Verify the variation belongs to a real gift card item (defense-in-depth).
  const snap = await getCatalog(c.env);
  const valid = snap.items.some((it) => /gift\s*card/i.test(it.name) && it.variations.some((v) => v.id === variationId));
  if (!valid) {
    return c.redirect('/gift-cards?error=invalid_amount', 303);
  }

  const ip = c.req.header('cf-connecting-ip') ?? '0.0.0.0';
  const rl = await consume(c.env, RL_GIFT_IP, ip);
  if (!rl.allowed) {
    return c.redirect('/gift-cards?error=rate_limited', 303);
  }

  const idempotencyKey = (await sha256Hex(`gc|${variationId}|${recipientEmail}|${crypto.randomUUID()}`)).slice(0, 40);
  const redirectUrl = `${c.env.SITE_ORIGIN}/checkout/return`;

  try {
    const resp = await squareFetch<{ payment_link?: { url: string } }>(c.env, '/v2/online-checkout/payment-links', {
      method: 'POST',
      idempotencyKey,
      body: {
        order: {
          location_id: c.env.SQUARE_LOCATION_ID,
          reference_id: idempotencyKey,
          line_items: [
            { catalog_object_id: variationId, quantity: '1' },
          ],
          metadata: {
            fothy_kind: 'gift_card',
            gift_recipient_email: recipientEmail,
            gift_recipient_name: recipientName,
            gift_sender_name: senderName,
            gift_message: giftMessage,
          },
        },
        checkout_options: {
          redirect_url: redirectUrl,
          ask_for_shipping_address: false,
          allow_tipping: false,
          enable_coupon: false,
          enable_loyalty: false,
        },
        pre_populated_data: {
          buyer_email: c.get('user_id') ? undefined : undefined, // Could prefill if user logged in
        },
      },
    });
    if (!resp.payment_link?.url) return c.redirect('/gift-cards?error=checkout', 303);
    return c.redirect(resp.payment_link.url, 303);
  } catch (err) {
    console.warn('giftcard.purchase.failed', { error: err instanceof Error ? err.message : String(err) });
    return c.redirect('/gift-cards?error=checkout', 303);
  }
});

/** POST /gift-cards/gift — Gift a Set or Gift a Subscription (from /subscriptions#gift) */
gifts.post('/gift', async (c) => {
  const form = await c.req.parseBody();
  const kind = String(form.kind ?? '').trim();
  const tier = String(form.tier ?? '').trim();
  const commitment = String(form.commitment ?? '').trim();
  const senderName = String(form.sender_name ?? '').trim().slice(0, 120);
  const senderEmail = String(form.sender_email ?? '').trim().toLowerCase();
  const recipientName = String(form.recipient_name ?? '').trim().slice(0, 120);
  const recipientEmail = String(form.recipient_email ?? '').trim().toLowerCase();
  const deliveryDate = String(form.delivery_date ?? '').trim().slice(0, 32);
  const message = String(form.message ?? '').trim().slice(0, 500);
  const ship = {
    street: String(form.ship_street ?? '').trim().slice(0, 160),
    apt: String(form.ship_apt ?? '').trim().slice(0, 60),
    city: String(form.ship_city ?? '').trim().slice(0, 80),
    state: String(form.ship_state ?? '').trim().slice(0, 2).toUpperCase(),
    zip: String(form.ship_zip ?? '').trim().slice(0, 12),
  };

  if (kind !== 'set' && kind !== 'subscription') {
    return c.redirect('/subscriptions?error=invalid_gift#gift', 303);
  }
  if (tier !== 'classic' && tier !== 'luxe') {
    return c.redirect('/subscriptions?error=invalid_gift#gift', 303);
  }
  if (!EMAIL_RE.test(senderEmail) || !EMAIL_RE.test(recipientEmail)) {
    return c.redirect('/subscriptions?error=invalid_email#gift', 303);
  }
  if (!senderName || !recipientName) {
    return c.redirect('/subscriptions?error=missing_fields#gift', 303);
  }
  if (kind === 'subscription' && commitment !== '3' && commitment !== '6') {
    return c.redirect('/subscriptions?error=invalid_gift#gift', 303);
  }
  if (kind === 'set' && (!ship.street || !ship.city || !ship.state || !ship.zip)) {
    return c.redirect('/subscriptions?error=ship_required#gift', 303);
  }

  // Price table — matches the marketing copy on /subscriptions and design.
  const priceCents = (() => {
    if (kind === 'set') return tier === 'luxe' ? 5000 : 4000;
    // subscription
    if (tier === 'luxe') return commitment === '6' ? 27000 : 15000;
    return commitment === '6' ? 21600 : 12000;
  })();
  const itemName = kind === 'set'
    ? `Gift a ${tier === 'luxe' ? 'Luxe' : 'Classic'} Set`
    : `Gift Subscription · ${tier === 'luxe' ? 'Luxe' : 'Classic'} · ${commitment} months`;

  const ip = c.req.header('cf-connecting-ip') ?? '0.0.0.0';
  const rl = await consume(c.env, RL_GIFT_IP, ip);
  if (!rl.allowed) {
    return c.redirect('/subscriptions?error=rate_limited#gift', 303);
  }

  const idempotencyKey = (await sha256Hex(`gift|${kind}|${tier}|${recipientEmail}|${crypto.randomUUID()}`)).slice(0, 40);
  const redirectUrl = `${c.env.SITE_ORIGIN}/checkout/return`;

  try {
    const resp = await squareFetch<{ payment_link?: { url: string } }>(c.env, '/v2/online-checkout/payment-links', {
      method: 'POST',
      idempotencyKey,
      body: {
        order: {
          location_id: c.env.SQUARE_LOCATION_ID,
          reference_id: idempotencyKey,
          line_items: [
            {
              name: itemName,
              quantity: '1',
              base_price_money: { amount: priceCents, currency: 'USD' },
            },
          ],
          metadata: {
            fothy_kind: kind === 'set' ? 'gift_set' : 'gift_subscription',
            fothy_tier: tier,
            fothy_commitment: commitment,
            gift_sender_name: senderName,
            gift_sender_email: senderEmail,
            gift_recipient_email: recipientEmail,
            gift_recipient_name: recipientName,
            gift_delivery_date: deliveryDate,
            gift_message: message,
            ...(kind === 'set' ? {
              gift_ship_street: ship.street,
              gift_ship_apt: ship.apt,
              gift_ship_city: ship.city,
              gift_ship_state: ship.state,
              gift_ship_zip: ship.zip,
            } : {}),
          },
        },
        checkout_options: {
          redirect_url: redirectUrl,
          ask_for_shipping_address: false,
          allow_tipping: false,
          enable_coupon: false,
          enable_loyalty: false,
        },
      },
    });
    if (!resp.payment_link?.url) return c.redirect('/subscriptions?error=checkout#gift', 303);
    return c.redirect(resp.payment_link.url, 303);
  } catch (err) {
    console.warn('giftcard.gift.failed', { error: err instanceof Error ? err.message : String(err) });
    return c.redirect('/subscriptions?error=checkout#gift', 303);
  }
});

function errorMessage(code: string): string {
  switch (code) {
    case 'invalid_amount': return 'Please pick a valid gift card amount.';
    case 'invalid_email': return 'Please enter a valid recipient email address.';
    case 'rate_limited': return 'Too many gift card requests. Try again in a bit.';
    case 'checkout': return 'We could not start checkout. Please try again.';
    default: return 'Something went wrong. Please try again.';
  }
}

export default gifts;
