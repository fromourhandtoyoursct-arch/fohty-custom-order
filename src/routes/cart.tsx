import { Hono } from 'hono';
import { html } from 'hono/html';
import { setCookie } from 'hono/cookie';
import { Layout } from '../views/layout';
import { csrfToken } from '../lib/csrf';
import { addToCart, ensureCartCookie, hydrateCartForDisplay, loadCart, removeCartLine, updateCartLine, CartError } from '../lib/cart';
import { captureCartEmail, consumeRecoveryToken, consumeUnsubscribeToken } from '../lib/abandoned-cart';
import { consume, RL_CART_EMAIL_IP, RL_CART_EMAIL_TARGET } from '../lib/rate-limit';
import { formatMoneyCents } from '../lib/money';
import type { Env, HonoVars } from '../types';

const cart = new Hono<{ Bindings: Env; Variables: HonoVars }>();

/** GET /cart — full cart page */
cart.get('/', async (c) => {
  const cartId = ensureCartCookie(c);
  const raw = await loadCart(c.env, cartId);
  const hydrated = await hydrateCartForDisplay(c.env, raw, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });
  const token = csrfToken(c);

  return c.html(
    Layout({
      c,
      title: 'Your cart',
      children: html`
        <section class="section">
          <div class="container">
            <header class="page-header">
              <h1>Your cart</h1>
              <p>${hydrated.lines.length} ${hydrated.lines.length === 1 ? 'item' : 'items'}</p>
            </header>
            ${hydrated.lines.length === 0
              ? html`<div class="empty-state-card">
                  <p>Your cart is empty.</p>
                  <a class="btn btn-primary" href="/catalog">Start shopping</a>
                </div>`
              : html`<div class="cart-layout">
                  <div class="cart-lines">
                    ${hydrated.lines.map(
                      (line) => html`<div class="cart-line ${line.available ? '' : 'cart-line-unavailable'}">
                        <div class="cart-line-image">
                          ${line.image_url
                            ? html`<img src="${line.image_url}" alt="" width="120" height="120" loading="lazy">`
                            : html`<div class="cart-line-image-fallback"></div>`}
                        </div>
                        <div class="cart-line-info">
                          <div class="cart-line-name">${line.item_name}</div>
                          ${line.variation_name ? html`<div class="cart-line-variation">${line.variation_name}</div>` : ''}
                          ${line.available
                            ? html`<div class="cart-line-price">${formatMoneyCents(line.unit_price_cents)}</div>`
                            : html`<div class="cart-line-reason">${line.reason ?? 'Unavailable'}</div>`}
                        </div>
                        <div class="cart-line-controls">
                          <form method="post" action="/cart/update" class="cart-qty-form" data-cart-form>
                            <input type="hidden" name="_csrf" value="${token}">
                            <input type="hidden" name="variation_id" value="${line.variation_id}">
                            <label class="visually-hidden" for="qty-${line.variation_id}">Quantity</label>
                            <input type="number" id="qty-${line.variation_id}" name="quantity" value="${line.qty}" min="0" max="50" inputmode="numeric">
                            <button type="submit" class="btn btn-secondary btn-sm">Update</button>
                          </form>
                          <form method="post" action="/cart/remove" data-cart-form>
                            <input type="hidden" name="_csrf" value="${token}">
                            <input type="hidden" name="variation_id" value="${line.variation_id}">
                            <button type="submit" class="cart-line-remove" aria-label="Remove">Remove</button>
                          </form>
                        </div>
                        <div class="cart-line-subtotal">${formatMoneyCents(line.line_subtotal_cents)}</div>
                      </div>`
                    )}
                  </div>
                  <aside class="cart-summary">
                    <h2>Summary</h2>
                    <dl class="cart-summary-row"><dt>Subtotal</dt><dd>${formatMoneyCents(hydrated.subtotal_cents)}</dd></dl>
                    <p class="cart-summary-hint">Shipping &amp; tax calculated at checkout.</p>
                    ${hydrated.any_unavailable
                      ? html`<p class="cart-summary-warning">Please remove unavailable items before checking out.</p>`
                      : ''}
                    <form method="post" action="/checkout" data-cart-form>
                      <input type="hidden" name="_csrf" value="${token}">
                      <button type="submit" class="btn btn-primary btn-large btn-block" ${hydrated.any_unavailable ? 'disabled aria-disabled="true"' : ''}>Checkout</button>
                    </form>
                    <a href="/catalog" class="cart-keep-shopping">← Keep shopping</a>
                  </aside>
                </div>`}
          </div>
        </section>`,
    })
  );
});

