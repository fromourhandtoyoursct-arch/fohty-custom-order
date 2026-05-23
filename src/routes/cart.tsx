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

  const signedIn = !!c.get('user_id');
  const itemCount = hydrated.lines.reduce((n, l) => n + l.qty, 0);
  const shippingCents = hydrated.subtotal_cents >= 6000 || hydrated.subtotal_cents === 0 ? 0 : 600;
  const totalCents = hydrated.subtotal_cents + shippingCents;

  if (hydrated.lines.length === 0) {
    return c.html(
      Layout({
        c,
        title: 'Your bag',
        children: html`
          <section class="section-y">
            <div class="wrap" style="max-width: 640px; text-align: center;">
              <span class="eyebrow">Your bag</span>
              <h1 style="margin: 12px 0 16px; font-family: var(--font-display); font-size: clamp(40px, 6vw, 56px);">Empty for now.</h1>
              <p class="serif-italic" style="color: var(--ink-2); margin-bottom: 32px;">Let's fix that.</p>
              <a class="btn btn-primary btn-lg" href="/catalog">Browse the shop</a>
            </div>
          </section>`,
      })
    );
  }

  return c.html(
    Layout({
      c,
      title: 'Your bag',
      children: html`
        <section style="padding-bottom: 64px;">
          <div class="wrap">
            <div class="pagehead">
              <span class="eyebrow">Your bag · ${itemCount} item${itemCount === 1 ? '' : 's'}</span>
              <h1>Almost yours.</h1>
            </div>
            <div class="cart-grid">
              <div class="cart-list">
                ${hydrated.lines.map(
                  (line) => html`<div class="cart-row ${line.available ? '' : 'cart-row-unavailable'}">
                    <div class="cart-row-img">
                      ${line.image_url
                        ? html`<img src="${line.image_url}" alt="" width="240" height="300" loading="lazy">`
                        : html`<div class="cart-row-fallback"></div>`}
                    </div>
                    <div class="cart-row-info">
                      <div class="cart-row-name">${line.item_name}</div>
                      ${line.variation_name ? html`<div class="cart-row-variation">${line.variation_name}</div>` : ''}
                      ${line.available
                        ? html`<div class="cart-row-price">${formatMoneyCents(line.unit_price_cents)} each</div>`
                        : html`<div class="cart-row-reason">${line.reason ?? 'Unavailable'}</div>`}
                      <div class="cart-row-controls">
                        <form method="post" action="/cart/update" class="cart-qty-stepper" data-cart-form>
                          <input type="hidden" name="_csrf" value="${token}">
                          <input type="hidden" name="variation_id" value="${line.variation_id}">
                          <button type="submit" name="quantity" value="${Math.max(0, line.qty - 1)}" aria-label="Decrease">−</button>
                          <span class="cart-qty-n">${line.qty}</span>
                          <button type="submit" name="quantity" value="${line.qty + 1}" aria-label="Increase">+</button>
                        </form>
                        <form method="post" action="/cart/remove" data-cart-form>
                          <input type="hidden" name="_csrf" value="${token}">
                          <input type="hidden" name="variation_id" value="${line.variation_id}">
                          <button type="submit" class="cart-row-remove">Remove</button>
                        </form>
                      </div>
                    </div>
                    <div class="cart-row-subtotal">${formatMoneyCents(line.line_subtotal_cents)}</div>
                  </div>`
                )}
                <div class="cart-note">
                  <p class="script-note">A small note will be tucked inside, hand-written — it's just how we do.</p>
                </div>
              </div>
              <aside class="cart-side">
                <h3 class="cart-side-head">Summary</h3>
                <div class="cart-side-row"><span>Subtotal</span><span>${formatMoneyCents(hydrated.subtotal_cents)}</span></div>
                <div class="cart-side-row cart-side-row-muted"><span>Shipping</span><span>${shippingCents === 0 && hydrated.subtotal_cents > 0 ? 'Free' : shippingCents === 0 ? '—' : formatMoneyCents(shippingCents)}</span></div>
                <div class="cart-side-row cart-side-row-muted"><span>Tax</span><span>Calculated at checkout</span></div>
                ${hydrated.subtotal_cents > 0 && hydrated.subtotal_cents < 6000
                  ? html`<p class="cart-side-hint">Add ${formatMoneyCents(6000 - hydrated.subtotal_cents)} for free shipping.</p>`
                  : ''}
                <div class="cart-side-total"><span>Total</span><span>${formatMoneyCents(totalCents)}</span></div>
                ${hydrated.any_unavailable
                  ? html`<p class="cart-side-warning">Please remove unavailable items before checking out.</p>`
                  : ''}
                ${hydrated.any_unavailable
                  ? html`<button class="btn btn-primary btn-lg btn-block" disabled aria-disabled="true">Guest checkout · ${formatMoneyCents(totalCents)}</button>`
                  : html`<a class="btn btn-primary btn-lg btn-block cart-side-form" href="/checkout?mode=guest">Guest checkout · ${formatMoneyCents(totalCents)}</a>`}
                ${signedIn
                  ? html`<a class="btn btn-secondary btn-sm btn-block cart-side-form-secondary" href="/checkout?mode=signin">Use your account</a>`
                  : html`<a class="btn btn-secondary btn-sm btn-block cart-side-form-secondary" href="/login?return_to=%2Fcheckout%3Fmode%3Dsignin">Sign in for faster checkout</a>`}
                <p class="cart-side-note">No account needed — we'll just need an email so we can send your tracking. Subscriptions require an account.</p>
              </aside>
            </div>
          </div>
        </section>`,
    })
  );
});

