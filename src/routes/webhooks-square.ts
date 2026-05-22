import { Hono } from 'hono';
import { acquireEvent, markEventFailed, markEventProcessed, verifySquareSignature, type SquareWebhookEvent } from '../lib/webhook';
import { refreshCatalog } from '../lib/catalog';
import { activateGiftCardsForOrder } from '../lib/giftcards';
import { safeLog } from '../lib/redact';
import type { Env, HonoVars } from '../types';

const webhooks = new Hono<{ Bindings: Env; Variables: HonoVars }>();

/**
 * POST /api/webhooks/square — Square notification receiver.
 *
 * Always returns 200 once the signature is valid (or the event is dedup'd) — Square
 * retries non-2xx responses, so signal-handling failures via 200+error log rather
 * than failing the HTTP call (which would invite retries on permanent failures).
 */
webhooks.post('/api/webhooks/square', async (c) => {
  c.set('csrf_skip', true);

  // Reject oversize bodies before reading. Square webhook payloads are well
  // under 32KB in practice; any sender pushing > 256KB is hostile.
  const MAX_BODY_BYTES = 256 * 1024;
  const lenHeader = c.req.header('content-length');
  if (lenHeader && Number(lenHeader) > MAX_BODY_BYTES) {
    return c.json({ error: 'body_too_large' }, 413);
  }
  const sigHeader = c.req.header('x-square-hmacsha256-signature') ?? null;
  if (!sigHeader) {
    return c.json({ error: 'missing_signature' }, 401);
  }

  const rawBody = await c.req.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return c.json({ error: 'body_too_large' }, 413);
  }
  const valid = await verifySquareSignature(c.env, rawBody, sigHeader);
  if (!valid) {
    safeLog('webhook.bad-signature', { body_len: rawBody.length });
    return c.json({ error: 'invalid_signature' }, 401);
  }

  let event: SquareWebhookEvent;
  try {
    event = JSON.parse(rawBody) as SquareWebhookEvent;
  } catch {
    return c.json({ error: 'malformed_body' }, 400);
  }
  if (!event.event_id || !event.type) {
    return c.json({ error: 'malformed_event' }, 400);
  }

  const action = await acquireEvent(c.env, event, rawBody);
  if (action === 'skip') {
    return c.json({ ok: true, dedup: true });
  }
  if (action === 'busy') {
    // Tell Square to retry later — explicit 503 invites the retry, vs 200 which would mark delivered.
    return c.json({ ok: false, reason: 'in_progress' }, 503);
  }

  try {
    await dispatchEvent(c.env, event);
    await markEventProcessed(c.env, event.event_id);
    return c.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markEventFailed(c.env, event.event_id, msg);
    safeLog('webhook.dispatch.failed', { event_id: event.event_id, type: event.type, error: msg });
    // 200: we acknowledge receipt; locked_at cleared so Square's next retry will pick it up.
    // (Returning 5xx would also work, but 200 prevents thrash for transient downstream issues.)
    return c.json({ ok: false }, 500);
  }
});

async function dispatchEvent(env: Env, event: SquareWebhookEvent): Promise<void> {
  switch (event.type) {
    case 'order.created':
    case 'order.updated':
    case 'order.fulfillment.updated':
      await handleOrderEvent(env, event);
      break;
    case 'payment.created':
    case 'payment.updated':
      await handlePaymentEvent(env, event);
      break;
    case 'customer.created':
    case 'customer.updated':
      await handleCustomerEvent(env, event);
      break;
    case 'subscription.created':
    case 'subscription.updated':
      await handleSubscriptionEvent(env, event);
      break;
    case 'invoice.payment_made':
    case 'invoice.payment_failed':
      // Recorded in webhook_events for audit. Could trigger emails here in sub-phase 5.
      break;
    case 'catalog.version.updated':
      await refreshCatalog(env).catch(() => undefined);
      break;
    default:
      // Unknown / unhandled event types are recorded for audit and ack'd.
      break;
  }
}

interface OrderEventObject {
  order_created?: { order_id?: string; location_id?: string };
  order_updated?: { order_id?: string };
  order_fulfillment_updated?: { order_id?: string };
}

