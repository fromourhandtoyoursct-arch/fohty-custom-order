/**
 * Catalog cache layer.
 *
 * Reads from Square Catalog API in pages, normalizes into a compact
 * { items, categories, imageById } snapshot, and stores in KV.
 *
 * - Schema-validated on read (bad cache => treat as cold).
 * - Soft-stale: serve cached snapshot immediately, refresh in background via
 *   ctx.waitUntil when available (no stampede).
 * - On hard-stale (no cache), synchronous refresh; on Square failure during
 *   refresh, callers receive an empty snapshot rather than a throw.
 */
import type {
  CatalogCategory,
  CatalogImage,
  CatalogItem,
  CatalogSnapshot,
  CatalogVariation,
  Env,
} from '../types';
import { listCatalog, type SquareCatalogObject } from './square';

const CACHE_KEY = 'catalog:current';
const SCHEMA_VERSION = 2;
const CACHE_TTL_SECONDS = 60 * 60 * 6;
const SOFT_REFRESH_SECONDS = 60 * 5;
const REFRESH_LOCK_KEY = 'catalog:refreshing';
const REFRESH_LOCK_TTL_SECONDS = 60;
const PAGE_HARD_CAP = 100;

interface StoredSnapshot extends CatalogSnapshot {
  schemaVersion: number;
}

/** Schema-validated cache read; returns null on any mismatch. */
async function readCache(env: Env): Promise<CatalogSnapshot | null> {
  const raw = await env.CACHE.get(CACHE_KEY, { type: 'json' });
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<StoredSnapshot>;
  if (s.schemaVersion !== SCHEMA_VERSION) return null;
  if (typeof s.version !== 'number' || typeof s.fetchedAt !== 'number') return null;
  if (!Array.isArray(s.items) || !Array.isArray(s.categories) || typeof s.imageById !== 'object' || s.imageById === null) {
    return null;
  }
  // Deep validation: every item must have minimal required shape; otherwise treat as corrupt.
  for (const it of s.items) {
    if (
      !it || typeof it !== 'object' ||
      typeof (it as CatalogItem).id !== 'string' ||
      typeof (it as CatalogItem).name !== 'string' ||
      !Array.isArray((it as CatalogItem).variations) ||
      !Array.isArray((it as CatalogItem).imageIds) ||
      !Array.isArray((it as CatalogItem).categoryIds)
    ) {
      return null;
    }
    for (const v of (it as CatalogItem).variations) {
      if (!v || typeof v !== 'object' || typeof v.id !== 'string' || typeof v.priceCents !== 'number' || typeof v.currency !== 'string') {
        return null;
      }
    }
  }
  for (const cat of s.categories) {
    if (!cat || typeof cat !== 'object' || typeof (cat as CatalogCategory).id !== 'string' || typeof (cat as CatalogCategory).name !== 'string') {
      return null;
    }
  }
  for (const img of Object.values(s.imageById)) {
    if (!img || typeof img !== 'object' || typeof (img as CatalogImage).id !== 'string' || typeof (img as CatalogImage).url !== 'string') {
      return null;
    }
  }
  return s as CatalogSnapshot;
}

export interface GetCatalogOpts {
  forceRefresh?: boolean;
  /** Cloudflare ExecutionContext for background refresh. */
  waitUntil?: (p: Promise<unknown>) => void;
}

export async function getCatalog(env: Env, opts: GetCatalogOpts = {}): Promise<CatalogSnapshot> {
  if (!opts.forceRefresh) {
    const cached = await readCache(env);
    if (cached) {
      const ageSec = (Date.now() - cached.fetchedAt) / 1000;
      if (ageSec < SOFT_REFRESH_SECONDS) return cached;
      // Soft-stale: serve cached, kick refresh in background (single-flight via KV lock).
      const refreshPromise = maybeBackgroundRefresh(env);
      if (opts.waitUntil) {
        opts.waitUntil(refreshPromise);
      } else {
        // No waitUntil; just don't await — we don't want to block this request.
        refreshPromise.catch(() => undefined);
      }
      return cached;
    }
  }
  // Cold cache (or forced).  Synchronous refresh, return empty snapshot on failure.
  try {
    return await refreshCatalog(env);
  } catch (err) {
    console.error('catalog.cold-refresh.failed', err instanceof Error ? err.message : String(err));
    return emptySnapshot();
  }
}

function emptySnapshot(): CatalogSnapshot {
  return {
    version: 0,
    fetchedAt: 0,
    items: [],
    categories: [],
    imageById: {},
  };
}

