/**
 * Square API client (raw fetch, Workers-compatible).
 *
 * Why not the `square` npm SDK?  Hono+Workers builds are sensitive to bundle
 * size and Node-compat shims.  Raw fetch with a thin typed wrapper is ~2KB,
 * fast, and gives us full control over redaction, timeouts, retries, and
 * idempotency keys.
 */
import { safeLog } from './redact';
import type { Env } from '../types';

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 200;

export interface SquareRequestOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  idempotencyKey?: string;
  query?: Record<string, string | number | undefined>;
  /** Override timeout for this call. */
  timeoutMs?: number;
  /** Override retry count. 0 = no retries. */
  maxRetries?: number;
}

export interface SquareError {
  category: string;
  code: string;
  detail?: string;
  field?: string;
}

export class SquareApiError extends Error {
  constructor(
    public status: number,
    public errors: SquareError[],
    public requestId?: string
  ) {
    super(`Square API ${status}: ${errors.map((e) => `${e.category}/${e.code} ${e.detail ?? ''}`).join(', ')}`);
    this.name = 'SquareApiError';
  }
}

/** Determine if a status code is retryable. */
function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/** Sleep helper for backoff (Promise-based; bundle-friendly). */
function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export async function squareFetch<T = unknown>(
  env: Env,
  path: string,
  opts: SquareRequestOpts = {}
): Promise<T> {
  const method = opts.method ?? 'GET';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;

  const url = new URL(path, env.SQUARE_API_BASE);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
    'Square-Version': env.SQUARE_VERSION,
    Accept: 'application/json',
    'User-Agent': 'fothy-storefront/0.1',
  };

  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    const payload = opts.idempotencyKey
      ? { idempotency_key: opts.idempotencyKey, ...(opts.body as object) }
      : opts.body;
    body = JSON.stringify(payload);
  }

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const start = Date.now();
    let resp: Response;
    try {
      resp = await fetch(url.toString(), {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < maxRetries) {
        await delay(BASE_BACKOFF_MS * 2 ** attempt);
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new SquareApiError(0, [{ category: 'NETWORK', code: 'FETCH_FAILED', detail: msg }]);
    }
    clearTimeout(timer);

    const latency = Date.now() - start;
    const reqId = resp.headers.get('square-request-id') ?? undefined;
    safeLog('square.req', { method, path, status: resp.status, latency_ms: latency, request_id: reqId, attempt });

    const text = await resp.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        if (!resp.ok) {
          if (isRetryable(resp.status) && attempt < maxRetries) {
            await delay(BASE_BACKOFF_MS * 2 ** attempt);
            continue;
          }
          throw new SquareApiError(
            resp.status,
            [{ category: 'NETWORK', code: 'NON_JSON', detail: text.slice(0, 500) }],
            reqId
          );
        }
        return text as unknown as T;
      }
    }

    if (!resp.ok) {
      const errs = extractSquareErrors(json) ?? [{ category: 'UNKNOWN', code: 'HTTP_' + resp.status }];
      if (isRetryable(resp.status) && attempt < maxRetries) {
        const retryAfterRaw = Number(resp.headers.get('retry-after')) || 0;
        const backoffMs = BASE_BACKOFF_MS * 2 ** attempt;
        // Cap server-provided Retry-After at 5s to avoid being parked too long by misconfigured/malicious 429s.
        const RETRY_AFTER_CAP_MS = 5_000;
        const wait = retryAfterRaw > 0
          ? Math.min(retryAfterRaw * 1000, RETRY_AFTER_CAP_MS)
          : backoffMs;
        await delay(wait);
        continue;
      }
      throw new SquareApiError(resp.status, errs, reqId);
    }

    return (json ?? {}) as T;
  }
  // unreachable
  throw lastErr instanceof Error
    ? lastErr
    : new SquareApiError(0, [{ category: 'INTERNAL', code: 'EXHAUSTED' }]);
}

function extractSquareErrors(json: unknown): SquareError[] | null {
  if (!json || typeof json !== 'object') return null;
  const errs = (json as { errors?: unknown }).errors;
  if (!Array.isArray(errs)) return null;
  return errs
    .filter((e) => e && typeof e === 'object')
    .map((e) => {
      const obj = e as Record<string, unknown>;
      return {
        category: typeof obj.category === 'string' ? obj.category : 'UNKNOWN',
        code: typeof obj.code === 'string' ? obj.code : 'UNKNOWN',
        detail: typeof obj.detail === 'string' ? obj.detail : undefined,
        field: typeof obj.field === 'string' ? obj.field : undefined,
      };
    });
}

/* ------------------------- Catalog ------------------------- */

export interface ListCatalogResp {
  objects?: SquareCatalogObject[];
  cursor?: string;
}

export interface SquareCatalogObject {
  type: string;
  id: string;
  updated_at: string;
  version?: number;
  is_deleted?: boolean;
  present_at_all_locations?: boolean;
  present_at_location_ids?: string[];
  absent_at_location_ids?: string[];
  item_data?: SquareItemData;
  item_variation_data?: SquareItemVariationData;
  category_data?: SquareCategoryData;
  image_data?: SquareImageData;
}

export interface SquareItemData {
  name?: string;
  description?: string;
  description_plaintext?: string;
  description_html?: string;
  abbreviation?: string;
  variations?: SquareCatalogObject[];
  image_ids?: string[];
  categories?: { id: string; ordinal?: number }[];
  is_archived?: boolean;
  ecom_visibility?: string;
  channels?: string[];
}

export interface SquareItemVariationData {
  item_id?: string;
  name?: string;
  sku?: string;
  upc?: string;
  ordinal?: number;
  pricing_type?: string; // FIXED_PRICING | VARIABLE_PRICING
  price_money?: { amount: number; currency: string };
  track_inventory?: boolean;
  sellable?: boolean;
  stockable?: boolean;
}

export interface SquareCategoryData {
  name?: string;
  is_top_level?: boolean;
  online_visibility?: boolean;
  ecom_seo_data?: { permalink?: string };
}

export interface SquareImageData {
  url?: string;
  caption?: string;
  name?: string;
}

export async function listCatalog(env: Env, types: string, cursor?: string): Promise<ListCatalogResp> {
  return squareFetch<ListCatalogResp>(env, '/v2/catalog/list', {
    method: 'GET',
    query: { types, cursor },
  });
}

/** Retrieve a single catalog object by id (force-fresh; bypasses our KV cache). */
export async function retrieveCatalogObject(env: Env, id: string, includeRelated = false) {
  return squareFetch<{ object?: SquareCatalogObject; related_objects?: SquareCatalogObject[] }>(env, `/v2/catalog/object/${id}`, {
    method: 'GET',
    query: { include_related_objects: String(includeRelated) },
  });
}
