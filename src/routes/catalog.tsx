import { Hono } from 'hono';
import { html } from 'hono/html';
import { Layout } from '../views/layout';
import { ProductCard } from '../views/components/product-card';
import { getCatalog, getCategoryById, itemsInCategory } from '../lib/catalog';
import type { Env, HonoVars } from '../types';

const catalog = new Hono<{ Bindings: Env; Variables: HonoVars }>();

const LENGTHS = ['All', 'Short', 'Medium', 'Long'];
const SHAPES = ['All', 'Almond', 'Coffin', 'Round', 'Square', 'Squoval', 'Stiletto', 'Holiday'];

function filterPills(rowLabel: string, options: string[]) {
  // Visual-only pills; live filtering requires Square attributes we don't yet model server-side.
  return html`<div class="shop-filter-row">
    <span class="shop-filter-label">${rowLabel}:</span>
    <div class="shop-filter-pills">
      ${options.map(
        (o, i) => html`<button type="button" class="shop-pill ${i === 0 ? 'on' : ''}" data-filter="${rowLabel.toLowerCase()}" data-value="${o}">${o}</button>`
      )}
    </div>
  </div>`;
}

catalog.get('/', async (c) => {
  const snap = await getCatalog(c.env, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });

  return c.html(
    Layout({
      c,
      title: 'Shop',
      description: 'Browse our full collection of hand-crafted press-on nail sets.',
      children: html`
        <section style="padding-bottom: 64px;">
          <div class="wrap">
            <div class="pagehead">
              <h1 class="shop-head">Choose the set that is uniquely you.</h1>
            </div>

            <div class="shop-filters">
              ${filterPills('Length', LENGTHS)}
              ${filterPills('Shape', SHAPES)}
            </div>

            ${snap.items.length === 0
              ? html`<p class="empty-state">No products available right now. Please check back soon.</p>`
              : html`<div class="cgrid">
                  ${snap.items.map((it) => ProductCard({ item: it, snap }))}
                  <div class="shop-soon-card" aria-hidden="true">
                    <span>More being made by hand soon.</span>
                  </div>
                </div>`}
          </div>
        </section>`,
    })
  );
});

catalog.get('/:categoryId', async (c) => {
  const snap = await getCatalog(c.env, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });
  const cat = getCategoryById(snap, c.req.param('categoryId') ?? '');
  if (!cat) {
    c.status(404);
    return c.html(
      Layout({
        c,
        title: 'Category not found',
        children: html`<section class="section"><div class="container"><h1>Category not found</h1><p><a href="/catalog">← Back to shop</a></p></div></section>`,
      })
    );
  }
  const items = itemsInCategory(snap, cat.id);

  return c.html(
    Layout({
      c,
      title: cat.name,
      children: html`
        <section style="padding-bottom: 64px;">
          <div class="wrap">
            <div class="pagehead">
              <h1 class="shop-head">${cat.name}</h1>
              <p class="sub">${items.length} ${items.length === 1 ? 'set' : 'sets'} in this collection.</p>
            </div>
            ${items.length === 0
              ? html`<p class="empty-state">No products in this category right now.</p>`
              : html`<div class="cgrid">
                  ${items.map((it) => ProductCard({ item: it, snap }))}
                </div>`}
            <p style="margin-top: 48px;"><a href="/catalog">← All sets</a></p>
          </div>
        </section>`,
    })
  );
});

export default catalog;
