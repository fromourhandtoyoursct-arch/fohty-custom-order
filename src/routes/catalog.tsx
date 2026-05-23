import { Hono } from 'hono';
import { html } from 'hono/html';
import { Layout } from '../views/layout';
import { ProductCard } from '../views/components/product-card';
import { getCatalog, getCategoryById, itemsInCategory } from '../lib/catalog';
import type { Env, HonoVars } from '../types';

const catalog = new Hono<{ Bindings: Env; Variables: HonoVars }>();

const LENGTHS = ['All', 'Short', 'Medium', 'Long'];
const SHAPES = ['All', 'Almond', 'Coffin', 'Round', 'Square', 'Squoval', 'Stiletto', 'Holiday'];

function matches(item: { name: string; description?: string | null; descriptionPlaintext?: string | null }, term: string): boolean {
  if (!term || term === 'all') return true;
  const t = term.toLowerCase();
  const hay = [item.name, item.description, item.descriptionPlaintext].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(t);
}

function filterPills(rowLabel: string, options: string[], paramName: string, current: string, baseParams: URLSearchParams) {
  return html`<div class="shop-filter-row">
    <span class="shop-filter-label">${rowLabel}:</span>
    <div class="shop-filter-pills">
      ${options.map((o) => {
        const params = new URLSearchParams(baseParams);
        if (o === 'All') params.delete(paramName);
        else params.set(paramName, o);
        const href = `/catalog${params.toString() ? '?' + params.toString() : ''}`;
        const active = (current === '' && o === 'All') || current.toLowerCase() === o.toLowerCase();
        return html`<a href="${href}" class="shop-pill ${active ? 'on' : ''}">${o}</a>`;
      })}
    </div>
  </div>`;
}

catalog.get('/', async (c) => {
  const snap = await getCatalog(c.env, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });
  const q = String(c.req.query('q') ?? '').trim().slice(0, 100);
  const shape = String(c.req.query('shape') ?? '').trim().slice(0, 32);
  const length = String(c.req.query('length') ?? '').trim().slice(0, 32);

  // Preserve cross-filter params when building pill URLs.
  const base = new URLSearchParams();
  if (q) base.set('q', q);
  if (shape) base.set('shape', shape);
  if (length) base.set('length', length);

  // Filter: q matches name/desc; shape & length search name/desc for the keyword.
  const filtered = snap.items.filter((it) => {
    if (q && !matches(it, q)) return false;
    if (shape && !matches(it, shape)) return false;
    if (length && !matches(it, length)) return false;
    return true;
  });

  const baseForShape = new URLSearchParams(base); baseForShape.delete('shape');
  const baseForLength = new URLSearchParams(base); baseForLength.delete('length');

  return c.html(
    Layout({
      c,
      title: q ? `Search: ${q}` : 'Shop',
      description: 'Browse our full collection of hand-crafted press-on nail sets.',
      children: html`
        <section style="padding-bottom: 64px;">
          <div class="wrap">
            <div class="pagehead">
              <h1 class="shop-head">${q ? `Searching for "${q}"` : 'Choose the set that is uniquely you.'}</h1>
              ${q ? html`<p class="sub"><a href="/catalog">← Clear search</a></p>` : ''}
            </div>

            <div class="shop-filters">
              ${filterPills('Length', LENGTHS, 'length', length, baseForLength)}
              ${filterPills('Shape', SHAPES, 'shape', shape, baseForShape)}
            </div>

            ${filtered.length === 0
              ? html`<div class="empty-state-card">
                  <p>No sets match your filters yet.</p>
                  <a class="btn btn-secondary btn-sm" href="/catalog">Clear filters</a>
                </div>`
              : html`<div class="cgrid">
                  ${filtered.map((it) => ProductCard({ item: it, snap }))}
                  ${!q && !shape && !length
                    ? html`<div class="shop-soon-card" aria-hidden="true">
                        <span>More being made by hand soon.</span>
                      </div>`
                    : ''}
                </div>`}
          </div>
        </section>`,
    })
  );
});

/** GET /catalog/search.json?q= — JSON results for the live search overlay */
catalog.get('/search.json', async (c) => {
  const snap = await getCatalog(c.env, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });
  const q = String(c.req.query('q') ?? '').trim().slice(0, 100).toLowerCase();
  if (!q) return c.json({ ok: true, results: [] });
  const results = snap.items
    .filter((it) => matches(it, q))
    .slice(0, 8)
    .map((it) => {
      const v = it.variations[0];
      return {
        id: it.id,
        name: it.name,
        price: v ? `$${(v.priceCents / 100).toFixed(0)}` : '',
        image: it.imageIds[0] ? (snap.imageById[it.imageIds[0]]?.url ?? '') : '',
        url: `/product/${encodeURIComponent(it.id)}`,
      };
    });
  return c.json({ ok: true, results });
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