/** GET /cart/contents — JSON cart state for the drawer */
cart.get('/contents', async (c) => {
  const cartId = ensureCartCookie(c);
  const raw = await loadCart(c.env, cartId);
  const hydrated = await hydrateCartForDisplay(c.env, raw, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });
  return c.json({ ok: true, ...summarize(hydrated) });
});

/** POST /cart/add — body: variation_id, quantity */
cart.post('/add', async (c) => {
  const cartId = ensureCartCookie(c);
  const form = await c.req.parseBody();
  const variationId = String(form.variation_id ?? '');
  const quantity = Number(form.quantity ?? 1);
  if (!variationId) return c.json({ ok: false, error: 'missing variation_id' }, 400);
  try {
    await addToCart(c.env, cartId, variationId, quantity);
    if (acceptsJson(c)) {
      const fresh = await loadCart(c.env, cartId);
      const hydrated = await hydrateCartForDisplay(c.env, fresh, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });
      return c.json({ ok: true, ...summarize(hydrated) });
    }
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
  if (acceptsJson(c)) {
    const fresh = await loadCart(c.env, cartId);
    const hydrated = await hydrateCartForDisplay(c.env, fresh, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });
    return c.json({ ok: true, ...summarize(hydrated) });
  }
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
  if (acceptsJson(c)) {
    const fresh = await loadCart(c.env, cartId);
    const hydrated = await hydrateCartForDisplay(c.env, fresh, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });
    return c.json({ ok: true, ...summarize(hydrated) });
  }
  return c.redirect('/cart', 303);
});

function acceptsJson(c: any): boolean {
  const a = c.req.header('accept') ?? '';
  return a.includes('application/json') && !a.includes('text/html');
}

function summarize(h: { lines: Array<{ variation_id: string; item_name: string; variation_name?: string | null; image_url?: string | null; unit_price_cents: number; qty: number; line_subtotal_cents: number; available: boolean; reason?: string | null }>; subtotal_cents: number; any_unavailable: boolean }) {
  const count = h.lines.reduce((n, l) => n + l.qty, 0);
  return {
    item_count: count,
    subtotal_cents: h.subtotal_cents,
    subtotal_label: formatMoneyCents(h.subtotal_cents),
    any_unavailable: h.any_unavailable,
    lines: h.lines.map((l) => ({
      variation_id: l.variation_id,
      name: l.item_name,
      variation: l.variation_name ?? '',
      image: l.image_url ?? '',
      unit_price_label: formatMoneyCents(l.unit_price_cents),
      qty: l.qty,
      subtotal_label: formatMoneyCents(l.line_subtotal_cents),
      available: l.available,
      reason: l.reason ?? null,
    })),
  };
}

export default cart;
