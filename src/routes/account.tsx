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
  state?: string;
  created_at?: string;
  updated_at?: string;
  customer_id?: string;
  total_money?: { amount: number; currency: string };
  line_items?: Array<{ name?: string; quantity?: string; base_price_money?: { amount: number; currency: string }; gross_sales_money?: { amount: number; currency: string } }>;
  fulfillments?: Array<{ type?: string; state?: string }>;
  metadata?: Record<string, string>;
}

type AccountCtx = Context<{ Bindings: Env; Variables: HonoVars }>;

function acctNav(active: 'overview' | 'orders' | 'subs', token: string) {
  const link = (id: string, href: string, label: string) =>
    html`<a href="${href}" class="acct-nav-link ${id === active ? 'on' : ''}">${label}</a>`;
  return html`<nav class="acct-nav" aria-label="Account">
    ${link('overview', '/account', 'Overview')}
    ${link('orders', '/account/orders', 'Orders')}
    ${link('subs', '/account/subscriptions', 'Subscriptions')}
    <form method="post" action="/logout" class="acct-nav-signout">
      <input type="hidden" name="_csrf" value="${token}">
      <button type="submit" class="acct-nav-link acct-nav-signout-btn">Sign out</button>
    </form>
  </nav>`;
}

/** GET /account — overview */
account.get('/', async (c) => {
  const userId = c.get('user_id')!;
  const user = await c.env.DB.prepare(`SELECT email, square_customer_id, created_at FROM users WHERE id = ?`).bind(userId).first<{ email: string; square_customer_id: string | null; created_at: number }>();
  if (!user) return c.redirect('/logout', 303);
  const token = csrfToken(c);

  // Pull recent orders preview (limit 3)
  let recent: SquareOrder[] = [];
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
          limit: 3,
        },
      });
      recent = resp.orders ?? [];
    } catch { /* ignore */ }
  }
  const activeSubsCount = (await c.env.DB.prepare(
    `SELECT COUNT(*) as n FROM subscriptions WHERE user_id = ? AND status = 'ACTIVE'`
  ).bind(userId).first<{ n: number }>())?.n ?? 0;

  const firstName = user.email.split('@')[0];

  return c.html(
    Layout({
      c,
      title: 'Account',
      children: html`
        <section style="padding-bottom: 64px;">
          <div class="wrap">
            <div class="pagehead">
              <span class="eyebrow">Your account</span>
              <h1>Welcome back, ${firstName}.</h1>
            </div>
            <div class="acct-grid">
              ${acctNav('overview', token)}
              <div class="acct-content">
                <div class="acct-tiles">
                  <div class="acct-tile">
                    <span class="eyebrow">Made For You, Monthly</span>
                    <h4>${activeSubsCount > 0 ? `${activeSubsCount} active subscription${activeSubsCount === 1 ? '' : 's'}` : 'Not subscribed yet'}</h4>
                    <p>${activeSubsCount > 0 ? 'Manage cadence, pause or cancel.' : 'A fresh set delivered every month.'}</p>
                    <a class="btn-link acct-tile-link" href="${activeSubsCount > 0 ? '/account/subscriptions' : '/subscriptions'}">${activeSubsCount > 0 ? 'Manage →' : 'See plans →'}</a>
                  </div>
                  <div class="acct-tile">
                    <span class="eyebrow">Custom order</span>
                    <h4>Design something just for you</h4>
                    <p>Tell us what you're dreaming up.</p>
                    <a class="btn-link acct-tile-link" href="/custom-order">Start a brief →</a>
                  </div>
                  <div class="acct-tile">
                    <span class="eyebrow">Email</span>
                    <h4 class="acct-tile-mono">${user.email}</h4>
                    <p>This is the address we send order updates to.</p>
                  </div>
                </div>

                <span class="eyebrow acct-section-eyebrow">Recent orders</span>
                ${recent.length === 0
                  ? html`<div class="acct-empty">
                      <p>You haven't placed any orders yet.</p>
                      <a class="btn btn-primary btn-sm" href="/catalog">Start shopping</a>
                    </div>`
                  : html`<div class="acct-orders-preview">
                      ${recent.map(
                        (o) => html`<a class="acct-order-row" href="/account/orders/${encodeURIComponent(o.id)}">
                          <code class="acct-order-id">${o.id.slice(0, 8)}</code>
                          <div class="acct-order-meta">
                            <div class="acct-order-line">${(o.line_items ?? []).slice(0, 2).map((li) => li.name ?? '').filter(Boolean).join(', ') || 'Order'}</div>
                            <div class="acct-order-date">${(o.created_at ?? '').slice(0, 10)}</div>
                          </div>
                          <span class="acct-order-state acct-order-state-${(o.state ?? 'OPEN').toLowerCase()}">${o.state ?? 'OPEN'}</span>
                          <span class="acct-order-total">${formatMoneyCents(o.total_money?.amount ?? 0, o.total_money?.currency ?? 'USD')}</span>
                          <span class="btn-link acct-order-link">Details →</span>
                        </a>`
                      )}
                      <a class="btn-link acct-orders-all" href="/account/orders">All orders →</a>
                    </div>`}
              </div>
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
  const token = csrfToken(c);

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
        <section style="padding-bottom: 64px;">
          <div class="wrap">
            <div class="pagehead">
              <span class="eyebrow">Your account</span>
              <h1>Orders</h1>
            </div>
            <div class="acct-grid">
              ${acctNav('orders', token)}
              <div class="acct-content">
                ${orders.length === 0
                  ? html`<div class="acct-empty">
                      <p>You haven't placed any orders yet.</p>
                      <a class="btn btn-primary btn-sm" href="/catalog">Start shopping</a>
                    </div>`
                  : html`<div class="acct-orders-preview">
                      ${orders.map(
                        (o) => html`<a class="acct-order-row" href="/account/orders/${encodeURIComponent(o.id)}">
                          <code class="acct-order-id">${o.id.slice(0, 8)}</code>
                          <div class="acct-order-meta">
                            <div class="acct-order-line">${(o.line_items ?? []).slice(0, 2).map((li) => li.name ?? '').filter(Boolean).join(', ') || 'Order'}</div>
                            <div class="acct-order-date">${(o.created_at ?? '').slice(0, 10)}</div>
                          </div>
                          <span class="acct-order-state acct-order-state-${(o.state ?? 'OPEN').toLowerCase()}">${o.state ?? 'OPEN'}</span>
                          <span class="acct-order-total">${formatMoneyCents(o.total_money?.amount ?? 0, o.total_money?.currency ?? 'USD')}</span>
                          <span class="btn-link acct-order-link">Details →</span>
                        </a>`
                      )}
                    </div>`}
              </div>
            </div>
          </div>
        </section>`,
    })
  );
});