/** POST /cart/add — body: variation_id, quantity */
cart.post('/add', async (c) => {
  const cartId = ensureCartCookie(c);
  const form = await c.req.parseBody();
  const variationId = String(form.variation_id ?? '');
  const quantity = Number(form.quantity ?? 1);
  if (!variationId) return c.json({ ok: false, error: 'missing variation_id' }, 400);
  try {
    const updated = await addToCart(c.env, cartId, variationId, quantity);
    if (acceptsJson(c)) return c.json({ ok: true, item_count: countItems(updated) });
    return c.redirect('/cart', 303);
  } catch (err) {
    if (err instanceof CartError) return c.json({ ok: false, error: err.message }, 400);
    throw err;
  }
});

cart.post('/update', async (c) => {
  const cartId = ensureCartCookie(c);
  const form = await c.req.parseBody();
  const variationId = String(form.variation_id ?? '');
  const quantity = Number(form.quantity ?? 0);
  if (!variationId) return c.json({ ok: false, error: 'missing variation_id' }, 400);
  await updateCartLine(c.env, cartId, variationId, quantity);
  if (acceptsJson(c)) return c.json({ ok: true });
  return c.redirect('/cart', 303);
});

/** POST /cart/email — capture email + consent for abandoned-cart reminders */
cart.post('/email', async (c) => {
  const cartId = ensureCartCookie(c);
  const form = await c.req.parseBody();
  const email = String(form.email ?? '').trim().toLowerCase();
  const consent = form.consent === '1' || form.consent === 'on';
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)) {
    return c.redirect('/cart?email=invalid', 303);
  }

  const ip = c.req.header('cf-connecting-ip') ?? '0.0.0.0';
  // Rate limits: per IP (5/h) and per target email (1 capture per 7d) — defeats victim spam.
  const [ipOk, targetOk] = await Promise.all([
    consume(c.env, RL_CART_EMAIL_IP, ip),
    consume(c.env, RL_CART_EMAIL_TARGET, email),
  ]);
  if (!ipOk.allowed || !targetOk.allowed) {
    console.warn('cart.email.rate-limited');
    return c.redirect('/cart?email=1', 303); // appear successful, don't leak limit state
  }
  // Already-suppressed email: silently succeed.
  const suppressed = await c.env.DB.prepare(`SELECT 1 FROM suppression_list WHERE email = ? LIMIT 1`).bind(email).first();
  if (suppressed) return c.redirect('/cart?email=1', 303);
  try {
    await captureCartEmail(c.env, cartId, email, consent);
  } catch (err) {
    console.warn('cart.email.failed', { message: err instanceof Error ? err.message : String(err) });
  }
  return c.redirect('/cart?email=1', 303);
});

/** GET /cart/recover/:token — restore cart cookie + redirect */
cart.get('/recover/:token', async (c) => {
  const token = c.req.param('token') ?? '';
  const result = await consumeRecoveryToken(c.env, token);
  if (!result) return c.redirect('/cart?recover=invalid', 303);
  setCookie(c, '__Host-cart', result.cartId, {
    path: '/',
    sameSite: 'Lax',
    secure: true,
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 30,
  });
  return c.redirect('/cart?recover=ok', 303);
});

cart.post('/remove', async (c) => {
  const cartId = ensureCartCookie(c);
  const form = await c.req.parseBody();
  const variationId = String(form.variation_id ?? '');
  if (!variationId) return c.json({ ok: false, error: 'missing variation_id' }, 400);
  await removeCartLine(c.env, cartId, variationId);
  if (acceptsJson(c)) return c.json({ ok: true });
  return c.redirect('/cart', 303);
});

function acceptsJson(c: any): boolean {
  const a = c.req.header('accept') ?? '';
  return a.includes('application/json') && !a.includes('text/html');
}

function countItems(cart: { items: Array<{ qty: number }> }): number {
  return cart.items.reduce((n, i) => n + i.qty, 0);
}

export default cart;
