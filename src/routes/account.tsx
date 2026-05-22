import { Hono } from 'hono';
import type { Context } from 'hono';
import { html } from 'hono/html';
import { Layout } from '../views/layout';
import { csrfToken } from '../lib/csrf';
import { squareFetch } from '../lib/square';
import { formatMoneyCents } from '../lib/money';
import { requireAuth } from '../middleware/auth';
import { pauseSubscription, resumeSubscription, cancelSubscription, retrieveSubscription } from '../lib/subscriptions';
import type { Env, HonoVars } from '../types';

const account = new Hono<{ Bindings: Env; Variables: HonoVars }>();

account.use('*', requireAuth);

interface SquareOrderSearchResp {
  orders?: SquareOrder[];
  cursor?: string;
}
interface SquareOrder {
  id: string;
  location_id: string;
  reference_id?: string;
  state?: string; // OPEN, COMPLETED, CANCELED, DRAFT
  created_at?: string;
  updated_at?: string;
  customer_id?: string;
  total_money?: { amount: number; currency: string };
  line_items?: Array<{ name?: string; quantity?: string; base_price_money?: { amount: number; currency: string }; gross_sales_money?: { amount: number; currency: string } }>;
  fulfillments?: Array<{ type?: string; state?: string }>;
  metadata?: Record<string, string>;
}

/** GET /account — overview */
account.get('/', async (c) => {
  const userId = c.get('user_id')!;
  const user = await c.env.DB.prepare(`SELECT email, square_customer_id, created_at FROM users WHERE id = ?`).bind(userId).first<{ email: string; square_customer_id: string | null; created_at: number }>();
  if (!user) return c.redirect('/logout', 303);
  return c.html(
    Layout({
      c,
      title: 'Account',
      children: html`
        <section class="section">
          <div class="container">
            <header class="page-header">
              <h1>Account</h1>
              <p>Signed in as <strong>${user.email}</strong></p>
            </header>
            <nav class="account-nav">
              <a href="/account" class="account-nav-link active">Overview</a>
              <a href="/account/orders" class="account-nav-link">Orders</a>
              <a href="/account/subscriptions" class="account-nav-link">Subscriptions</a>
              <form method="post" action="/logout" style="display:inline-block;margin-left:auto;">
                <input type="hidden" name="_csrf" value="${csrfToken(c)}">
                <button type="submit" class="link-button">Sign out</button>
              </form>
            </nav>
            <div class="account-cards">
              <a class="account-card" href="/account/orders">
                <h2>Orders</h2>
                <p>View your past orders and shipping status.</p>
              </a>
              <a class="account-card" href="/account/subscriptions">
                <h2>Subscriptions</h2>
                <p>Manage your subscription, pause or cancel.</p>
              </a>
            </div>
          </div>
        </section>`,
    })
  );
});

/** GET /account/orders */
account.get('/orders', async (c) => {
  const userId = c.get('user_id')!;
  const user = await c.env.DB.prepare(`SELECT email, square_customer_id FROM users WHERE id = ?`).bind(userId).first<{ email: string; square_customer_id: string | null }>();
  if (!user) return c.redirect('/logout', 303);

  let orders: SquareOrder[] = [];
  if (user.square_customer_id) {
    try {
      const resp = await squareFetch<SquareOrderSearchResp>(c.env, '/v2/orders/search', {
        method: 'POST',
        body: {
          location_ids: [c.env.SQUARE_LOCATION_ID],
          query: {
            filter: { customer_filter: { customer_ids: [user.square_customer_id] } },
            sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' },
          },
          limit: 50,
        },
      });
      orders = resp.orders ?? [];
    } catch (err) {
      console.warn('account.orders.fetch.failed', { message: err instanceof Error ? err.message : String(err) });
    }
  }

  return c.html(
    Layout({
      c,
      title: 'Orders',
      children: html`
        <section class="section">
          <div class="container">
            <header class="page-header">
              <h1>Orders</h1>
              <p>${orders.length} ${orders.length === 1 ? 'order' : 'orders'} on file.</p>
            </header>
            ${orders.length === 0
              ? html`<div class="empty-state-card">
                  <p>You haven't placed any orders yet.</p>
                  <a class="btn btn-primary" href="/catalog">Start shopping</a>
                </div>`
              : html`<ul class="order-list">
                  ${orders.map(
                    (o) => html`<li class="order-list-item">
                      <a href="/account/orders/${encodeURIComponent(o.id)}" class="order-list-link">
                        <div class="order-list-meta">
                          <span class="order-list-date">${(o.created_at ?? '').slice(0, 10)}</span>
                          <span class="order-list-state order-list-state-${(o.state ?? 'OPEN').toLowerCase()}">${o.state ?? 'OPEN'}</span>
                        </div>
                        <div class="order-list-id">Order ${o.id.slice(0, 8)}</div>
                        <div class="order-list-total">${formatMoneyCents(o.total_money?.amount ?? 0, o.total_money?.currency ?? 'USD')}</div>
                      </a>
                    </li>`
                  )}
                </ul>`}
          </div>
        </section>`,
    })
  );
});

