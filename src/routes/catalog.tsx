import { Hono } from 'hono';
import { html } from 'hono/html';
import { Layout } from '../views/layout';
import { ProductCard } from '../views/components/product-card';
import { getCatalog, getCategoryById, itemsInCategory } from '../lib/catalog';
import type { Env, HonoVars } from '../types';

const catalog = new Hono<{ Bindings: Env; Variables: HonoVars }>();

catalog.get('/', async (c) => {
  const snap = await getCatalog(c.env, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });
  const visibleCategories = snap.categories.filter((cat) => cat.onlineVisible);

  return c.html(
    Layout({
      c,
      title: 'Shop',
      description: 'Browse our full collection of hand-crafted press-on nail sets.',
      children: html`
        <section class="section">
          <div class="container">
            <header class="page-header">
              <h1>Shop</h1>
              <p>${snap.items.length} ${snap.items.length === 1 ? 'product' : 'products'} available.</p>
            </header>
            ${visibleCategories.length > 0
              ? html`<nav class="category-nav" aria-label="Categories">
                  <a href="/catalog" class="category-chip active">All</a>
                  ${visibleCategories.map(
                    (cat) =>
                      html`<a href="/catalog/${encodeURIComponent(cat.id)}" class="category-chip">${cat.name}</a>`
                  )}
                </nav>`
              : ''}
            ${snap.items.length === 0
              ? html`<p class="empty-state">No products available right now. Please check back soon.</p>`
              : html`<div class="product-grid">
                  ${snap.items.map((it) => ProductCard({ item: it, snap }))}
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
  const visibleCategories = snap.categories.filter((c2) => c2.onlineVisible);

  return c.html(
    Layout({
      c,
      title: cat.name,
      children: html`
        <section class="section">
          <div class="container">
            <header class="page-header">
              <h1>${cat.name}</h1>
              <p>${items.length} ${items.length === 1 ? 'product' : 'products'}.</p>
            </header>
            <nav class="category-nav" aria-label="Categories">
              <a href="/catalog" class="category-chip">All</a>
              ${visibleCategories.map(
                (c2) =>
                  html`<a href="/catalog/${encodeURIComponent(c2.id)}" class="category-chip ${c2.id === cat.id ? 'active' : ''}">${c2.name}</a>`
              )}
            </nav>
            ${items.length === 0
              ? html`<p class="empty-state">No products in this category right now.</p>`
              : html`<div class="product-grid">
                  ${items.map((it) => ProductCard({ item: it, snap }))}
                </div>`}
          </div>
        </section>`,
    })
  );
});

export default catalog;
