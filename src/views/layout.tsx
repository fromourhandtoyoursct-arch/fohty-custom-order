import { html } from 'hono/html';
import type { Context } from 'hono';
import { csrfToken } from '../lib/csrf';
import type { Env, HonoVars } from '../types';

interface LayoutProps {
  c: Context<{ Bindings: Env; Variables: HonoVars }>;
  title: string;
  description?: string;
  canonical?: string;
  children: any;
}

export function Layout({ c, title, description, canonical, children }: LayoutProps) {
  const env = c.env;
  const pageTitle = title === env.EMAIL_FROM_NAME ? title : `${title} · ${env.EMAIL_FROM_NAME}`;
  const desc = description ?? 'Hand-crafted press-on nail sets. From Our Hand To Yours.';
  const canon = canonical ?? `${env.SITE_ORIGIN}${c.req.path}`;
  const signedIn = !!c.get('user_id');
  const token = csrfToken(c);

  return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${pageTitle}</title>
  <meta name="description" content="${desc}">
  <link rel="canonical" href="${canon}">
  <meta property="og:title" content="${pageTitle}">
  <meta property="og:description" content="${desc}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${canon}">
  <meta name="theme-color" content="#5C8B6E">
  <meta name="csrf-token" content="${token}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,600;1,400&family=Jost:wght@300;400;500;600&family=JetBrains+Mono:wght@400&display=swap">
  <link rel="stylesheet" href="/global.css">
  <link rel="icon" type="image/png" sizes="64x64" href="/assets/logo-64.png">
  <link rel="apple-touch-icon" href="/assets/logo-256.png">
</head>
<body>
  <header class="header">
    <div class="header-inner">
      <a class="brand" href="/" aria-label="From Our Hand To Yours">
        <img class="brand-logo" src="/assets/logo-256.png" alt="" width="44" height="44">
        <span class="brand-text">From Our Hand To Yours</span>
      </a>
      <nav class="header-nav" aria-label="Primary">
        <a href="/about">Our Story</a>
        <a href="/catalog">Shop</a>
        <a href="/subscriptions">Made For You, Monthly</a>
        <a href="/custom-order">Custom Order</a>
      </nav>
      <div class="header-utils">
        <button type="button" class="header-search-btn" data-search-open aria-label="Search" title="Search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5"></circle><path d="m20 20-4.2-4.2"></path>
          </svg>
        </button>
        <a href="${signedIn ? '/account' : '/login'}" aria-label="Account" title="Account">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <circle cx="12" cy="9" r="3.5"></circle><path d="M5 20c1.5-3.5 4-5 7-5s5.5 1.5 7 5"></path>
          </svg>
        </a>
        <a class="cart-pill" href="/cart" data-cart-open aria-label="Cart">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <path d="M5 8h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8L5 8Z"></path>
            <path d="M9 8V6a3 3 0 0 1 6 0v2"></path>
          </svg>
          Bag · <span data-cart-count>0</span>
        </a>
      </div>
    </div>
  </header>

  <div class="search-overlay" data-search-overlay hidden role="dialog" aria-label="Search">
    <div class="search-panel">
      <form class="search-input-row" data-search-form action="/catalog" method="get">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5"></circle><path d="m20 20-4.2-4.2"></path>
        </svg>
        <input class="search-input" data-search-input name="q" type="text" placeholder="Search sets, shapes, palettes…" autocomplete="off">
        <button type="button" class="search-close" data-search-close aria-label="Close search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18"></path>
          </svg>
        </button>
      </form>
      <div class="search-body" data-search-body>
        <div class="search-empty" data-search-empty>
          <div class="search-empty-label">Try</div>
          <div class="search-suggest-row">
            <a class="search-suggest" href="/catalog?q=Almond">Almond</a>
            <a class="search-suggest" href="/catalog?q=Coffin">Coffin</a>
            <a class="search-suggest" href="/catalog?q=Bridal">Bridal</a>
            <a class="search-suggest" href="/catalog?q=Holiday">Holiday</a>
            <a class="search-suggest" href="/catalog?q=Everyday">Everyday</a>
          </div>
        </div>
      </div>
    </div>
  </div>

  <main>${children}</main>

  <div class="scrim" data-drawer-scrim hidden></div>
  <aside class="drawer" data-drawer hidden aria-hidden="true" aria-label="Your bag">
    <div class="drawer-head">
      <h3>Your bag</h3>
      <button type="button" data-drawer-close aria-label="Close">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="m6 6 12 12M18 6 6 18"></path>
        </svg>
      </button>
    </div>
    <div class="drawer-body" data-drawer-body>
      <p class="drawer-empty" data-drawer-empty>Your bag is empty.</p>
    </div>
    <div class="drawer-foot" data-drawer-foot hidden>
      <div class="drawer-row"><span>Subtotal</span><span data-drawer-subtotal>—</span></div>
      <p class="drawer-hint" data-drawer-ship-hint hidden></p>
      <p class="drawer-warning" data-drawer-warning hidden>Please remove unavailable items before checking out.</p>
      <div class="drawer-actions">
        <a class="btn btn-secondary btn-sm btn-block" href="/cart">View bag</a>
        <a class="btn btn-primary btn-sm btn-block drawer-checkout-form" href="/checkout?mode=guest" data-drawer-checkout>Checkout</a>
      </div>
    </div>
  </aside>

  <div class="toast" data-toast hidden role="status" aria-live="polite"></div>

  <span data-signed-in="${signedIn ? '1' : '0'}" hidden></span>

  <footer class="footer">
    <div class="footer-inner">
      <div class="footer-brand-row">
        <img class="footer-logo" src="/assets/logo-256.png" alt="" width="48" height="48">
        <div class="footer-brand">From Our Hand To Yours</div>
      </div>
      <p class="footer-tag">Mix. Match. Make it <em>uniquely yours.</em></p>
      <p class="footer-credential">Handcrafted by a Licensed Nail Technician</p>
      <div class="footer-social">
        <a class="footer-icon" href="https://www.instagram.com/fromourhandtoyours" target="_blank" rel="noopener" aria-label="Instagram">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="5"></rect>
            <circle cx="12" cy="12" r="4"></circle>
            <circle cx="17.5" cy="6.5" r="0.6" fill="currentColor" stroke="none"></circle>
          </svg>
        </a>
        <a class="footer-icon" href="http://facebook.com/Fromourhandtoyours" target="_blank" rel="noopener" aria-label="Facebook">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path d="M13.5 21v-7.5h2.5l.4-3h-2.9V8.6c0-.87.24-1.46 1.5-1.46h1.6V4.5c-.78-.08-1.56-.12-2.34-.12-2.32 0-3.92 1.42-3.92 4.02V10.5H8v3h2.34V21h3.16Z"></path>
          </svg>
        </a>
      </div>
      <nav class="footer-links" aria-label="Footer">
        <a href="/subscriptions#how-to-apply">How to Apply</a>
        <span class="footer-sep" aria-hidden="true">•</span>
        <a href="/subscriptions#shipping">Shipping</a>
        <span class="footer-sep" aria-hidden="true">•</span>
        <a href="/subscriptions#returns">Returns</a>
        <span class="footer-sep" aria-hidden="true">•</span>
        <a href="/subscriptions#contact">Contact</a>
      </nav>
      <div class="footer-bottom">
        <small>&copy; ${new Date().getFullYear()} ${env.EMAIL_FROM_NAME} LLC</small>
      </div>
    </div>
  </footer>

  <script src="/js/site.js" defer></script>
</body>
</html>`;
}
