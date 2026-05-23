import { html } from 'hono/html';
import { formatMoneyCents } from '../../lib/money';
import { primaryImageUrl, startingPriceCents } from '../../lib/catalog';
import type { CatalogItem, CatalogSnapshot } from '../../types';

export function ProductCard({ item, snap }: { item: CatalogItem; snap: CatalogSnapshot }) {
  const img = primaryImageUrl(snap, item);
  const startPrice = startingPriceCents(item);
  const url = `/product/${encodeURIComponent(item.id)}`;
  const priceLabel = item.variations.length > 1 ? `From ${formatMoneyCents(startPrice)}` : formatMoneyCents(startPrice);
  // Quick add only works for single-variation items; multi-variation must hit PDP for selection.
  const singleVar = item.variations.length === 1 ? item.variations[0] : null;

  return html`<article class="product-card" data-product-name="${escapeAttr(item.name)}">
  <a class="product-card-link" href="${url}">
    <div class="product-card-image">
      ${img
        ? html`<img src="${img}" alt="${escapeAttr(item.name)}" loading="lazy" decoding="async" width="600" height="600">`
        : html`<div class="product-card-image-fallback">No image</div>`}
      ${singleVar
        ? html`<div class="product-card-quick">
            <button type="button" class="btn btn-primary btn-sm btn-block"
              data-quick-add data-variation-id="${singleVar.id}" data-product-name="${escapeAttr(item.name)}">
              Quick add · ${formatMoneyCents(singleVar.priceCents)}
            </button>
          </div>`
        : ''}
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
