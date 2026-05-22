/**
 * Hono context variables.  Used in middleware to pass data between layers.
 */
export type HonoVars = {
  csrf_token: string;
  csrf_skip: boolean;
  cart_id: string;
  user_id?: number;
  square_customer_id?: string;
};

/**
 * Worker environment bindings. Mirrors wrangler.jsonc.
 */
export interface Env {
  // Bindings
  DB: D1Database;
  CACHE: KVNamespace;
  SESSIONS: KVNamespace;
  ASSETS: Fetcher;

  // Vars
  SQUARE_API_BASE: string;
  SQUARE_VERSION: string;
  SQUARE_LOCATION_ID: string;
  SITE_ORIGIN: string;
  WEBHOOK_NOTIFICATION_URL: string;
  EMAIL_FROM: string;
  EMAIL_FROM_NAME: string;

  // Secrets (set via `wrangler secret put`)
  SQUARE_ACCESS_TOKEN: string;
  SQUARE_WEBHOOK_SIGNATURE_KEY?: string;
  RESEND_API_KEY?: string;
  SESSION_HMAC_KEY?: string;
}

/** Square Catalog ITEM (subset we care about). */
export interface CatalogItem {
  id: string;
  name: string;
  description?: string;
  descriptionPlaintext?: string;
  imageIds: string[];
  variations: CatalogVariation[];
  categoryIds: string[];
  isArchived: boolean;
  presentAtLocationIds?: string[];
  updatedAt: string;
  ecomVisible: boolean;
}

export interface CatalogVariation {
  id: string;
  itemId: string;
  name: string;
  priceCents: number;
  currency: string;
  sku?: string;
  upc?: string;
  ordinal: number;
}

export interface CatalogCategory {
  id: string;
  name: string;
  isTopLevel: boolean;
  onlineVisible: boolean;
}

export interface CatalogImage {
  id: string;
  url: string;
  caption?: string;
}

export interface CatalogSnapshot {
  version: number;
  fetchedAt: number;
  items: CatalogItem[];
  categories: CatalogCategory[];
  imageById: Record<string, CatalogImage>;
}

/** Cart item stored in KV — only the trust-required minimum.
 * Prices/names are NEVER trusted from this; always re-resolved against Square Catalog. */
export interface CartItem {
  variation_id: string;
  qty: number;
  added_at: number;
}

export interface Cart {
  id: string;
  items: CartItem[];
  version: number;
  created_at: number;
  updated_at: number;
}

export interface HydratedCartLine {
  variation_id: string;
  qty: number;
  item_id: string;
  item_name: string;
  variation_name: string;
  unit_price_cents: number;
  currency: string;
  image_url: string | null;
  line_subtotal_cents: number;
  available: boolean;
  reason?: string; // if !available
}

export interface HydratedCart {
  id: string;
  version: number;
  lines: HydratedCartLine[];
  subtotal_cents: number;
  currency: string;
  any_unavailable: boolean;
}
