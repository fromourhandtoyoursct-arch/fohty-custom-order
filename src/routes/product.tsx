import { Hono } from 'hono';
import { html } from 'hono/html';
import { Layout } from '../views/layout';
import { getCatalog, getItemById, primaryImageUrl } from '../lib/catalog';
import { formatMoneyCents } from '../lib/money';
import { csrfToken } from '../lib/csrf';
import { listApprovedReviews, reviewSummary } from '../lib/reviews';
import type { Env, HonoVars } from '../types';

const product = new Hono<{ Bindings: Env; Variables: HonoVars }>();

product.get('/:id', async (c) => {
  const snap = await getCatalog(c.env, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });
  const item = getItemById(snap, c.req.param('id') ?? '');
  if (!item) {
    c.status(404);
    return c.html(
      Layout({
        c,
        title: 'Product not found',
        children: html`<section class="section"><div class="container"><h1>Product not found</h1><p><a href="/catalog">← Back to shop</a></p></div></section>`,
      })
    );
  }

  const primary = primaryImageUrl(snap, item);
  const otherImages = item.imageIds
    .map((id) => snap.imageById[id])
    .filter((img): img is NonNullable<typeof img> => !!img && img.url !== primary);

  const [reviewSum, reviews] = await Promise.all([
    reviewSummary(c.env, item.id),
    listApprovedReviews(c.env, item.id, 10),
  ]);

  return c.html(
    Layout({
      c,
      title: item.name,
      description: item.descriptionPlaintext ?? item.description ?? `${item.name} — From Our Hand To Yours`,
      children: html`
        <section class="section">
          <div class="container product-detail">
            <div class="product-detail-gallery">
              ${primary
                ? html`<img class="product-detail-image" src="${primary}" alt="${escapeAttr(item.name)}" width="800" height="800" decoding="async">`
                : html`<div class="product-detail-image-fallback">No image</div>`}
              ${otherImages.length > 0
                ? html`<div class="product-detail-thumbs">
                    ${otherImages.map(
                      (img) => html`<img src="${img.url}" alt="${escapeAttr(img.caption ?? item.name)}" loading="lazy" width="120" height="120">`
                    )}
                  </div>`
                : ''}
            </div>
            <div class="product-detail-info">
              <h1>${item.name}</h1>
              ${item.variations.length === 1
                ? html`<div class="product-detail-price">${formatMoneyCents(item.variations[0]!.priceCents)}</div>`
                : html`<div class="product-detail-price product-detail-price-range">
                    From ${formatMoneyCents(Math.min(...item.variations.map((v) => v.priceCents)))}
                  </div>`}
              ${item.descriptionPlaintext || item.description
                ? html`<div class="product-detail-description">${item.descriptionPlaintext ?? item.description}</div>`
                : ''}

              <form class="add-to-cart-form" method="post" action="/cart/add" data-cart-form>
                <input type="hidden" name="_csrf" value="${csrfToken(c)}">
                ${item.variations.length > 1
                  ? html`<label class="form-field">
                      <span class="form-label">Variation</span>
                      <select name="variation_id" required>
                        ${item.variations.map(
                          (v) => html`<option value="${v.id}">${v.name || 'Default'} — ${formatMoneyCents(v.priceCents)}</option>`
                        )}
                      </select>
                    </label>`
                  : html`<input type="hidden" name="variation_id" value="${item.variations[0]!.id}">`}
                <label class="form-field form-field-qty">
                  <span class="form-label">Quantity</span>
                  <input type="number" name="quantity" value="1" min="1" max="50" required inputmode="numeric">
                </label>
                <button type="submit" class="btn btn-primary btn-large">Add to cart</button>
              </form>

              ${reviewSum.count > 0
                ? html`<div class="review-summary">
                    <strong>${reviewSum.avg ? reviewSum.avg.toFixed(1) : '—'}</strong>
                    <span class="review-stars">${stars(reviewSum.avg ?? 0)}</span>
                    <span class="review-count">${reviewSum.count} review${reviewSum.count === 1 ? '' : 's'}</span>
                  </div>`
                : html`<p class="review-summary review-summary-empty">No reviews yet.</p>`}
            </div>
          </div>
        </section>
        ${reviews.length > 0
          ? html`<section class="section section-band">
              <div class="container narrow-col">
                <h2>Reviews</h2>
                <ul class="review-list">
                  ${reviews.map(
                    (r) => html`<li class="review-item">
                      <div class="review-item-head">
                        <span class="review-stars">${stars(r.rating)}</span>
                        ${r.title ? html`<strong class="review-title">${r.title}</strong>` : ''}
                      </div>
                      ${r.body ? html`<p class="review-body">${r.body}</p>` : ''}
                    </li>`
                  )}
                </ul>
              </div>
            </section>`
          : ''}`,
    })
  );
});

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function stars(n: number): string {
  const full = Math.round(Math.max(0, Math.min(5, n)));
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

export default product;
