/**
 * Reviews — verified-purchase only, default unapproved (moderation queue).
 *
 * Storage: D1 `reviews` table.  We do NOT trust user-supplied product/order linking;
 * `assertPurchasedByUser` re-validates against Square Orders before inserting.
 */
import { squareFetch } from './square';
import type { Env } from '../types';

const MAX_TITLE = 120;
const MAX_BODY = 2000;

export interface SubmitReviewInput {
  userId: number;
  productId: string;
  orderId: string;
  rating: number;
  title?: string;
  body?: string;
}

export class ReviewError extends Error {
  constructor(public readonly code: 'invalid' | 'unverified' | 'duplicate', message: string) {
    super(message);
    this.name = 'ReviewError';
  }
}

interface SquareOrderDetail {
  order?: {
    id: string;
    customer_id?: string;
    state?: string;
    line_items?: Array<{ catalog_object_id?: string; variation_name?: string; name?: string }>;
  };
}

export async function assertPurchasedByUser(env: Env, userId: number, productId: string, orderId: string): Promise<void> {
  const user = await env.DB.prepare(`SELECT square_customer_id FROM users WHERE id = ?`).bind(userId).first<{ square_customer_id: string | null }>();
  if (!user?.square_customer_id) throw new ReviewError('unverified', 'You can only review items you purchased.');
  const resp = await squareFetch<SquareOrderDetail>(env, `/v2/orders/${encodeURIComponent(orderId)}`).catch(() => null);
  const order = resp?.order;
  if (!order) throw new ReviewError('unverified', 'Order not found.');
  if (order.customer_id !== user.square_customer_id) throw new ReviewError('unverified', "This order doesn't belong to you.");
  if (order.state !== 'COMPLETED') throw new ReviewError('unverified', 'Order is not yet completed.');
  // Match the productId against any variation's parent item OR against any line's catalog_object_id directly.
  // Since `productId` is the ITEM id and line_items reference ITEM_VARIATION ids, we resolve via catalog (cheaply — single retrieve).
  // Cheap alternative: collect all variation ids, retrieve them as related objects, check item_id matches.
  const hasMatch = await orderContainsItem(env, order.line_items ?? [], productId);
  if (!hasMatch) throw new ReviewError('unverified', "This order doesn't include that product.");
}

async function orderContainsItem(env: Env, lines: Array<{ catalog_object_id?: string }>, itemId: string): Promise<boolean> {
  const variationIds = lines.map((l) => l.catalog_object_id).filter((v): v is string => Boolean(v));
  if (variationIds.length === 0) return false;
  // BatchRetrieveCatalogObjects with related items lets us resolve parent ITEM ids in one round trip.
  const resp = await squareFetch<{ objects?: Array<{ type: string; item_variation_data?: { item_id?: string } }> }>(env, '/v2/catalog/batch-retrieve', {
    method: 'POST',
    body: { object_ids: variationIds, include_related_objects: false },
  }).catch(() => null);
  if (!resp?.objects) return false;
  return resp.objects.some((o) => o.type === 'ITEM_VARIATION' && o.item_variation_data?.item_id === itemId);
}

export async function submitReview(env: Env, input: SubmitReviewInput): Promise<void> {
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
    throw new ReviewError('invalid', 'Rating must be 1–5.');
  }
  const title = input.title?.trim().slice(0, MAX_TITLE) ?? null;
  const body = input.body?.trim().slice(0, MAX_BODY) ?? null;

  await assertPurchasedByUser(env, input.userId, input.productId, input.orderId);

  try {
    await env.DB.prepare(
      `INSERT INTO reviews (product_id, user_id, order_id, rating, title, body, approved)
         VALUES (?, ?, ?, ?, ?, ?, 0)`
    ).bind(input.productId, input.userId, input.orderId, input.rating, title, body).run();
  } catch (err) {
    // Likely UNIQUE(product_id,user_id)
    throw new ReviewError('duplicate', 'You\'ve already reviewed this product.');
  }
}

export interface PublicReview {
  rating: number;
  title: string | null;
  body: string | null;
  created_at: number;
}

export async function listApprovedReviews(env: Env, productId: string, limit = 20): Promise<PublicReview[]> {
  const rs = await env.DB.prepare(
    `SELECT rating, title, body, created_at FROM reviews
       WHERE product_id = ? AND approved = 1
       ORDER BY created_at DESC LIMIT ?`
  ).bind(productId, limit).all<PublicReview>();
  return rs.results ?? [];
}

export async function reviewSummary(env: Env, productId: string): Promise<{ avg: number | null; count: number }> {
  const row = await env.DB.prepare(
    `SELECT AVG(rating) AS avg, COUNT(*) AS cnt FROM reviews WHERE product_id = ? AND approved = 1`
  ).bind(productId).first<{ avg: number | null; cnt: number }>();
  return { avg: row?.avg ?? null, count: row?.cnt ?? 0 };
}
