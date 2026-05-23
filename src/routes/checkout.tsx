import { Hono } from 'hono';
import { html } from 'hono/html';
import { getCookie } from 'hono/cookie';
import { Layout } from '../views/layout';
import { ensureCartCookie, hydrateCartForCheckout, hydrateCartForDisplay, loadCart } from '../lib/cart';
import { createCheckoutLink, CheckoutError } from '../lib/checkout';
import { csrfToken } from '../lib/csrf';
import { formatMoneyCents } from '../lib/money';
import type { Env, HonoVars } from '../types';

const checkout = new Hono<{ Bindings: Env; Variables: HonoVars }>();

/** GET /checkout — Guest / Sign-in chooser, then order review */
checkout.get('/', async (c) => {
  const cartId = ensureCartCookie(c);
  const cart = await loadCart(c.env, cartId);
  if (cart.items.length === 0) return c.redirect('/cart', 303);
  const hydrated = await hydrateCartForDisplay(c.env, cart, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });
  const signedIn = !!c.get('user_id');
  const mode = String(c.req.query('mode') ?? '');
  const token = csrfToken(c);
  const shippingCents = hydrated.subtotal_cents >= 6000 ? 0 : 600;
  const totalCents = hydrated.subtotal_cents + shippingCents;

  // Default: chooser screen
  if (mode !== 'guest' && mode !== 'signin') {
    return c.html(
      Layout({
        c,
        title: 'Checkout',
        children: html`
          <section style="padding-bottom: 64px;">
            <div class="wrap">
              <div class="pagehead">
                <span class="eyebrow">Checkout</span>
                <h1>How would you like to check out?</h1>
              </div>
              <div class="co-grid">
                <div class="co-main">
                  <div class="co-mode-grid">
                    <a class="co-mode-card" href="/checkout?mode=guest">
                      <span class="eyebrow">Fastest</span>
                      <h3>Guest checkout</h3>
                      <p>Just an email and address. We'll send tracking. No password to remember.</p>
                      <span class="co-mode-link">Continue as guest →</span>
                    </a>
                    ${signedIn
                      ? html`<a class="co-mode-card" href="/checkout?mode=signin">
                          <span class="eyebrow">Saves your details</span>
                          <h3>Use your account</h3>
                          <p>Pre-fill shipping from your account. Required if you're subscribing.</p>
                          <span class="co-mode-link">Continue →</span>
                        </a>`
                      : html`<a class="co-mode-card" href="/login?return_to=/checkout?mode=signin">
                          <span class="eyebrow">Saves your details</span>
                          <h3>Sign in</h3>
                          <p>Magic link — we'll email you a one-tap login. Required if you're subscribing.</p>
                          <span class="co-mode-link">Sign in →</span>
                        </a>`}
                    <p class="script-note co-mode-note">Subscription items in your bag will require an account — we'll prompt you if needed.</p>
                  </div>
                </div>
                ${renderSidebar(hydrated, shippingCents, totalCents)}
              </div>
            </div>
          </section>`,
      })
    );
  }

  // Sign-in requested but not signed in → bounce to login
  if (mode === 'signin' && !signedIn) {
    return c.redirect('/login?return_to=/checkout?mode=signin', 303);
  }

  // Order review screen — single "Pay on Square" button (Square collects address + payment)
  return c.html(
    Layout({
      c,
      title: 'Review your order',
      children: html`
        <section style="padding-bottom: 64px;">
          <div class="wrap">
            <div class="pagehead">
              <span class="eyebrow">Checkout · ${mode === 'guest' ? 'Guest' : 'Signed in'}</span>
              <h1>Where should we send it?</h1>
            </div>
            <div class="co-grid">
              <div class="co-main">
                <a class="btn-link co-back" href="/checkout">← Change</a>
                <div class="co-review">
                  <span class="eyebrow">Payment</span>
                  <h2 class="co-review-head">One last step.</h2>
                  <div class="co-review-box">
                    <p>You'll complete shipping &amp; payment on our secure Square page. We never see your card number — promise.</p>
                    <form method="post" action="/checkout">
                      <input type="hidden" name="_csrf" value="${token}">
                      <input type="hidden" name="mode" value="${mode}">
                      <button type="submit" class="btn btn-primary btn-lg btn-block" ${hydrated.any_unavailable ? 'disabled aria-disabled="true"' : ''}>Pay ${formatMoneyCents(totalCents)} on Square →</button>
                    </form>
                  </div>
                  ${hydrated.any_unavailable
                    ? html`<p class="cart-side-warning" style="margin-top:12px;">Some items in your bag are unavailable. <a href="/cart">Review your bag</a> before continuing.</p>`
                    : ''}
                </div>
              </div>
              ${renderSidebar(hydrated, shippingCents, totalCents)}
            </div>
          </div>
        </section>`,
    })
  );
});

