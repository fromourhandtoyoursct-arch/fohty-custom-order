/**
 * Checkout — creates a Square Payment Link for the current cart.
 *
 * Flow:
 *   1. Force-fresh hydrate cart against Square Catalog.
 *   2. If any line unavailable: refuse with 409.
 *   3. Compute idempotency key = sha256(cart_id + cart_version + line_signature).
 *   4. SELECT existing checkout_attempts row by idempotency_key; reuse url if status 'created'.
 *   5. Otherwise call Square CreatePaymentLink, insert row, set status.
 *   6. Return payment link URL for redirect.
 *
 * Notes:
 *   - `order.reference_id` and `order.metadata.fothy_attempt_id` link Square events
 *     back to our `checkout_attempts` row (see webhook handling in sub-phase 3).
 *   - `redirect_url` returns to /checkout/return for a UI thank-you page.
 *   - PCI scope: 0 — no card data crosses our Worker.
 */
import { sha256Hex } from './crypto';
import { squareFetch } from './square';
import { ensureUserHasSquareCustomer } from './customers';
import type { Cart, Env, HydratedCart } from '../types';

export interface CreatePaymentLinkResponse {
  payment_link?: {
    id: string;
    version: number;
    description?: string;
    order_id?: string;
    url: string;
    long_url?: string;
    created_at: string;
  };
  related_resources?: { orders?: Array<{ id: string }> };
  errors?: unknown;
}

export async function buildIdempotencyKey(cart: Cart, hydrated: HydratedCart): Promise<string> {
  // Stable hash over (cart_id, version, sorted lines incl. live unit price + currency).
  // Including price defends against reusing an old Payment Link if Square's price changed.
  // Hex truncated to 40 chars to fit Square's reference_id constraint.
  const lineSig = hydrated.lines
    .map((l) => `${l.variation_id}:${l.qty}:${l.unit_price_cents}:${l.currency}`)
    .sort()
    .join('|');
  return (await sha256Hex(`${cart.id}|v${cart.version}|${lineSig}`)).slice(0, 40);
}

export interface CheckoutResult {
  paymentLinkUrl: string;
  paymentLinkId: string;
  squareOrderId: string | undefined;
  idempotencyKey: string;
  reused: boolean;
}

export class CheckoutError extends Error {
  constructor(public readonly code: 'empty' | 'invalid' | 'square_failure', message: string) {
    super(message);
    this.name = 'CheckoutError';
  }
}

