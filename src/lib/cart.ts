/**
 * Cart layer.
 *
 * Storage: KV keyed by `cart:{cart_id}`.  Cart_id is held in `__Host-cart` cookie.
 *
 * Authority model:
 *   - We trust only `variation_id` and `qty` from the cart.
 *   - Every read for display rehydrates `item_name`, `variation_name`, `unit_price_cents`
 *     and `image_url` from the catalog snapshot — never from the cart blob.
 *   - At /checkout we additionally force-fresh each line from Square Catalog
 *     (bypassing the KV cache) to defeat stale-cache pricing.
 */
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { randomToken } from './crypto';
import { getCatalog, getItemById, primaryImageUrl } from './catalog';
import { retrieveCatalogObject } from './square';
import type { Cart, CartItem, Env, HonoVars, HydratedCart, HydratedCartLine } from '../types';

/** Serialize cart mutations across edges via D1 lock table. */
async function withCartLock<T>(env: Env, cartId: string, fn: () => Promise<T>): Promise<T> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS cache_locks (key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`
  ).run().catch(() => undefined);
  const key = `cart:${cartId}`;
  const now = Math.floor(Date.now() / 1000);
  const expires = now + 10;
  // Try to acquire — succeed if no row OR existing row is expired.
  for (let attempt = 0; attempt < 5; attempt++) {
    const got = await env.DB.prepare(
      `INSERT INTO cache_locks (key, expires_at) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at
         WHERE cache_locks.expires_at < ?
       RETURNING key`
    ).bind(key, expires, now).first();
    if (got) break;
    if (attempt === 4) throw new Error('Cart busy, please retry.');
    // brief backoff
    await new Promise((r) => setTimeout(r, 100 + attempt * 100));
  }
  try {
    return await fn();
  } finally {
    await env.DB.prepare(`DELETE FROM cache_locks WHERE key = ?`).bind(key).run().catch(() => undefined);
  }
}

const COOKIE_NAME = '__Host-cart';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
const KV_PREFIX = 'cart:';
const KV_TTL_SECONDS = COOKIE_MAX_AGE_SECONDS;
const MAX_LINE_QTY = 50;
const MAX_CART_QTY = 200;
const MAX_DISTINCT_LINES = 50;

export function cartKvKey(cartId: string): string {
  return KV_PREFIX + cartId;
}

/** Read or initialize the cart cookie; populates `c.var.cart_id`. */
export function ensureCartCookie(c: Context<{ Bindings: Env; Variables: HonoVars }>): string {
  let id = getCookie(c, COOKIE_NAME);
  if (!id || !/^[A-Za-z0-9_-]{16,128}$/.test(id)) {
    id = randomToken(32);
    setCookie(c, COOKIE_NAME, id, {
      path: '/',
      sameSite: 'Lax',
      secure: true,
      httpOnly: true,
      maxAge: COOKIE_MAX_AGE_SECONDS,
    });
  }
  c.set('cart_id', id);
  return id;
}

export async function loadCart(env: Env, cartId: string): Promise<Cart> {
  const raw = await env.CACHE.get(cartKvKey(cartId), { type: 'json' });
  if (!raw || typeof raw !== 'object') return emptyCart(cartId);
  const c = raw as Partial<Cart>;
  if (typeof c.id !== 'string' || c.id !== cartId) return emptyCart(cartId);
  if (!Array.isArray(c.items)) return emptyCart(cartId);
  // Validate item shapes; drop any malformed line rather than fail the cart.
  const items: CartItem[] = [];
  for (const it of c.items) {
    if (
      it && typeof it === 'object' &&
      typeof (it as CartItem).variation_id === 'string' &&
      typeof (it as CartItem).qty === 'number' &&
      (it as CartItem).qty > 0
    ) {
      items.push({
        variation_id: (it as CartItem).variation_id,
        qty: Math.min(Math.floor((it as CartItem).qty), MAX_LINE_QTY),
        added_at: typeof (it as CartItem).added_at === 'number' ? (it as CartItem).added_at : Date.now(),
      });
    }
  }
  return {
    id: cartId,
    items,
    version: typeof c.version === 'number' ? c.version : 0,
    created_at: typeof c.created_at === 'number' ? c.created_at : Date.now(),
    updated_at: typeof c.updated_at === 'number' ? c.updated_at : Date.now(),
  };
}

export async function saveCart(env: Env, cart: Cart): Promise<void> {
  cart.version += 1;
  cart.updated_at = Date.now();
  await env.CACHE.put(cartKvKey(cart.id), JSON.stringify(cart), { expirationTtl: KV_TTL_SECONDS });
}

export async function clearCart(env: Env, cartId: string): Promise<void> {
  await env.CACHE.delete(cartKvKey(cartId));
}

function emptyCart(id: string): Cart {
  return { id, items: [], version: 0, created_at: Date.now(), updated_at: Date.now() };
}

export async function addToCart(env: Env, cartId: string, variationId: string, qty: number): Promise<Cart> {
  const safeQty = Math.max(1, Math.min(Math.floor(qty || 1), MAX_LINE_QTY));
  return withCartLock(env, cartId, async () => {
    const cart = await loadCart(env, cartId);
    if (cart.items.length >= MAX_DISTINCT_LINES && !cart.items.some((i) => i.variation_id === variationId)) {
      throw new CartError('Cart has too many distinct items.');
    }
    const totalQty = cart.items.reduce((n, i) => n + i.qty, 0);
    if (totalQty + safeQty > MAX_CART_QTY) {
      throw new CartError('Cart quantity limit reached.');
    }
    const existing = cart.items.find((i) => i.variation_id === variationId);
    if (existing) {
      existing.qty = Math.min(MAX_LINE_QTY, existing.qty + safeQty);
    } else {
      cart.items.push({ variation_id: variationId, qty: safeQty, added_at: Date.now() });
    }
    await saveCart(env, cart);
    return cart;
  });
}

export async function updateCartLine(env: Env, cartId: string, variationId: string, qty: number): Promise<Cart> {
  return withCartLock(env, cartId, async () => {
    const cart = await loadCart(env, cartId);
    const safeQty = Math.max(0, Math.min(Math.floor(qty || 0), MAX_LINE_QTY));
    const line = cart.items.find((i) => i.variation_id === variationId);
    if (!line) return cart;
    if (safeQty === 0) {
      cart.items = cart.items.filter((i) => i.variation_id !== variationId);
    } else {
      line.qty = safeQty;
    }
    await saveCart(env, cart);
    return cart;
  });
}

export async function removeCartLine(env: Env, cartId: string, variationId: string): Promise<Cart> {
  return withCartLock(env, cartId, async () => {
    const cart = await loadCart(env, cartId);
    cart.items = cart.items.filter((i) => i.variation_id !== variationId);
    await saveCart(env, cart);
    return cart;
  });
}

export class CartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CartError';
  }
}

/** Hydrate cart with catalog snapshot for display (NOT for checkout — see hydrateCartForCheckout). */
export async function hydrateCartForDisplay(env: Env, cart: Cart, opts?: { waitUntil?: (p: Promise<unknown>) => void }): Promise<HydratedCart> {
  const snap = await getCatalog(env, opts);
  const lines: HydratedCartLine[] = [];
  let subtotal = 0;
  let currency = 'USD';
  let anyUnavailable = false;
  for (const it of cart.items) {
    // Find the variation by id across all items.
    let foundItem = null as ReturnType<typeof getItemById> | null;
    let foundVar = null as { id: string; name: string; priceCents: number; currency: string } | null;
    for (const item of snap.items) {
      const v = item.variations.find((vv) => vv.id === it.variation_id);
      if (v) {
        foundItem = item;
        foundVar = v;
        break;
      }
    }
    if (!foundItem || !foundVar) {
      lines.push({
        variation_id: it.variation_id,
        qty: it.qty,
        item_id: '',
        item_name: 'Unavailable',
        variation_name: '',
        unit_price_cents: 0,
        currency,
        image_url: null,
        line_subtotal_cents: 0,
        available: false,
        reason: 'This item is no longer available.',
      });
      anyUnavailable = true;
      continue;
    }
    const lineSubtotal = foundVar.priceCents * it.qty;
    subtotal += lineSubtotal;
    currency = foundVar.currency;
    lines.push({
      variation_id: it.variation_id,
      qty: it.qty,
      item_id: foundItem.id,
      item_name: foundItem.name,
      variation_name: foundVar.name,
      unit_price_cents: foundVar.priceCents,
      currency: foundVar.currency,
      image_url: primaryImageUrl(snap, foundItem),
      line_subtotal_cents: lineSubtotal,
      available: true,
    });
  }
  return {
    id: cart.id,
    version: cart.version,
    lines,
    subtotal_cents: subtotal,
    currency,
    any_unavailable: anyUnavailable,
  };
}

/** Force-fresh hydration for checkout — re-fetches each variation from Square directly. */
export async function hydrateCartForCheckout(env: Env, cart: Cart): Promise<HydratedCart> {
  const lines: HydratedCartLine[] = [];
  let subtotal = 0;
  let currency = 'USD';
  let anyUnavailable = false;
  // Resolve each variation directly from Square; this is the authoritative price/availability snapshot.
  await Promise.all(
    cart.items.map(async (it) => {
      try {
        const resp = await retrieveCatalogObject(env, it.variation_id, true);
        const obj = resp.object;
        if (!obj || obj.is_deleted || obj.type !== 'ITEM_VARIATION') {
          lines.push(unavailableLine(it, 'Item not found'));
          anyUnavailable = true;
          return;
        }
        const d = obj.item_variation_data ?? {};
        if (d.sellable === false || (d.pricing_type && d.pricing_type !== 'FIXED_PRICING')) {
          lines.push(unavailableLine(it, 'Item not sellable'));
          anyUnavailable = true;
          return;
        }
        // location check
        const present = obj.present_at_all_locations
          ? !(obj.absent_at_location_ids ?? []).includes(env.SQUARE_LOCATION_ID)
          : (obj.present_at_location_ids ?? []).includes(env.SQUARE_LOCATION_ID);
        if (!present) {
          lines.push(unavailableLine(it, 'Not available at this location'));
          anyUnavailable = true;
          return;
        }
        const amount = d.price_money?.amount;
        if (!amount || amount <= 0) {
          lines.push(unavailableLine(it, 'No price set'));
          anyUnavailable = true;
          return;
        }
        // resolve parent item — must be present, not archived, and ecom-visible
        const parentItem = (resp.related_objects ?? []).find((o) => o.type === 'ITEM' && o.id === d.item_id);
        if (!parentItem) {
          lines.push(unavailableLine(it, 'Item not found'));
          anyUnavailable = true;
          return;
        }
        if (parentItem.item_data?.is_archived) {
          lines.push(unavailableLine(it, 'Item archived'));
          anyUnavailable = true;
          return;
        }
        // Defend against direct-link purchasing of hidden/UNAVAILABLE items.
        const vis = (parentItem.item_data?.ecom_visibility ?? 'VISIBLE').toUpperCase();
        if (vis !== 'VISIBLE') {
          lines.push(unavailableLine(it, 'Item not available for sale'));
          anyUnavailable = true;
          return;
        }
        const lineSubtotal = amount * it.qty;
        subtotal += lineSubtotal;
        currency = d.price_money?.currency ?? 'USD';
        lines.push({
          variation_id: it.variation_id,
          qty: it.qty,
          item_id: d.item_id ?? '',
          item_name: parentItem?.item_data?.name ?? '',
          variation_name: d.name ?? '',
          unit_price_cents: amount,
          currency,
          image_url: null,
          line_subtotal_cents: lineSubtotal,
          available: true,
        });
      } catch (err) {
        console.warn('cart.checkout.hydrate.failed', { variation_id: it.variation_id, err: err instanceof Error ? err.message : String(err) });
        lines.push(unavailableLine(it, 'Could not verify item'));
        anyUnavailable = true;
      }
    })
  );
  return {
    id: cart.id,
    version: cart.version,
    lines,
    subtotal_cents: subtotal,
    currency,
    any_unavailable: anyUnavailable,
  };
}

function unavailableLine(it: CartItem, reason: string): HydratedCartLine {
  return {
    variation_id: it.variation_id,
    qty: it.qty,
    item_id: '',
    item_name: 'Unavailable',
    variation_name: '',
    unit_price_cents: 0,
    currency: 'USD',
    image_url: null,
    line_subtotal_cents: 0,
    available: false,
    reason,
  };
}
