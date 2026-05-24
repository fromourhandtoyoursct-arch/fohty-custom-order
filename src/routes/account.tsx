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
  fulfillments?: Array<{ type?: string; state?: string; shipment_details?: { recipient?: { address?: SquareAddress; display_name?: string } } }>;
  metadata?: Record<string, string>;
}

interface SquareAddress {
  address_line_1?: string;
  address_line_2?: string;
  locality?: string;
  administrative_district_level_1?: string;
  postal_code?: string;
  country?: string;
}

interface SquareCustomer {
  id: string;
  email_address?: string;
  given_name?: string;
  family_name?: string;
  address?: SquareAddress;
}

type AccountCtx = Context<{ Bindings: Env; Variables: HonoVars }>;
type Tab = 'dashboard' | 'orders' | 'subs' | 'addresses' | 'settings';

function acctNav(active: Tab) {
  const link = (id: Tab, href: string, label: string) =>
    html`<a href="${href}" class="acct-tab ${id === active ? 'on' : ''}">${label}</a>`;
  return html`<nav class="acct-tabbar" aria-label="Account">
    ${link('orders', '/account/orders', 'Orders')}
    ${link('subs', '/account/subscriptions', 'Subscriptions')}
    ${link('addresses', '/account/addresses', 'Addresses')}
    ${link('settings', '/account/settings', 'Settings')}
  </nav>`;
}

function acctHeader(name: string, email: string) {
  return html`<div class="acct-dash-head">
    <h1 class="acct-dash-title">Welcome back, ${name}.</h1>
    <p class="acct-dash-email">${email}</p>
  </div>`;
}