function renderSidebar(hydrated: { lines: Array<{ image_url?: string | null; item_name: string; variation_name?: string | null; qty: number; line_subtotal_cents: number }>; subtotal_cents: number }, shippingCents: number, totalCents: number) {
  return html`<aside class="co-side">
    <h3 class="co-side-head">Your order</h3>
    ${hydrated.lines.map(
      (l) => html`<div class="co-side-line">
        <div class="co-side-img">
          ${l.image_url ? html`<img src="${l.image_url}" alt="" width="64" height="80" loading="lazy">` : html`<div class="co-side-ph"></div>`}
        </div>
        <div class="co-side-info">
          <div class="co-side-name">${l.item_name}</div>
          <div class="co-side-meta">${l.variation_name ? `${l.variation_name} · ` : ''}×${l.qty}</div>
        </div>
        <div class="co-side-price">${formatMoneyCents(l.line_subtotal_cents)}</div>
      </div>`
    )}
    <div class="co-side-row co-side-row-muted"><span>Subtotal</span><span>${formatMoneyCents(hydrated.subtotal_cents)}</span></div>
    <div class="co-side-row co-side-row-muted"><span>Shipping</span><span>${shippingCents === 0 ? 'Free' : formatMoneyCents(shippingCents)}</span></div>
    <div class="co-side-row co-side-row-muted"><span>Tax</span><span>Calculated at checkout</span></div>
    <div class="co-side-total"><span>Total</span><span>${formatMoneyCents(totalCents)}</span></div>
  </aside>`;
}

/** POST /checkout — creates Square Payment Link, 303→Square */
checkout.post('/', async (c) => {
  const cartId = ensureCartCookie(c);
  const cart = await loadCart(c.env, cartId);
  if (cart.items.length === 0) {
    return c.redirect('/cart', 303);
  }
  const hydrated = await hydrateCartForCheckout(c.env, cart);
  if (hydrated.any_unavailable) {
    return c.redirect('/cart?error=unavailable', 303);
  }
  if (hydrated.lines.length === 0 || hydrated.subtotal_cents <= 0) {
    return c.redirect('/cart?error=invalid', 303);
  }
  try {
    const result = await createCheckoutLink(c.env, cart, hydrated, { userId: c.get('user_id') });
    return c.redirect(result.paymentLinkUrl, 303);
  } catch (err) {
    if (err instanceof CheckoutError) {
      console.warn('checkout.failed', { code: err.code, message: err.message });
      return c.redirect(`/cart?error=${encodeURIComponent(err.code)}`, 303);
    }
    throw err;
  }
});

/** GET /checkout/return — UI thank-you ONLY. Order completion owned by webhooks. */
checkout.get('/return', async (c) => {
  const orderId = c.req.query('orderId') || c.req.query('order_id') || null;
  const cartCookie = getCookie(c, '__Host-cart');

  let status: 'pending' | 'created' | 'completed' | 'failed' | 'unknown' = 'pending';
  if (orderId && cartCookie) {
    const row = await c.env.DB.prepare(
      `SELECT status FROM checkout_attempts WHERE square_order_id = ? AND cart_id = ? LIMIT 1`
    ).bind(orderId, cartCookie).first<{ status: string }>();
    if (!row) {
      status = 'unknown';
    } else if (row.status === 'completed') status = 'completed';
    else if (row.status === 'failed') status = 'failed';
    else if (row.status === 'created') status = 'created';
  } else {
    status = 'unknown';
  }

  return c.html(
    Layout({
      c,
      title: 'Thank you',
      children: html`
        <section class="section-y">
          <div class="wrap" style="max-width: 640px; text-align: center;">
            <span class="eyebrow">Order received</span>
            <h1 style="margin: 12px 0 16px; font-family: var(--font-display); font-size: clamp(36px, 5vw, 56px);">Thank you!</h1>
            <p class="serif-italic" style="color: var(--ink-2); margin-bottom: 32px;">Your payment is being processed.</p>
            <div class="checkout-status checkout-status-${status}" style="text-align: left;">
              ${status === 'completed'
                ? html`<p>Your order has been confirmed. A receipt will arrive in your inbox shortly.</p>`
                : status === 'unknown'
                  ? html`<p>If you just paid, your order is being processed. You'll receive an email confirmation shortly.</p>`
                  : html`<p>We'll send a confirmation email as soon as your payment clears (usually within a minute).</p>`}
              ${orderId && status !== 'unknown' ? html`<p class="checkout-order-ref">Order reference: <code>${orderId}</code></p>` : ''}
            </div>
            <div class="checkout-actions" style="justify-content: center; margin-top: 24px;">
              <a class="btn btn-primary" href="/catalog">Keep shopping</a>
              <a class="btn btn-secondary" href="/account/orders">View orders</a>
            </div>
          </div>
        </section>`,
    })
  );
});

export default checkout;
