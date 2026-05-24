import { Hono } from 'hono';
import { html } from 'hono/html';
import { Layout } from '../views/layout';
import { ProductCard } from '../views/components/product-card';
import { getCatalog } from '../lib/catalog';
import type { Env, HonoVars } from '../types';

const search = new Hono<{ Bindings: Env; Variables: HonoVars }>();

function matches(item: { name: string; description?: string | null; descriptionPlaintext?: string | null }, term: string): boolean {
  const t = term.toLowerCase();
  const hay = [item.name, item.description, item.descriptionPlaintext].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(t);
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

search.get('/', async (c) => {
  const snap = await getCatalog(c.env, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });
  const q = String(c.req.query('q') ?? '').trim().slice(0, 100);
  const results = q ? snap.items.filter((it) => matches(it, q)) : [];

  return c.html(
    Layout({
      c,
      title: q ? `Search: ${q}` : 'Search',
      description: 'Search hand-crafted press-on sets, shapes, and palettes.',
      children: html`
        <section style="padding-bottom: 64px;">
          <div class="wrap">
            <div class="pagehead search-page-head">
              <h1 class="shop-head">${q ? `Results for "${q}"` : 'Search'}</h1>
              <form class="search-page-form" action="/search" method="get" role="search">
                <svg class="search-page-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                  <circle cx="11" cy="11" r="6.5"></circle><path d="m20 20-4.2-4.2"></path>
                </svg>
                <input class="search-page-input" name="q" type="text" value="${escapeAttr(q)}" placeholder="Search sets, shapes, palettes…" autocomplete="off" autofocus>
                <button class="search-page-submit" type="submit">Search</button>
              </form>
            </div>

            ${!q
              ? html`<div class="search-page-empty">
                  <p>Start typing above to find a set, shape, or palette.</p>
                  <div class="search-suggest-row search-page-suggest">
                    <a class="search-suggest" href="/search?q=Almond">Almond</a>
                    <a class="search-suggest" href="/search?q=Coffin">Coffin</a>
                    <a class="search-suggest" href="/search?q=Bridal">Bridal</a>
                    <a class="search-suggest" href="/search?q=Holiday">Holiday</a>
                    <a class="search-suggest" href="/search?q=Everyday">Everyday</a>
                  </div>
                </div>`
              : results.length === 0
                ? html`<div class="search-page-empty">
                    <p class="search-page-noresults">No results for "${q}".</p>
                    <p class="search-page-noresults-hint">Try a different shape, palette, or occasion — or <a href="/catalog">browse the full shop</a>.</p>
                  </div>`
                : html`<p class="search-page-count">${results.length} ${results.length === 1 ? 'set' : 'sets'} found.</p>
                  <div class="cgrid">
                    ${results.map((it) => ProductCard({ item: it, snap }))}
                  </div>`}
          </div>
        </section>`,
    })
  );
});

export default search;
