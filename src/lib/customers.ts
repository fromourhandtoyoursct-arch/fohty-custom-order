/**
 * Square Customers helpers — link our users to Square customers by email.
 */
import { squareFetch } from './square';
import type { Env } from '../types';

interface SearchCustomersResp {
  customers?: Array<{ id: string; email_address?: string }>;
}

interface CreateCustomerResp {
  customer?: { id: string };
}

/** Look up an existing Square Customer by email, or create one. Returns customer_id. */
export async function findOrCreateSquareCustomer(env: Env, email: string): Promise<string> {
  const normalized = email.toLowerCase().trim();
  // Search by exact email — Square's search endpoint supports email filter.
  try {
    const resp = await squareFetch<SearchCustomersResp>(env, '/v2/customers/search', {
      method: 'POST',
      body: {
        query: { filter: { email_address: { exact: normalized } } },
        limit: 1,
      },
    });
    const found = resp.customers?.[0];
    if (found?.id) return found.id;
  } catch (err) {
    console.warn('square.customer.search.failed', { message: err instanceof Error ? err.message : String(err) });
    // Fall through to create
  }

  const created = await squareFetch<CreateCustomerResp>(env, '/v2/customers', {
    method: 'POST',
    body: { email_address: normalized },
    idempotencyKey: `cust-${await sha256ShortHash(normalized)}`,
  });
  if (!created.customer?.id) throw new Error('Failed to create Square customer');
  return created.customer.id;
}

/** Ensure our local user row has a `square_customer_id`; create the linkage if missing. */
export async function ensureUserHasSquareCustomer(env: Env, userId: number): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT email, square_customer_id FROM users WHERE id = ?`).bind(userId).first<{ email: string; square_customer_id: string | null }>();
  if (!row) return null;
  if (row.square_customer_id) return row.square_customer_id;
  const customerId = await findOrCreateSquareCustomer(env, row.email);
  await env.DB.prepare(`UPDATE users SET square_customer_id = ?, updated_at = unixepoch() WHERE id = ? AND square_customer_id IS NULL`).bind(customerId, userId).run();
  return customerId;
}

async function sha256ShortHash(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}