function firstNameFrom(email: string): string {
  const local = email.split('@')[0] ?? '';
  if (!local) return 'there';
  const cleaned = local.replace(/[._\-+]+/g, ' ').trim();
  if (!cleaned) return 'there';
  const first = cleaned.split(/\s+/)[0]!;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function orderStatusLabel(state: string | undefined): string {
  const s = (state ?? 'OPEN').toUpperCase();
  if (s === 'COMPLETED') return 'Completed';
  if (s === 'CANCELED') return 'Canceled';
  if (s === 'DRAFT') return 'Draft';
  return 'In progress';
}

async function fetchOrders(c: AccountCtx, squareCustomerId: string | null, limit: number): Promise<SquareOrder[]> {
  if (!squareCustomerId) return [];
  try {
    const resp = await squareFetch<SquareOrderSearchResp>(c.env, '/v2/orders/search', {
      method: 'POST',
      body: {
        location_ids: [c.env.SQUARE_LOCATION_ID],
        query: {
          filter: { customer_filter: { customer_ids: [squareCustomerId] } },
          sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' },
        },
        limit,
      },
    });
    return resp.orders ?? [];
  } catch (err) {
    console.warn('account.orders.fetch.failed', { message: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

async function fetchCustomer(c: AccountCtx, squareCustomerId: string): Promise<SquareCustomer | null> {
  try {
    const resp = await squareFetch<{ customer?: SquareCustomer }>(c.env, `/v2/customers/${encodeURIComponent(squareCustomerId)}`);
    return resp.customer ?? null;
  } catch (err) {
    console.warn('account.customer.fetch.failed', { message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

function shippingAddressFromOrder(order: SquareOrder): SquareAddress | null {
  for (const f of order.fulfillments ?? []) {
    const addr = f.shipment_details?.recipient?.address;
    if (addr && addr.address_line_1) return addr;
  }
  return null;
}

function recipientNameFromOrder(order: SquareOrder): string | null {
  for (const f of order.fulfillments ?? []) {
    const n = f.shipment_details?.recipient?.display_name;
    if (n) return n;
  }
  return null;
}

function renderOrderRow(o: SquareOrder) {
  const date = (o.created_at ?? '').slice(0, 10);
  const productName = (o.line_items ?? []).slice(0, 2).map((li) => li.name ?? '').filter(Boolean).join(', ') || 'Order';
  const status = orderStatusLabel(o.state);
  const total = formatMoneyCents(o.total_money?.amount ?? 0, o.total_money?.currency ?? 'USD');
  const stateClass = (o.state ?? 'open').toLowerCase();
  return html`<a class="acct-activity-row" href="/account/orders/${encodeURIComponent(o.id)}">
    <span class="acct-activity-date">${date}</span>
    <span class="acct-activity-name">${productName}</span>
    <span class="acct-activity-badge acct-activity-badge-${stateClass}">${status}</span>
    <span class="acct-activity-price">${total}</span>
  </a>`;
}

/** GET /account — dashboard overview */
account.get('/', async (c) => {
  const userId = c.get('user_id')!;
  const user = await c.env.DB.prepare(`SELECT email, square_customer_id, created_at FROM users WHERE id = ?`).bind(userId).first<{ email: string; square_customer_id: string | null; created_at: number }>();
  if (!user) return c.redirect('/logout', 303);

  const recent = await fetchOrders(c, user.square_customer_id, 5);
  const ordersInProgress = recent.filter((o) => {
    const s = (o.state ?? 'OPEN').toUpperCase();
    return s !== 'COMPLETED' && s !== 'CANCELED';
  });
  const subs = await c.env.DB.prepare(
    `SELECT status FROM subscriptions WHERE user_id = ?`
  ).bind(userId).all<{ status: string }>();
  const subsRows = subs.results ?? [];
  const activeSubsCount = subsRows.filter((r) => r.status === 'ACTIVE').length;
  const pausedSubsCount = subsRows.filter((r) => r.status === 'PAUSED').length;

  const name = firstNameFrom(user.email);

  const currentOrderCount = ordersInProgress.length;
  const currentOrdersStatus = currentOrderCount === 0
    ? (recent.length === 0 ? 'No orders yet' : 'All caught up')
    : (currentOrderCount === 1 ? '1 in progress' : `${currentOrderCount} in progress`);

  const subscriptionsStatus = activeSubsCount > 0
    ? `${activeSubsCount} active${pausedSubsCount > 0 ? ` · ${pausedSubsCount} paused` : ''}`
    : (pausedSubsCount > 0 ? `${pausedSubsCount} paused` : 'No active subscriptions');

  return c.html(
    Layout({
      c,
      title: 'Account',
      children: html`
        <section style="padding-bottom: 64px;">
          <div class="wrap">
            ${acctHeader(name, user.email)}
            ${acctNav('dashboard')}

            <div class="acct-dash-cards">
              <article class="acct-dash-card">
                <h3 class="acct-dash-card-title">Current Orders</h3>
                <div class="acct-dash-card-count">${currentOrderCount > 0 ? currentOrderCount : recent.length}</div>
                <p class="acct-dash-card-status">${currentOrdersStatus}</p>
                <a class="acct-dash-card-link" href="/account/orders">View orders →</a>
              </article>
              <article class="acct-dash-card">
                <h3 class="acct-dash-card-title">Subscriptions</h3>
                <div class="acct-dash-card-count">${activeSubsCount + pausedSubsCount}</div>
                <p class="acct-dash-card-status">${subscriptionsStatus}</p>
                <a class="acct-dash-card-link" href="/account/subscriptions">Manage →</a>
              </article>
              <article class="acct-dash-card">
                <h3 class="acct-dash-card-title">Quick Actions</h3>
                <div class="acct-dash-actions">
                  <a class="acct-dash-action" href="/account/orders">Check order status</a>
                  <a class="acct-dash-action" href="/account/subscriptions">Manage subscription</a>
                  <a class="acct-dash-action" href="/account/addresses">Edit address</a>
                </div>
              </article>
            </div>

            <div class="acct-activity">
              <h2 class="acct-activity-head">Recent Activity</h2>
              ${recent.length === 0
                ? html`<div class="acct-activity-empty">
                    <p>No recent activity yet. When you place an order, you'll see it here.</p>
                    <a class="btn btn-primary btn-sm" href="/catalog">Start shopping</a>
                  </div>`
                : html`<div class="acct-activity-list">
                    ${recent.map((o) => renderOrderRow(o))}
                  </div>`}
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

  const orders = await fetchOrders(c, user.square_customer_id, 50);
  const name = firstNameFrom(user.email);

  return c.html(
    Layout({
      c,
      title: 'Orders',
      children: html`
        <section style="padding-bottom: 64px;">
          <div class="wrap">
            ${acctHeader(name, user.email)}
            ${acctNav('orders')}
            <div class="acct-tab-panel">
              <h2 class="acct-activity-head">Your orders</h2>
              ${orders.length === 0
                ? html`<div class="acct-activity-empty">
                    <p>You haven't placed any orders yet.</p>
                    <a class="btn btn-primary btn-sm" href="/catalog">Start shopping</a>
                  </div>`
                : html`<div class="acct-activity-list">
                    ${orders.map((o) => renderOrderRow(o))}
                  </div>`}
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
  const name = firstNameFrom(user.email);

  return c.html(
    Layout({
      c,
      title: `Order ${order.id.slice(0, 8)}`,
      children: html`
        <section style="padding-bottom: 64px;">
          <div class="wrap">
            ${acctHeader(name, user.email)}
            ${acctNav('orders')}
            <div class="acct-tab-panel">
              <p class="acct-order-summary">Order ${order.id.slice(0, 8)} · Placed ${(order.created_at ?? '').slice(0, 10)} · ${orderStatusLabel(order.state)}</p>
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
        </section>`,
    })
  );
});

/** GET /account/subscriptions */
account.get('/subscriptions', async (c) => {
  const userId = c.get('user_id')!;
  const user = await c.env.DB.prepare(`SELECT email FROM users WHERE id = ?`).bind(userId).first<{ email: string }>();
  if (!user) return c.redirect('/logout', 303);
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
  const name = firstNameFrom(user.email);
  return c.html(
    Layout({
      c,
      title: 'Subscriptions',
      children: html`
        <section style="padding-bottom: 64px;">
          <div class="wrap">
            ${acctHeader(name, user.email)}
            ${acctNav('subs')}
            <div class="acct-tab-panel">
              <h2 class="acct-activity-head">Your subscriptions</h2>
              ${items.length === 0
                ? html`<div class="acct-activity-empty">
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
        </section>`,
    })
  );
});

/** GET /account/addresses */
account.get('/addresses', async (c) => {
  const userId = c.get('user_id')!;
  const user = await c.env.DB.prepare(`SELECT email, square_customer_id FROM users WHERE id = ?`).bind(userId).first<{ email: string; square_customer_id: string | null }>();
  if (!user) return c.redirect('/logout', 303);
  const name = firstNameFrom(user.email);

  const customer = user.square_customer_id ? await fetchCustomer(c, user.square_customer_id) : null;
  const orders = await fetchOrders(c, user.square_customer_id, 10);

  const primary = customer?.address?.address_line_1 ? customer.address : null;
  const shippingAddrs: Array<{ recipient: string | null; address: SquareAddress; orderId: string }> = [];
  const seen = new Set<string>();
  for (const o of orders) {
    const addr = shippingAddressFromOrder(o);
    if (!addr) continue;
    const key = [addr.address_line_1, addr.address_line_2, addr.postal_code].filter(Boolean).join('|').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    shippingAddrs.push({ recipient: recipientNameFromOrder(o), address: addr, orderId: o.id });
  }

  const renderAddress = (addr: SquareAddress) => {
    const parts: string[] = [];
    if (addr.address_line_1) parts.push(addr.address_line_1);
    if (addr.address_line_2) parts.push(addr.address_line_2);
    const cityState = [addr.locality, addr.administrative_district_level_1].filter(Boolean).join(', ');
    const cityLine = [cityState, addr.postal_code].filter(Boolean).join(' ');
    if (cityLine) parts.push(cityLine);
    if (addr.country) parts.push(addr.country);
    return html`<div class="acct-address-lines">${parts.map((p) => html`<div>${p}</div>`)}</div>`;
  };

  const isEmpty = !primary && shippingAddrs.length === 0;

  return c.html(
    Layout({
      c,
      title: 'Addresses',
      children: html`
        <section style="padding-bottom: 64px;">
          <div class="wrap">
            ${acctHeader(name, user.email)}
            ${acctNav('addresses')}
            <div class="acct-tab-panel">
              <h2 class="acct-activity-head">Your addresses</h2>
              ${isEmpty
                ? html`<div class="acct-activity-empty">
                    <p>No saved addresses yet. Your shipping address is captured at checkout and will appear here after your first order.</p>
                    <a class="btn btn-primary btn-sm" href="/catalog">Shop sets</a>
                  </div>`
                : html`<div class="acct-address-list">
                    ${primary
                      ? html`<article class="acct-address-card">
                          <div class="acct-address-eyebrow">Primary</div>
                          <div class="acct-address-name">${customer?.given_name ?? ''} ${customer?.family_name ?? ''}</div>
                          ${renderAddress(primary)}
                          <p class="acct-address-note">To update your primary address, contact us — addresses are tied to your Square profile.</p>
                        </article>`
                      : ''}
                    ${shippingAddrs.map(
                      (s) => html`<article class="acct-address-card">
                        <div class="acct-address-eyebrow">Shipping</div>
                        ${s.recipient ? html`<div class="acct-address-name">${s.recipient}</div>` : ''}
                        ${renderAddress(s.address)}
                        <p class="acct-address-note">From order <a href="/account/orders/${encodeURIComponent(s.orderId)}">${s.orderId.slice(0, 8)}</a>. New shipping addresses are entered at checkout.</p>
                      </article>`
                    )}
                  </div>`}
            </div>
          </div>
        </section>`,
    })
  );
});

/** GET /account/settings (and legacy /profile alias) */
async function renderSettings(c: AccountCtx) {
  const userId = c.get('user_id')!;
  const user = await c.env.DB.prepare(`SELECT email, created_at FROM users WHERE id = ?`).bind(userId).first<{ email: string; created_at: number }>();
  if (!user) return c.redirect('/logout', 303);
  const token = csrfToken(c);
  const name = firstNameFrom(user.email);
  return c.html(
    Layout({
      c,
      title: 'Settings',
      children: html`
        <section style="padding-bottom: 64px;">
          <div class="wrap">
            ${acctHeader(name, user.email)}
            ${acctNav('settings')}
            <div class="acct-tab-panel">
              <h2 class="acct-activity-head">Account settings</h2>
              <div class="acct-profile-card">
                <div class="acct-pf-row"><span>Email</span><span>${user.email}</span></div>
                <div class="acct-pf-row"><span>Member since</span><span>${new Date(user.created_at * 1000).toISOString().slice(0, 10)}</span></div>
              </div>
              <p class="acct-profile-note">Your account is tied to your email. Use the same email at checkout so your orders link up here.</p>
              <form method="post" action="/logout">
                <input type="hidden" name="_csrf" value="${token}">
                <button type="submit" class="btn btn-secondary btn-sm">Sign out</button>
              </form>
            </div>
          </div>
        </section>`,
    })
  );
}
account.get('/settings', renderSettings);
account.get('/profile', renderSettings);

/** GET /account/custom-orders — preserved (linked from briefs, not in main tabbar) */
account.get('/custom-orders', async (c) => {
  const userId = c.get('user_id')!;
  const user = await c.env.DB.prepare(`SELECT email FROM users WHERE id = ?`).bind(userId).first<{ email: string }>();
  if (!user) return c.redirect('/logout', 303);
  await c.env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS custom_orders (
      id TEXT PRIMARY KEY, user_id INTEGER, email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'awaiting-review', brief_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`
  ).run().catch(() => undefined);
  const rows = await c.env.DB.prepare(
    `SELECT id, status, brief_json, created_at FROM custom_orders
       WHERE user_id = ? OR email = ?
       ORDER BY created_at DESC LIMIT 50`
  ).bind(userId, user.email.toLowerCase()).all<{ id: string; status: string; brief_json: string; created_at: number }>();
  const orders = rows.results ?? [];
  const name = firstNameFrom(user.email);
  return c.html(
    Layout({
      c,
      title: 'Custom orders',
      children: html`
        <section style="padding-bottom: 64px;">
          <div class="wrap">
            ${acctHeader(name, user.email)}
            ${acctNav('orders')}
            <div class="acct-tab-panel">
              <h2 class="acct-activity-head">Custom orders</h2>
              ${orders.length === 0
                ? html`<div class="acct-activity-empty">
                    <p>You haven't placed a custom order yet.</p>
                    <a class="btn btn-primary btn-sm" href="/custom-order">Start a brief</a>
                  </div>`
                : html`<div class="acct-activity-list">
                    ${orders.map((o) => {
                      let brief: any = {};
                      try { brief = JSON.parse(o.brief_json); } catch { /* ignore */ }
                      const date = new Date(o.created_at * 1000).toISOString().slice(0, 10);
                      const label = `${brief.shape || '—'} · ${brief.length || '—'}${brief.styles && brief.styles.length ? ' · ' + brief.styles.slice(0,2).join(', ') : ''}`;
                      return html`<div class="acct-activity-row">
                        <span class="acct-activity-date">${date}</span>
                        <span class="acct-activity-name">${label}</span>
                        <span class="acct-activity-badge acct-activity-badge-${o.status}">${o.status.replace(/-/g, ' ')}</span>
                        <span class="acct-activity-price">${brief.quantity || '1 set'}</span>
                      </div>`;
                    })}
                  </div>`}
              <p style="margin-top:24px;">
                <a class="btn btn-secondary btn-sm" href="/custom-order">+ New custom order</a>
              </p>
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
