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

/** GET /gift-cards — captures recipient details + amount in a single form. */
gifts.get('/', async (c) => {
  const snap = await getCatalog(c.env, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });
  const giftItems = snap.items.filter((it) => /gift\s*card/i.test(it.name));
  const token = csrfToken(c);
  const error = c.req.query('error');

  return c.html(
    Layout({
      c,
      title: 'Gift cards',
      description: 'Send a gift card by email. Recipient enters the code at checkout.',
      children: html`
        <section class="section">
          <div class="container narrow-col">
            <header class="page-header">
              <h1>Gift cards</h1>
              <p>Pick an amount, tell us who's getting it, and we'll email them the code after payment.</p>
            </header>
            ${error
              ? html`<div class="alert alert-error">${errorMessage(error)}</div>`
              : ''}
            ${giftItems.length === 0
              ? html`<div class="empty-state-card">
                  <p>Gift cards aren't set up yet. Please check back soon.</p>
                  <a class="btn btn-secondary" href="/catalog">Browse products</a>
                </div>`
              : html`<form class="gift-form" method="post" action="/gift-cards/purchase">
                  <input type="hidden" name="_csrf" value="${token}">
                  <label class="form-field">
                    <span class="form-label">Amount</span>
                    <select name="variation_id" required>
                      ${giftItems.flatMap((it) =>
                        it.variations.map(
                          (v) => html`<option value="${v.id}">${formatMoneyCents(v.priceCents)}${v.name ? ` (${v.name})` : ''}</option>`
                        )
                      )}
                    </select>
                  </label>
                  <label class="form-field">
                    <span class="form-label">Recipient name</span>
                    <input type="text" name="recipient_name" maxlength="120" placeholder="Jane Doe">
                  </label>
                  <label class="form-field">
                    <span class="form-label">Recipient email</span>
                    <input type="email" name="recipient_email" required maxlength="254" placeholder="jane@example.com" inputmode="email">
                  </label>
                  <label class="form-field">
                    <span class="form-label">Your name (optional)</span>
                    <input type="text" name="sender_name" maxlength="120">
                  </label>
                  <label class="form-field">
                    <span class="form-label">Gift message (optional)</span>
                    <textarea name="gift_message" rows="3" maxlength="500"></textarea>
                  </label>
                  <button type="submit" class="btn btn-primary btn-large btn-block">Continue to payment</button>
                  <p class="hint hint-muted">You'll be redirected to Square to pay securely. The recipient receives the gift card code by email immediately after payment.</p>
                </form>`}
          </div>
        </section>`,
    })
  );
});

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
