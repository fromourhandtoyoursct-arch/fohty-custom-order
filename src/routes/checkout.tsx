import { Hono } from 'hono';
import { html } from 'hono/html';
import { getCookie } from 'hono/cookie';
import { Layout } from '../views/layout';
import { ensureCartCookie, hydrateCartForCheckout, hydrateCartForDisplay, loadCart } from '../lib/cart';
import { createCheckoutLink, CheckoutError } from '../lib/checkout';
import { captureCartEmail } from '../lib/abandoned-cart';
import { csrfToken } from '../lib/csrf';
import { formatMoneyCents } from '../lib/money';
import type { Env, HonoVars } from '../types';

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

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

  // If signed-in user picked "Use your account", short-circuit to payment review.
  if (mode === 'signin' && signedIn) {
    return c.html(
      Layout({
        c,
        title: 'Review your order',
        children: html`
          <section style="padding-bottom: 64px;">
            <div class="wrap">
              <div class="pagehead">
                <span class="eyebrow">Checkout · Signed in</span>
                <h1>One last step.</h1>
              </div>
              <div class="co-grid">
                <div class="co-main">
                  <a class="btn-link co-back" href="/checkout">← Change</a>
                  <div class="co-review">
                    <span class="eyebrow">Payment</span>
                    <h2 class="co-review-head">Ready to pay?</h2>
                    <div class="co-review-box">
                      <p>You'll complete shipping &amp; payment on our secure Square page. We never see your card number — promise.</p>
                      <form method="post" action="/checkout">
                        <input type="hidden" name="_csrf" value="${token}">
                        <input type="hidden" name="mode" value="signin">
                        <button type="submit" class="btn btn-primary btn-lg btn-block" ${hydrated.any_unavailable ? 'disabled aria-disabled="true"' : ''}>Pay ${formatMoneyCents(totalCents)} on Square →</button>
                      </form>
                    </div>
                  </div>
                </div>
                ${renderSidebar(hydrated, shippingCents, totalCents)}
              </div>
            </div>
          </section>`,
      })
    );
  }

  // Guest 3-step flow: Contact → Address → Payment
  if (mode === 'guest') {
    return c.html(
      Layout({
        c,
        title: 'Checkout · Guest',
        children: html`
          <section style="padding-bottom: 64px;">
            <div class="wrap">
              <div class="pagehead">
                <span class="eyebrow">Checkout · Guest</span>
                <h1>Where should we send it?</h1>
              </div>
              <div class="co-grid">
                <div class="co-main">
                  <div class="co-step-nav">
                    <a class="btn-link co-back" href="/checkout">← Change</a>
                    <div class="co-step-labels">
                      <span class="co-step-label on" data-step-label="1">1 · Contact</span>
                      <span class="co-step-label" data-step-label="2">2 · Address</span>
                      <span class="co-step-label" data-step-label="3">3 · Payment</span>
                    </div>
                  </div>

                  <form class="co-guest-form" method="post" action="/checkout">
                    <input type="hidden" name="_csrf" value="${token}">
                    <input type="hidden" name="mode" value="guest">

                    <section class="co-step-pane on" data-step-pane="1">
                      <span class="eyebrow">Guest checkout</span>
                      <h2 class="co-review-head">What's your email?</h2>
                      <div class="fld"><label for="co-email">Email</label>
                        <input id="co-email" name="email" type="email" required maxlength="200" placeholder="you@there.com">
                      </div>
                      <label class="co-checkbox">
                        <input type="checkbox" name="newsletter_opt_in" value="1" checked>
                        <span>Send me a note when new sets arrive.</span>
                      </label>
                      <div class="co-step-nav-row">
                        <span></span>
                        <button type="button" class="btn btn-primary" data-step-next="2">Continue to address</button>
                      </div>
                    </section>

                    <section class="co-step-pane" data-step-pane="2" hidden>
                      <span class="eyebrow">Where to send it</span>
                      <h2 class="co-review-head">Shipping address</h2>
                      <div class="fld-row">
                        <div class="fld"><label for="co-first">First name</label><input id="co-first" name="first_name" required maxlength="80"></div>
                        <div class="fld"><label for="co-last">Last name</label><input id="co-last" name="last_name" required maxlength="80"></div>
                      </div>
                      <div class="fld"><label for="co-addr">Address</label><input id="co-addr" name="address" required maxlength="200"></div>
                      <div class="fld-row">
                        <div class="fld"><label for="co-city">City</label><input id="co-city" name="city" required maxlength="80"></div>
                        <div class="fld"><label for="co-zip">ZIP</label><input id="co-zip" name="zip" required maxlength="12"></div>
                      </div>
                      <p class="co-hint" style="color:var(--ink-2);">We'll confirm and complete shipping on the Square checkout page.</p>
                      <div class="co-step-nav-row">
                        <button type="button" class="btn btn-secondary" data-step-prev="1">Back</button>
                        <button type="button" class="btn btn-primary" data-step-next="3">Continue to payment</button>
                      </div>
                    </section>

                    <section class="co-step-pane" data-step-pane="3" hidden>
                      <span class="eyebrow">Payment</span>
                      <h2 class="co-review-head">One last step.</h2>
                      <div class="co-review-box">
                        <p>You'll complete payment on our secure Square page. We never see your card number — promise.</p>
                        <button type="submit" class="btn btn-primary btn-lg btn-block" ${hydrated.any_unavailable ? 'disabled aria-disabled="true"' : ''}>Pay ${formatMoneyCents(totalCents)} on Square →</button>
                      </div>
                      <div class="co-step-nav-row" style="margin-top:12px;">
                        <button type="button" class="btn btn-ghost btn-sm" data-step-prev="2">Back</button>
                      </div>
                    </section>
                  </form>

                  ${hydrated.any_unavailable
                    ? html`<p class="cart-side-warning" style="margin-top:12px;">Some items in your bag are unavailable. <a href="/cart">Review your bag</a> before continuing.</p>`
                    : ''}
                </div>
                ${renderSidebar(hydrated, shippingCents, totalCents)}
              </div>
            </div>

            <script>
              (function () {
                var panes = document.querySelectorAll('[data-step-pane]');
                var labels = document.querySelectorAll('[data-step-label]');
                function show(step) {
                  panes.forEach(function (p) {
                    var on = p.dataset.stepPane === String(step);
                    p.hidden = !on;
                    p.classList.toggle('on', on);
                  });
                  labels.forEach(function (l) {
                    var n = parseInt(l.dataset.stepLabel, 10);
                    l.classList.toggle('on', n === parseInt(step, 10));
                    l.classList.toggle('done', n < parseInt(step, 10));
                  });
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }
                document.querySelectorAll('[data-step-next]').forEach(function (btn) {
                  btn.addEventListener('click', function () {
                    var form = btn.closest('form');
                    if (!form) return;
                    // Validate fields in the current pane.
                    var pane = btn.closest('[data-step-pane]');
                    var invalid = false;
                    pane.querySelectorAll('input[required]').forEach(function (el) {
                      if (!el.reportValidity()) invalid = true;
                    });
                    if (invalid) return;
                    show(btn.dataset.stepNext);
                  });
                });
                document.querySelectorAll('[data-step-prev]').forEach(function (btn) {
                  btn.addEventListener('click', function () { show(btn.dataset.stepPrev); });
                });
              })();
            </script>
          </section>`,
      })
    );
  }

  // Sign-in mode: inline magic-link form on the page
  return c.html(
    Layout({
      c,
      title: 'Checkout · Sign in',
      children: html`
        <section style="padding-bottom: 64px;">
          <div class="wrap">
            <div class="pagehead">
              <span class="eyebrow">Checkout · Sign in</span>
              <h1>Magic link, no password.</h1>
            </div>
            <div class="co-grid">
              <div class="co-main">
                <a class="btn-link co-back" href="/checkout">← Change</a>
                <div class="co-signin-box">
                  <form method="post" action="/login" class="co-signin-form">
                    <input type="hidden" name="_csrf" value="${token}">
                    <input type="hidden" name="return_to" value="/checkout?mode=signin">
                    <div class="fld"><label for="co-signin-email">Email</label>
                      <input id="co-signin-email" name="email" type="email" required maxlength="200" placeholder="you@there.com">
                    </div>
                    <button type="submit" class="btn btn-primary btn-lg">Send me a link</button>
                  </form>
                  <p class="script-note" style="margin-top:18px;font-size:14px;">Or <a class="btn-link" href="/checkout?mode=guest">continue as guest</a> — same checkout, less typing.</p>
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

  // Read email from the multi-step guest form if present; capture for abandoned cart.
  const form = await c.req.parseBody().catch(() => ({}));
  const submittedEmail = String((form as any).email ?? '').trim().toLowerCase();
  const optIn = String((form as any).newsletter_opt_in ?? '') === '1';
  const buyerEmail = EMAIL_RE.test(submittedEmail) ? submittedEmail : undefined;

  if (buyerEmail) {
    c.executionCtx.waitUntil(captureCartEmail(c.env, cartId, buyerEmail, optIn).catch(() => undefined));
  }

  try {
    const result = await createCheckoutLink(c.env, cart, hydrated, { userId: c.get('user_id'), buyerEmail });
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