/** GET /account/orders/:id — verify ownership via square_customer_id */
account.get('/orders/:id', async (c) => {
  const userId = c.get('user_id')!;
  const orderId = c.req.param('id') ?? '';
  const user = await c.env.DB.prepare(`SELECT email, square_customer_id FROM users WHERE id = ?`).bind(userId).first<{ email: string; square_customer_id: string | null }>();
  if (!user) return c.redirect('/logout', 303);
  if (!user.square_customer_id) {
    c.status(404);
    return c.html(orderNotFound(c));
  }

  let order: SquareOrder | null = null;
  try {
    const resp = await squareFetch<{ order?: SquareOrder }>(c.env, `/v2/orders/${encodeURIComponent(orderId)}`);
    if (resp.order && resp.order.customer_id === user.square_customer_id) {
      order = resp.order;
    }
  } catch (err) {
    console.warn('account.order.fetch.failed', { id: orderId, message: err instanceof Error ? err.message : String(err) });
  }

  if (!order) {
    c.status(404);
    return c.html(orderNotFound(c));
  }

  return c.html(
    Layout({
      c,
      title: `Order ${order.id.slice(0, 8)}`,
      children: html`
        <section class="section">
          <div class="container narrow-col">
            <header class="page-header">
              <h1>Order ${order.id.slice(0, 8)}</h1>
              <p>Placed ${(order.created_at ?? '').slice(0, 10)} · ${order.state ?? 'OPEN'}</p>
            </header>
            <ul class="order-detail-lines">
              ${(order.line_items ?? []).map(
                (li) => html`<li class="order-detail-line">
                  <span class="order-detail-line-name">${li.name ?? ''}</span>
                  <span class="order-detail-line-qty">×${li.quantity ?? '1'}</span>
                  <span class="order-detail-line-amount">${formatMoneyCents(li.gross_sales_money?.amount ?? 0, li.gross_sales_money?.currency ?? 'USD')}</span>
                </li>`
              )}
            </ul>
            <div class="order-detail-total"><strong>Total:</strong> ${formatMoneyCents(order.total_money?.amount ?? 0, order.total_money?.currency ?? 'USD')}</div>
            <p><a href="/account/orders">← All orders</a></p>
          </div>
        </section>`,
    })
  );
});

