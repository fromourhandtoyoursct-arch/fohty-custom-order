import { Hono } from 'hono';
import { html } from 'hono/html';
import { getCookie } from 'hono/cookie';
import { Layout } from '../views/layout';
import { ensureCartCookie, hydrateCartForCheckout, loadCart } from '../lib/cart';
import { createCheckoutLink, CheckoutError } from '../lib/checkout';
import type { Env, HonoVars } from '../types';

const checkout = new Hono<{ Bindings: Env; Variables: HonoVars }>();

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

/** GET /checkout/return — UI thank-you ONLY. Does NOT mark anything paid.
 *  Order completion is owned exclusively by webhooks.
 *  Status disclosed only when the requester's cart cookie owns the order. */
checkout.get('/return', async (c) => {
  const orderId = c.req.query('orderId') || c.req.query('order_id') || null;
  const cartCookie = getCookie(c, '__Host-cart');

  let status: 'pending' | 'created' | 'completed' | 'failed' | 'unknown' = 'pending';
  if (orderId && cartCookie) {
    // Look up only IF cart_id on the attempt matches our cart cookie — prevents enumeration.
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
        <section class="section">
          <div class="container narrow-col">
            <header class="page-header">
              <h1>Thank you!</h1>
              <p>Your payment is being processed.</p>
            </header>
            <div class="checkout-status checkout-status-${status}">
              ${status === 'completed'
                ? html`<p>Your order has been confirmed. A receipt will arrive in your inbox shortly.</p>`
                : status === 'unknown'
                  ? html`<p>If you just paid, your order is being processed. You'll receive an email confirmation shortly.</p>`
                  : html`<p>We'll send a confirmation email as soon as your payment clears (usually within a minute).</p>`}
              ${orderId && status !== 'unknown' ? html`<p class="checkout-order-ref">Order reference: <code>${orderId}</code></p>` : ''}
            </div>
            <div class="checkout-actions">
              <a class="btn btn-primary" href="/catalog">Keep shopping</a>
              <a class="btn btn-secondary" href="/account/orders">View orders</a>
            </div>
          </div>
        </section>`,
    })
  );
});

export default checkout;
