/**
 * Gift card activation (webhook-driven, idempotent).
 *
 * Flow:
 *   1. Buyer purchases a "Gift Card" catalog item via normal checkout.
 *   2. `payment.updated` (status COMPLETED) webhook fires.
 *   3. We check if the order contains gift-card line items (heuristic:
 *      catalog object's parent ITEM is in the GIFT_CARD product type set,
 *      or name matches /gift card/i — exact detection is merchant-config dependent).
 *   4. For each gift card line: INSERT-or-IGNORE into `gift_card_activations` (PK = order_id).
 *      On insert, call Square `CreateGiftCard` + `CreateGiftCardActivity(type=ACTIVATE)`,
 *      then UPDATE status='active', email recipient.
 *
 * Idempotency: the PK on (square_order_id) makes activation single-shot regardless
 * of webhook retries.
 */
import { squareFetch } from './square';
import { sha256Hex } from './crypto';
import { sendEmail } from './email';
import { formatMoneyCents } from './money';
import type { Env } from '../types';

interface SquareOrderForGiftcard {
  id: string;
  customer_id?: string;
  line_items?: Array<{
    catalog_object_id?: string;
    name?: string;
    quantity?: string;
    base_price_money?: { amount: number; currency: string };
    gross_sales_money?: { amount: number; currency: string };
    note?: string;
  }>;
  metadata?: Record<string, string>;
}

interface SquareItemLookup {
  objects?: Array<{ type: string; id: string; item_variation_data?: { item_id?: string; price_money?: { amount: number; currency: string } } }>;
  related_objects?: Array<{ type: string; id: string; item_data?: { name?: string; product_type?: string } }>;
}

/**
 * Activates any unprocessed gift cards in the given order.  Safe to call multiple times.
 */
