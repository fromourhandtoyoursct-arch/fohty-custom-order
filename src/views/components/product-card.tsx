import { html } from 'hono/html';
import { formatMoneyCents } from '../../lib/money';
import { primaryImageUrl, startingPriceCents } from '../../lib/catalog';
import type { CatalogItem, CatalogSnapshot } from '../../types';

export function ProductCard({ item, snap }: { item: CatalogItem; snap: CatalogSnapshot }) {
  const img = primaryImageUrl(snap, item);
  const startPrice = startingPriceCents(item);
  const url = `/product/${encodeURIComponent(item.id)}`;
  const priceLabel = item.variations.length > 1 ? `From ${formatMoneyCents(startPrice)}` : formatMoneyCents(startPrice);

  return html`<article class="product-card">
  <a class="product-card-link" href="${url}">
    <div class="product-card-image">
      ${img
        ? html`<img src="${img}" alt="${escapeAttr(item.name)}" loading="lazy" decoding="async" width="600" height="600">`
        : html`<div class="product-card-image-fallback">No image</div>`}
    </div>
    <div class="product-card-body">
      <h3 class="product-card-name">${item.name}</h3>
      <div class="product-card-price">${priceLabel}</div>
    </div>
  </a>
</article>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