async function handleOrderEvent(env: Env, event: SquareWebhookEvent): Promise<void> {
  const obj = (event.data?.object ?? {}) as OrderEventObject;
  const orderId = obj.order_created?.order_id ?? obj.order_updated?.order_id ?? obj.order_fulfillment_updated?.order_id ?? event.data?.id;
  if (!orderId) return;

  // Update checkout_attempts.square_order_id if we have a matching reference_id but no order_id yet.
  await env.DB.prepare(
    `UPDATE checkout_attempts
       SET square_order_id = ?, updated_at = unixepoch()
       WHERE square_order_id IS NULL AND idempotency_key IN (
         SELECT reference_id FROM (SELECT ? AS reference_id)
       )`
  ).bind(orderId, orderId).run().catch(() => undefined);
}

interface PaymentEventObject {
  payment?: { id?: string; order_id?: string; status?: string; receipt_url?: string; reference_id?: string };
}

async function handlePaymentEvent(env: Env, event: SquareWebhookEvent): Promise<void> {
  const obj = (event.data?.object ?? {}) as PaymentEventObject;
  const payment = obj.payment;
  if (!payment) return;
  if (payment.status === 'COMPLETED' && payment.order_id) {
    await env.DB.prepare(
      `UPDATE checkout_attempts
         SET status = 'completed', square_order_id = ?, updated_at = unixepoch()
         WHERE square_order_id = ? AND status != 'completed'`
    ).bind(payment.order_id, payment.order_id).run();
    // Mark cart as checked-out if we can correlate.
    await env.DB.prepare(
      `UPDATE carts SET checked_out_at = unixepoch()
         WHERE id IN (SELECT cart_id FROM checkout_attempts WHERE square_order_id = ?)`
    ).bind(payment.order_id).run().catch(() => undefined);
    // Activate any gift cards in this order (idempotent).
    await activateGiftCardsForOrder(env, payment.order_id, payment.id ?? '');
  }
}

interface SubscriptionEventObject {
  subscription?: {
    id?: string;
    location_id?: string;
    customer_id?: string;
    plan_variation_id?: string;
    status?: string;
    start_date?: string;
    charged_through_date?: string;
    card_id?: string;
  };
}

async function handleSubscriptionEvent(env: Env, event: SquareWebhookEvent): Promise<void> {
  const obj = (event.data?.object ?? {}) as SubscriptionEventObject;
  const s = obj.subscription;
  if (!s?.id || !s.customer_id) return;
  // Look up our user via the linked square_customer_id.
  const user = await env.DB.prepare(`SELECT id FROM users WHERE square_customer_id = ?`).bind(s.customer_id).first<{ id: number }>();
  if (!user) {
    // Customer not linked yet — could happen if customer.created hasn't fired or user signed up after sub.
    // Insert a placeholder row keyed only by Square sub id; we'll backfill user_id when linkage happens.
    return;
  }
  await env.DB.prepare(
    `INSERT INTO subscriptions (square_subscription_id, user_id, square_customer_id, plan_variation_id, status, start_date, charged_through_date, card_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(square_subscription_id) DO UPDATE
         SET status = excluded.status,
             plan_variation_id = excluded.plan_variation_id,
             start_date = excluded.start_date,
             charged_through_date = excluded.charged_through_date,
             card_id = excluded.card_id,
             updated_at = unixepoch()`
  ).bind(
    s.id,
    user.id,
    s.customer_id,
    s.plan_variation_id ?? '',
    s.status ?? 'UNKNOWN',
    s.start_date ?? new Date().toISOString().slice(0, 10),
    s.charged_through_date ?? null,
    s.card_id ?? null
  ).run();
}

interface CustomerEventObject {
  customer?: { id?: string; email_address?: string };
}

async function handleCustomerEvent(env: Env, event: SquareWebhookEvent): Promise<void> {
  const obj = (event.data?.object ?? {}) as CustomerEventObject;
  const cust = obj.customer;
  if (!cust?.id) return;
  const email = (cust.email_address ?? '').toLowerCase().trim();
  if (!email) return;
  // Link our user to this Square customer if a user with the same email exists and is unlinked.
  await env.DB.prepare(
    `UPDATE users
       SET square_customer_id = ?, updated_at = unixepoch()
       WHERE email = ? AND square_customer_id IS NULL`
  ).bind(cust.id, email).run();
}

export default webhooks;