export async function activateGiftCardsForOrder(env: Env, orderId: string, paymentId: string): Promise<void> {
  // Look up order details fresh from Square.
  const resp = await squareFetch<{ order?: SquareOrderForGiftcard }>(env, `/v2/orders/${encodeURIComponent(orderId)}`).catch(() => null);
  const order = resp?.order;
  if (!order || !order.line_items?.length) return;

  // Resolve catalog parent items to identify gift cards.
  const variationIds = order.line_items.map((l) => l.catalog_object_id).filter((v): v is string => Boolean(v));
  if (variationIds.length === 0) return;
  const lookup = await squareFetch<SquareItemLookup>(env, '/v2/catalog/batch-retrieve', {
    method: 'POST',
    body: { object_ids: variationIds, include_related_objects: true },
  }).catch(() => null);
  if (!lookup?.objects) return;

  // Build a map: variation_id -> parent ITEM with product_type.
  const itemById = new Map<string, { name: string; productType: string }>();
  for (const r of lookup.related_objects ?? []) {
    if (r.type === 'ITEM') itemById.set(r.id, { name: r.item_data?.name ?? '', productType: r.item_data?.product_type ?? '' });
  }
  const giftLineVariationIds = new Set<string>();
  for (const v of lookup.objects ?? []) {
    if (v.type !== 'ITEM_VARIATION') continue;
    const parent = v.item_variation_data?.item_id ? itemById.get(v.item_variation_data.item_id) : null;
    if (!parent) continue;
    if (parent.productType === 'GIFT_CARD' || /gift\s*card/i.test(parent.name)) {
      giftLineVariationIds.add(v.id);
    }
  }
  if (giftLineVariationIds.size === 0) return;

  // For each gift card line, attempt activation.
  for (const line of order.line_items) {
    if (!line.catalog_object_id || !giftLineVariationIds.has(line.catalog_object_id)) continue;
    const amount = line.gross_sales_money?.amount ?? line.base_price_money?.amount ?? 0;
    if (amount <= 0) continue;
    const rawRecipient = (order.metadata?.gift_recipient_email ?? '').trim().toLowerCase();
    // Validate strictly: same regex as elsewhere in the app; reject obvious provider syntax abuse.
    const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
    if (!EMAIL_RE.test(rawRecipient) || rawRecipient.length > 254) {
      console.warn('giftcard.recipient.invalid', { order_id: orderId });
      continue;
    }
    const recipientEmail = rawRecipient;
    const recipientName = (order.metadata?.gift_recipient_name ?? '').slice(0, 120);
    const senderName = (order.metadata?.gift_sender_name ?? '').slice(0, 120);
    const giftMessage = (order.metadata?.gift_message ?? '').slice(0, 500);

    // Idempotent claim per order_id.
    const inserted = await env.DB.prepare(
      `INSERT INTO gift_card_activations (square_order_id, square_payment_id, recipient_email, recipient_name, sender_name, gift_message, amount_cents, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
         ON CONFLICT(square_order_id) DO NOTHING
         RETURNING square_order_id`
    ).bind(orderId, paymentId, recipientEmail.toLowerCase(), recipientName, senderName, giftMessage, amount).first();
    if (!inserted) continue; // already processed (or in flight)

    try {
      const idem = (await sha256Hex(`gc-${orderId}-${line.catalog_object_id}`)).slice(0, 40);
      const created = await squareFetch<{ gift_card?: { id: string; gan: string } }>(env, '/v2/gift-cards', {
        method: 'POST',
        body: { location_id: env.SQUARE_LOCATION_ID, gift_card: { type: 'DIGITAL' } },
        idempotencyKey: idem,
      });
      const gc = created.gift_card;
      if (!gc?.id) throw new Error('CreateGiftCard returned no id');

      const actIdem = (await sha256Hex(`gca-${orderId}-${line.catalog_object_id}`)).slice(0, 40);
      await squareFetch(env, '/v2/gift-cards/activities', {
        method: 'POST',
        body: {
          gift_card_activity: {
            gift_card_id: gc.id,
            type: 'ACTIVATE',
            location_id: env.SQUARE_LOCATION_ID,
            activate_activity_details: {
              amount_money: { amount, currency: 'USD' },
              order_id: orderId,
            },
          },
        },
        idempotencyKey: actIdem,
      });

      await env.DB.prepare(
        `UPDATE gift_card_activations SET gift_card_id = ?, gan = ?, status = 'active', activated_at = unixepoch() WHERE square_order_id = ?`
      ).bind(gc.id, gc.gan, orderId).run();

      // Email recipient with the GAN.
      await sendEmail(env, {
        to: recipientEmail,
        subject: `${senderName ? `${senderName} sent you` : 'You received'} a gift card from ${env.EMAIL_FROM_NAME}`,
        html: giftCardEmailHtml({ recipientName, senderName, giftMessage, amount, gan: gc.gan, env }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await env.DB.prepare(`UPDATE gift_card_activations SET status='failed', error=? WHERE square_order_id = ?`).bind(msg.slice(0, 500), orderId).run();
      console.error('giftcard.activation.failed', { order_id: orderId, error: msg });
    }
  }
}

function giftCardEmailHtml(args: { recipientName: string; senderName: string; giftMessage: string; amount: number; gan: string; env: Env }): string {
  const { recipientName, senderName, giftMessage, amount, gan, env } = args;
  return `<!DOCTYPE html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#2c4a38;background:#F5F0E8;padding:40px;">
    <table style="max-width:520px;margin:0 auto;background:#fefdfb;border-radius:12px;padding:32px;border:1px solid #b8d4c4;">
      <tr><td>
        <h1 style="font-family:Georgia,serif;font-size:24px;color:#2c4a38;">A gift just for you</h1>
        ${recipientName ? `<p>Hi ${escape(recipientName)},</p>` : ''}
        ${senderName ? `<p><strong>${escape(senderName)}</strong> sent you a ${formatMoneyCents(amount)} gift card.</p>` : `<p>You've received a ${formatMoneyCents(amount)} gift card.</p>`}
        ${giftMessage ? `<blockquote style="border-left:3px solid #5C8B6E;padding:8px 14px;color:#5a7a68;font-style:italic;">${escape(giftMessage)}</blockquote>` : ''}
        <div style="margin:28px 0;padding:18px;background:#eef5f1;border-radius:8px;text-align:center;">
          <div style="font-size:12px;color:#5a7a68;text-transform:uppercase;letter-spacing:0.05em;">Your gift card code</div>
          <div style="font-family:monospace;font-size:22px;color:#2c4a38;margin-top:8px;letter-spacing:0.05em;">${escape(gan)}</div>
        </div>
        <p style="font-size:14px;">Use this code on the payment page during checkout at <a href="${env.SITE_ORIGIN}" style="color:#5C8B6E;">${env.SITE_ORIGIN}</a>.</p>
        <p style="font-size:12px;color:#8aa898;margin-top:24px;">Keep this email safe — anyone with this code can redeem the gift.</p>
      </td></tr>
    </table>
  </body></html>`;
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