async function maybeBackgroundRefresh(env: Env): Promise<void> {
  // Atomic single-flight lock via D1 (KV has no CAS semantics).
  // We use a `cache_locks` table created on demand; INSERT OR IGNORE returns rowcount=0
  // when another worker already holds the lock.
  const now = Math.floor(Date.now() / 1000);
  const expires = now + REFRESH_LOCK_TTL_SECONDS;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS cache_locks (
       key TEXT PRIMARY KEY,
       expires_at INTEGER NOT NULL
     )`
  ).run().catch(() => undefined);
  // Try to claim or refresh-claim a stale lock.
  const claim = await env.DB.prepare(
    `INSERT INTO cache_locks (key, expires_at) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at
       WHERE cache_locks.expires_at < ?
     RETURNING key`
  ).bind(REFRESH_LOCK_KEY, expires, now).first();
  if (!claim) return; // someone else holds an unexpired lock
  try {
    await refreshCatalog(env);
  } catch (err) {
    console.warn('catalog.bg-refresh.failed', err instanceof Error ? err.message : String(err));
  } finally {
    await env.DB.prepare(`DELETE FROM cache_locks WHERE key = ?`).bind(REFRESH_LOCK_KEY).run().catch(() => undefined);
  }
}

export async function refreshCatalog(env: Env): Promise<CatalogSnapshot> {
  const [itemPages, varPages, catPages, imgPages] = await Promise.all([
    fetchAllType(env, 'ITEM'),
    fetchAllType(env, 'ITEM_VARIATION'),
    fetchAllType(env, 'CATEGORY'),
    fetchAllType(env, 'IMAGE'),
  ]);

  const targetLocation = env.SQUARE_LOCATION_ID;

  // Variations: filter out non-sellable / non-fixed-priced / $0 / not-at-location
  const variationsByItem = new Map<string, CatalogVariation[]>();
  for (const o of varPages) {
    if (o.is_deleted) continue;
    const d = o.item_variation_data ?? {};
    const itemId = d.item_id ?? '';
    if (!itemId) continue;
    if (d.sellable === false) continue;
    if (d.pricing_type && d.pricing_type !== 'FIXED_PRICING') continue;
    if (!itemPresentAtLocation(o, targetLocation)) continue;
    const amount = d.price_money?.amount;
    if (!amount || amount <= 0) continue;
    const arr = variationsByItem.get(itemId) ?? [];
    arr.push({
      id: o.id,
      itemId,
      name: d.name ?? '',
      priceCents: amount,
      currency: d.price_money?.currency ?? 'USD',
      sku: d.sku,
      upc: d.upc,
      ordinal: d.ordinal ?? 0,
    });
    variationsByItem.set(itemId, arr);
  }

  const categories: CatalogCategory[] = catPages
    .filter((o) => !o.is_deleted)
    .map((o) => ({
      id: o.id,
      name: o.category_data?.name ?? '',
      isTopLevel: o.category_data?.is_top_level ?? false,
      onlineVisible: o.category_data?.online_visibility ?? false,
    }));

  const imageById: Record<string, CatalogImage> = {};
  for (const o of imgPages) {
    if (o.is_deleted || !o.image_data?.url) continue;
    imageById[o.id] = {
      id: o.id,
      url: o.image_data.url,
      caption: o.image_data.caption,
    };
  }

  const items: CatalogItem[] = itemPages
    .filter((o) => !o.is_deleted)
    .filter((o) => itemPresentAtLocation(o, targetLocation))
    .map((o) => {
      const d = o.item_data ?? {};
      const itemVars = (variationsByItem.get(o.id) ?? []).sort((a, b) => a.ordinal - b.ordinal);
      return {
        id: o.id,
        name: d.name ?? '',
        description: d.description,
        descriptionPlaintext: d.description_plaintext,
        imageIds: d.image_ids ?? [],
        variations: itemVars,
        categoryIds: (d.categories ?? []).map((c) => c.id),
        isArchived: d.is_archived ?? false,
        presentAtLocationIds: o.present_at_location_ids,
        updatedAt: o.updated_at,
        ecomVisible: (d.ecom_visibility ?? 'VISIBLE').toUpperCase() === 'VISIBLE',
      };
    })
    .filter((i) => !i.isArchived && i.ecomVisible && i.variations.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  const snap: CatalogSnapshot = {
    version: Date.now(),
    fetchedAt: Date.now(),
    items,
    categories,
    imageById,
  };

  const stored: StoredSnapshot = { ...snap, schemaVersion: SCHEMA_VERSION };
  await env.CACHE.put(CACHE_KEY, JSON.stringify(stored), { expirationTtl: CACHE_TTL_SECONDS });
  return snap;
}

function itemPresentAtLocation(o: SquareCatalogObject, locationId: string): boolean {
  if (o.present_at_all_locations) {
    // Could still be absent at our specific location via absent_at_location_ids.
    return !(o.absent_at_location_ids ?? []).includes(locationId);
  }
  return (o.present_at_location_ids ?? []).includes(locationId);
}

async function fetchAllType(env: Env, type: string): Promise<SquareCatalogObject[]> {
  const out: SquareCatalogObject[] = [];
  let cursor: string | undefined = undefined;
  let pageCount = 0;
  do {
    const resp = await listCatalog(env, type, cursor);
    for (const obj of resp.objects ?? []) out.push(obj);
    cursor = resp.cursor;
    pageCount += 1;
    if (pageCount >= PAGE_HARD_CAP && cursor) {
      // Partial result.  Loud failure beats silent truncation.
      throw new Error(`catalog.fetchAllType type=${type} exceeded ${PAGE_HARD_CAP} pages without exhausting cursor`);
    }
  } while (cursor);
  return out;
}

export function getItemById(snap: CatalogSnapshot, id: string): CatalogItem | undefined {
  return snap.items.find((i) => i.id === id);
}

export function getCategoryById(snap: CatalogSnapshot, id: string): CatalogCategory | undefined {
  return snap.categories.find((c) => c.id === id);
}

export function itemsInCategory(snap: CatalogSnapshot, categoryId: string): CatalogItem[] {
  return snap.items.filter((i) => i.categoryIds.includes(categoryId));
}

export function primaryImageUrl(snap: CatalogSnapshot, item: CatalogItem): string | null {
  for (const id of item.imageIds) {
    const img = snap.imageById[id];
    if (img?.url) return img.url;
  }
  return null;
}

export function startingPriceCents(item: CatalogItem): number {
  if (item.variations.length === 0) return 0;
  return Math.min(...item.variations.map((v) => v.priceCents));
}