export async function createCheckoutLink(
  env: Env,
  cart: Cart,
  hydrated: HydratedCart,
  opts: { userId?: number; redirectPath?: string } = {}
): Promise<CheckoutResult> {
  if (hydrated.lines.length === 0) {
    throw new CheckoutError('empty', 'Your cart is empty.');
  }
  if (hydrated.any_unavailable) {
    throw new CheckoutError('invalid', 'One or more items in your cart are unavailable.');
  }
  if (hydrated.subtotal_cents <= 0) {
    throw new CheckoutError('invalid', 'Invalid total.');
  }

  const idempotencyKey = await buildIdempotencyKey(cart, hydrated);

  // Step 1: short-circuit if we already created a link for this exact cart state.
  const existing = await env.DB.prepare(
    `SELECT payment_link_id, payment_link_url, square_order_id, status, created_at
       FROM checkout_attempts
       WHERE idempotency_key = ?`
  ).bind(idempotencyKey).first<{ payment_link_id: string | null; payment_link_url: string | null; square_order_id: string | null; status: string; created_at: number }>();

  if (existing && existing.status === 'created' && existing.payment_link_url) {
    return {
      paymentLinkUrl: existing.payment_link_url,
      paymentLinkId: existing.payment_link_id ?? '',
      squareOrderId: existing.square_order_id ?? undefined,
      idempotencyKey,
      reused: true,
    };
  }

  // Step 2: atomic claim. Only one concurrent attempt may proceed to call Square.
  // Re-uses INSERT OR IGNORE semantics: rowcount=1 if we won, 0 if another worker did.
  // For retried-after-failure: also allow re-claiming if existing row is 'failed' AND > 60s old (avoids livelock).
  const now = Math.floor(Date.now() / 1000);
  const claim = await env.DB.prepare(
    `INSERT INTO checkout_attempts (idempotency_key, cart_id, cart_version, user_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'claiming', ?, ?)
       ON CONFLICT(idempotency_key) DO UPDATE
         SET status = 'claiming',
             cart_version = excluded.cart_version,
             updated_at = excluded.updated_at
         WHERE checkout_attempts.status = 'failed'
            OR (checkout_attempts.status = 'claiming' AND checkout_attempts.updated_at < ? - 60)
       RETURNING idempotency_key`
  ).bind(idempotencyKey, cart.id, cart.version, opts.userId ?? null, now, now, now).first();

  if (!claim) {
    // Another worker is currently creating this link OR a successful row exists we should re-read.
    // Re-read once and short-circuit if 'created'; otherwise tell user to retry.
    const cur = await env.DB.prepare(
      `SELECT payment_link_url FROM checkout_attempts WHERE idempotency_key = ? AND status = 'created' AND payment_link_url IS NOT NULL`
    ).bind(idempotencyKey).first<{ payment_link_url: string }>();
    if (cur?.payment_link_url) {
      return { paymentLinkUrl: cur.payment_link_url, paymentLinkId: '', squareOrderId: undefined, idempotencyKey, reused: true };
    }
    throw new CheckoutError('square_failure', 'Checkout is being processed — please try again in a moment.');
  }

  const redirectUrl = `${env.SITE_ORIGIN}${opts.redirectPath ?? '/checkout/return'}`;

  // If buyer is logged in, ensure they have a linked Square customer so order
  // history / object-level auth / verified-purchase reviews all work.
  let customerId: string | null = null;
  if (opts.userId) {
    try {
      customerId = await ensureUserHasSquareCustomer(env, opts.userId);
    } catch (err) {
      // Non-fatal — proceed as a guest order; webhook customer linking will fix it after checkout.
      console.warn('checkout.customer.link.failed', { user_id: opts.userId, message: err instanceof Error ? err.message : String(err) });
    }
  }

  const body: Record<string, unknown> = {
    order: {
      location_id: env.SQUARE_LOCATION_ID,
      reference_id: idempotencyKey,
      ...(customerId ? { customer_id: customerId } : {}),
      line_items: hydrated.lines.map((l) => ({
        catalog_object_id: l.variation_id,
        quantity: String(l.qty),
      })),
      metadata: {
        fothy_cart_id: cart.id,
        fothy_attempt_id: idempotencyKey,
        ...(opts.userId ? { fothy_user_id: String(opts.userId) } : {}),
      },
    },
    checkout_options: {
      redirect_url: redirectUrl,
      ask_for_shipping_address: true,
      allow_tipping: false,
      enable_coupon: true,
      enable_loyalty: false,
    },
  };

  let resp: CreatePaymentLinkResponse;
  try {
    resp = await squareFetch<CreatePaymentLinkResponse>(env, '/v2/online-checkout/payment-links', {
      method: 'POST',
      body,
      idempotencyKey,
    });
  } catch (err) {
    await env.DB.prepare(`UPDATE checkout_attempts SET status='failed', updated_at=unixepoch() WHERE idempotency_key = ?`).bind(idempotencyKey).run();
    throw new CheckoutError('square_failure', err instanceof Error ? err.message : String(err));
  }

  const link = resp.payment_link;
  if (!link?.url) {
    await env.DB.prepare(`UPDATE checkout_attempts SET status='failed', updated_at=unixepoch() WHERE idempotency_key = ?`).bind(idempotencyKey).run();
    throw new CheckoutError('square_failure', 'Square did not return a payment link.');
  }

  await env.DB.prepare(
    `UPDATE checkout_attempts
       SET status='created', payment_link_id=?, payment_link_url=?, square_order_id=?, updated_at=unixepoch()
       WHERE idempotency_key = ?`
  ).bind(link.id, link.url, link.order_id ?? null, idempotencyKey).run();

  return {
    paymentLinkUrl: link.url,
    paymentLinkId: link.id,
    squareOrderId: link.order_id,
    idempotencyKey,
    reused: false,
  };
}
