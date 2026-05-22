import { Hono } from 'hono';
import { html } from 'hono/html';
import { Layout } from '../views/layout';
import { ProductCard } from '../views/components/product-card';
import { getCatalog } from '../lib/catalog';
import type { Env, HonoVars } from '../types';

const home = new Hono<{ Bindings: Env; Variables: HonoVars }>();

home.get('/', async (c) => {
  const snap = await getCatalog(c.env, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });
  // Featured = first 8 sellable items; alphabetical for stability.
  const featured = snap.items.slice(0, 8);

  return c.html(
    Layout({
      c,
      title: c.env.EMAIL_FROM_NAME,
      description: 'Hand-crafted press-on nail sets. Made in small batches by us.',
      children: html`
        <section class="hero">
          <div class="container hero-inner">
            <div class="hero-copy">
              <h1>Hand-crafted, made just for you.</h1>
              <p class="hero-sub">Beautiful press-on nail sets in small batches. From our hand to yours.</p>
              <div class="hero-ctas">
                <a class="btn btn-primary" href="/catalog">Shop the collection</a>
                <a class="btn btn-secondary" href="/custom-order">Order custom</a>
              </div>
            </div>
          </div>
        </section>
        <section class="section">
          <div class="container">
            <header class="section-header">
              <h2>Featured</h2>
              <a class="section-link" href="/catalog">View all →</a>
            </header>
            ${featured.length === 0
              ? html`<p class="empty-state">Our shop is being prepared. Please check back soon.</p>`
              : html`<div class="product-grid">
                  ${featured.map((it) => ProductCard({ item: it, snap }))}
                </div>`}
          </div>
        </section>
        <section class="section section-band">
          <div class="container two-col">
            <div>
              <h2>Subscribe & save</h2>
              <p>Join the Press-On Club for a fresh set delivered monthly.</p>
              <a class="btn btn-primary" href="/subscriptions">See plans</a>
            </div>
            <div>
              <h2>Gift it</h2>
              <p>Give the gift of beautifully manicured hands.</p>
              <a class="btn btn-secondary" href="/gift-cards">Gift cards</a>
            </div>
          </div>
        </section>`,
    })
  );
});

export default home;