/** GET /account/orders/:id */
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
  const token = csrfToken(c);

  return c.html(
    Layout({
      c,
      title: `Order ${order.id.slice(0, 8)}`,
      children: html`
        <section style="padding-bottom: 64px;">
          <div class="wrap">
            <div class="pagehead">
              <span class="eyebrow">Order ${order.id.slice(0, 8)}</span>
              <h1>Order detail</h1>
            </div>
            <div class="acct-grid">
              ${acctNav('orders', token)}
              <div class="acct-content">
                <p class="acct-order-summary">Placed ${(order.created_at ?? '').slice(0, 10)} · ${order.state ?? 'OPEN'}</p>
                <ul class="order-detail-lines">
                  ${(order.line_items ?? []).map(
                    (li) => html`<li class="order-detail-line">
                      <span class="order-detail-line-name">${li.name ?? ''}</span>
                      <span class="order-detail-line-qty">×${li.quantity ?? '1'}</span>
                      <span class="order-detail-line-amount">${formatMoneyCents(li.gross_sales_money?.amount ?? 0, li.gross_sales_money?.currency ?? 'USD')}</span>
                    </li>`
                  )}
                </ul>
                <div class="acct-order-total-row"><strong>Total</strong> ${formatMoneyCents(order.total_money?.amount ?? 0, order.total_money?.currency ?? 'USD')}</div>
                <p><a class="btn-link" href="/account/orders">← All orders</a></p>
              </div>
            </div>
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
        <section style="padding-bottom: 64px;">
          <div class="wrap">
            <div class="pagehead">
              <span class="eyebrow">Your account</span>
              <h1>Subscriptions</h1>
            </div>
            <div class="acct-grid">
              ${acctNav('subs', token)}
              <div class="acct-content">
                ${items.length === 0
                  ? html`<div class="acct-empty">
                      <p>You don't have any active subscriptions.</p>
                      <a class="btn btn-primary btn-sm" href="/subscriptions">Browse plans</a>
                    </div>`
                  : html`<ul class="acct-subs">
                      ${items.map(
                        (s) => html`<li class="acct-sub">
                          <div class="acct-sub-meta">
                            <div class="acct-sub-status acct-sub-status-${s.status.toLowerCase()}">${s.status}</div>
                            <div class="acct-sub-id">Sub ${s.square_subscription_id.slice(0, 8)}</div>
                            <div class="acct-sub-dates">
                              Started ${s.start_date}
                              ${s.next_billing_date ? html` · Next charge ${s.next_billing_date}` : ''}
                            </div>
                          </div>
                          <div class="acct-sub-actions">
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
            </div>
          </div>
        </section>`,
    })
  );
});

async function verifyOwnership(c: AccountCtx, subId: string): Promise<boolean> {
  const userId = c.get('user_id') as number | undefined;
  if (!userId) return false;
  const row = await c.env.DB.prepare(
    `SELECT 1 FROM subscriptions WHERE square_subscription_id = ? AND user_id = ?`
  ).bind(subId, userId).first();
  if (row) return true;
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
