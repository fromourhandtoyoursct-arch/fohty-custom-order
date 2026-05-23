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

  const priceLabel = item.variations.length === 1
    ? formatMoneyCents(item.variations[0]!.priceCents)
    : `From ${formatMoneyCents(Math.min(...item.variations.map((v) => v.priceCents)))}`;

  return c.html(
    Layout({
      c,
      title: item.name,
      description: item.descriptionPlaintext ?? item.description ?? `${item.name} — From Our Hand To Yours`,
      children: html`
        <section style="padding-bottom: 64px;">
          <div class="wrap">
            <nav class="pdp-breadcrumb">
              <a href="/catalog">Shop</a>
              <span>/</span>
              <span>${item.name}</span>
            </nav>

            <div class="pdp">
              <div class="pdp-gallery">
                <div class="pdp-main">
                  ${primary
                    ? html`<img src="${primary}" alt="${escapeAttr(item.name)}" width="800" height="800" decoding="async">`
                    : html`<div class="pdp-fallback">No image</div>`}
                </div>
                ${otherImages.length > 0
                  ? html`<div class="pdp-thumbs">
                      ${otherImages.map(
                        (img) => html`<img src="${img.url}" alt="${escapeAttr(img.caption ?? item.name)}" loading="lazy" width="120" height="120">`
                      )}
                    </div>`
                  : ''}
              </div>

              <div class="pdp-info">
                <span class="eyebrow">Hand-painted</span>
                <h1>${item.name}</h1>
                <div class="pdp-price">${priceLabel}</div>
                ${item.descriptionPlaintext || item.description
                  ? html`<p class="pdp-desc">${item.descriptionPlaintext ?? item.description}</p>`
                  : ''}

                <div class="pdp-spec-line">
                  <span class="pdp-spec-label">Shape:</span>
                  <span class="pdp-spec-value">[Almond]</span>
                </div>
                <p class="pdp-spec-help">
                  Want this design in a different shape?
                  <a class="pdp-spec-link" href="/custom-order">Design it custom.</a>
                </p>
                <p class="pdp-spec-included">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="#5C8B6E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M3 8.5l3 3 7-7"></path>
                  </svg>
                  <span>All sizes XS through XL included.</span>
                </p>

                <form class="pdp-addrow" method="post" action="/cart/add" data-cart-form>
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
                  <div class="pdp-qty">
                    <label class="form-field form-field-qty">
                      <span class="form-label">Qty</span>
                      <input type="number" name="quantity" value="1" min="1" max="50" required inputmode="numeric">
                    </label>
                    <button type="submit" class="btn btn-primary btn-lg pdp-add-btn">Add to bag</button>
                  </div>
                </form>

                <div class="acc">
                  <details class="acc-row" open>
                    <summary class="acc-head"><h4>How to apply</h4><span class="acc-plus" aria-hidden="true">+</span></summary>
                    <div class="acc-body"><ol class="acc-list">
                      <li>Start with clean, dry nails.</li>
                      <li>Gently push back cuticles using a cuticle stick.</li>
                      <li>Lightly buff the surface of your natural nail to remove shine.</li>
                      <li>Select the correct nail size for each finger. If between sizes, go with the smaller one.</li>
                      <li>Apply nail glue or an adhesive tab to your natural nail.</li>
                      <li>Press the nail on firmly and hold for at least 30 seconds.</li>
                      <li>Repeat for all 10 fingers. Avoid water for at least one hour after application.</li>
                    </ol></div>
                  </details>
                  <details class="acc-row">
                    <summary class="acc-head"><h4>How to remove</h4><span class="acc-plus" aria-hidden="true">+</span></summary>
                    <div class="acc-body"><ol class="acc-list">
                      <li>Soak nails in warm soapy water (or acetone-free remover) for 10–15 minutes.</li>
                      <li>Use a cuticle stick to gently lift the edges of the press-on. Start from the sides.</li>
                      <li>Never force or pull a nail off. If it resists, soak for a few more minutes.</li>
                      <li>Buff away any remaining adhesive, then apply cuticle oil to rehydrate.</li>
                    </ol></div>
                  </details>
                  <details class="acc-row">
                    <summary class="acc-head"><h4>Nail care tips</h4><span class="acc-plus" aria-hidden="true">+</span></summary>
                    <div class="acc-body"><ul class="acc-list acc-list-bullets">
                      <li>Apply cuticle oil daily.</li>
                      <li>Avoid prolonged contact with water when possible.</li>
                      <li>Wear gloves when cleaning or using harsh chemicals.</li>
                      <li>With proper care, press-ons can last 2+ weeks depending on activity level.</li>
                    </ul></div>
                  </details>
                  <details class="acc-row">
                    <summary class="acc-head"><h4>Shipping</h4><span class="acc-plus" aria-hidden="true">+</span></summary>
                    <div class="acc-body"><div class="acc-blocks">
                      <div>
                        <strong class="acc-strong">Standard Shipping: $5.99</strong>
                        <p>Ready-made sets ship within 1–2 business days after your order is confirmed. Custom orders ship within 3–5 business days.</p>
                      </div>
                      <div>
                        <strong class="acc-strong">Rush Shipping: $14.99</strong>
                        <p>Ships next business day with priority delivery. Available for ready-made sets only.</p>
                      </div>
                      <p>All orders receive tracking information via email once shipped.</p>
                    </div></div>
                  </details>
                  <details class="acc-row">
                    <summary class="acc-head"><h4>Returns</h4><span class="acc-plus" aria-hidden="true">+</span></summary>
                    <div class="acc-body"><p>Unopened, unused sets may be returned within 14 days of delivery. Return shipping is at the customer's expense. Custom orders are final sale. If you have any issues with your order, please contact us right away.</p></div>
                  </details>
                </div>

                ${reviewSum.count > 0
                  ? html`<div class="review-summary">
                      <strong>${reviewSum.avg ? reviewSum.avg.toFixed(1) : '—'}</strong>
                      <span class="review-stars">${stars(reviewSum.avg ?? 0)}</span>
                      <span class="review-count">${reviewSum.count} review${reviewSum.count === 1 ? '' : 's'}</span>
                    </div>`
                  : ''}
              </div>
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