/** GET /account/subscriptions */
account.get('/subscriptions', async (c) => {
  const userId = c.get('user_id')!;
  const rows = await c.env.DB.prepare(
    `SELECT square_subscription_id, plan_variation_id, status, start_date, next_billing_date, charged_through_date
       FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC`
  ).bind(userId).all<{
    square_subscription_id: string;
    plan_variation_id: string;
    status: string;
    start_date: string;
    next_billing_date: string | null;
    charged_through_date: string | null;
  }>();
  const items = rows.results ?? [];
  const token = csrfToken(c);
  return c.html(
    Layout({
      c,
      title: 'Subscriptions',
      children: html`
        <section class="section">
          <div class="container">
            <header class="page-header">
              <h1>Subscriptions</h1>
              <p>${items.length} subscription${items.length === 1 ? '' : 's'}.</p>
            </header>
            ${items.length === 0
              ? html`<div class="empty-state-card">
                  <p>You don't have any active subscriptions.</p>
                  <a class="btn btn-primary" href="/subscriptions">Browse plans</a>
                </div>`
              : html`<ul class="sub-list">
                  ${items.map(
                    (s) => html`<li class="sub-item">
                      <div class="sub-meta">
                        <div class="sub-status sub-status-${s.status.toLowerCase()}">${s.status}</div>
                        <div class="sub-id">Sub ${s.square_subscription_id.slice(0, 8)}</div>
                        <div class="sub-dates">
                          Started ${s.start_date}
                          ${s.next_billing_date ? html` · Next charge ${s.next_billing_date}` : ''}
                        </div>
                      </div>
                      <div class="sub-actions">
                        ${s.status === 'ACTIVE'
                          ? html`<form method="post" action="/account/subscriptions/${s.square_subscription_id}/pause">
                              <input type="hidden" name="_csrf" value="${token}">
                              <button type="submit" class="btn btn-secondary btn-sm">Pause</button>
                            </form>
                            <form method="post" action="/account/subscriptions/${s.square_subscription_id}/cancel" onsubmit="return confirm('Cancel this subscription?');">
                              <input type="hidden" name="_csrf" value="${token}">
                              <button type="submit" class="btn btn-secondary btn-sm">Cancel</button>
                            </form>`
                          : s.status === 'PAUSED'
                            ? html`<form method="post" action="/account/subscriptions/${s.square_subscription_id}/resume">
                                <input type="hidden" name="_csrf" value="${token}">
                                <button type="submit" class="btn btn-primary btn-sm">Resume</button>
                              </form>
                              <form method="post" action="/account/subscriptions/${s.square_subscription_id}/cancel" onsubmit="return confirm('Cancel this subscription?');">
                                <input type="hidden" name="_csrf" value="${token}">
                                <button type="submit" class="btn btn-secondary btn-sm">Cancel</button>
                              </form>`
                            : ''}
                      </div>
                    </li>`
                  )}
                </ul>`}
          </div>
        </section>`,
    })
  );
});

/** Subscription lifecycle actions — verify ownership before calling Square. */
type AccountCtx = Context<{ Bindings: Env; Variables: HonoVars }>;

async function verifyOwnership(c: AccountCtx, subId: string): Promise<boolean> {
  const userId = c.get('user_id') as number | undefined;
  if (!userId) return false;
  const row = await c.env.DB.prepare(
    `SELECT 1 FROM subscriptions WHERE square_subscription_id = ? AND user_id = ?`
  ).bind(subId, userId).first();
  if (row) return true;
  // Fallback: check Square directly (covers race where webhook hasn't fired yet).
  const user = await (c.env.DB.prepare(`SELECT square_customer_id FROM users WHERE id = ?`).bind(userId).first() as Promise<{ square_customer_id: string | null } | null>);
  if (!user?.square_customer_id) return false;
  const sub = await retrieveSubscription(c.env, subId).catch(() => null);
  return Boolean(sub && sub.customer_id === user.square_customer_id);
}

account.post('/subscriptions/:id/pause', async (c) => {
  const subId = c.req.param('id') ?? '';
  if (!(await verifyOwnership(c, subId))) { c.status(404); return c.text('Not found'); }
  await pauseSubscription(c.env, subId).catch((err: unknown) => console.warn('sub.pause.failed', err));
  return c.redirect('/account/subscriptions', 303);
});

account.post('/subscriptions/:id/resume', async (c) => {
  const subId = c.req.param('id') ?? '';
  if (!(await verifyOwnership(c, subId))) { c.status(404); return c.text('Not found'); }
  await resumeSubscription(c.env, subId).catch((err: unknown) => console.warn('sub.resume.failed', err));
  return c.redirect('/account/subscriptions', 303);
});

account.post('/subscriptions/:id/cancel', async (c) => {
  const subId = c.req.param('id') ?? '';
  if (!(await verifyOwnership(c, subId))) { c.status(404); return c.text('Not found'); }
  await cancelSubscription(c.env, subId).catch((err: unknown) => console.warn('sub.cancel.failed', err));
  return c.redirect('/account/subscriptions', 303);
});

function orderNotFound(c: any) {
  return Layout({
    c,
    title: 'Order not found',
    children: html`<section class="section"><div class="container narrow-col">
      <h1>Order not found</h1>
      <p>This order doesn't exist or you don't have permission to view it.</p>
      <p><a href="/account/orders">← All orders</a></p>
    </div></section>`,
  });
}

export default account;
