import { html } from 'hono/html';
import type { Context } from 'hono';
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
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&family=Jost:wght@300;400;500;600&display=swap">
  <link rel="stylesheet" href="/global.css">
  <link rel="icon" type="image/png" href="/favicon.png">
</head>
<body>
  <header class="site-header">
    <div class="container">
      <a class="brand" href="/">
        <span class="brand-line">From Our Hand</span>
        <span class="brand-line brand-line-2">To Yours</span>
      </a>
      <nav class="site-nav" aria-label="Primary">
        <a href="/catalog">Shop</a>
        <a href="/subscriptions">Subscriptions</a>
        <a href="/gift-cards">Gift Cards</a>
        <a href="/custom-order">Custom Order</a>
        ${c.get('user_id')
          ? html`<a href="/account" class="nav-account" aria-label="Account">Account</a>`
          : html`<a href="/login" class="nav-account">Sign in</a>`}
        <a href="/cart" class="nav-cart" aria-label="Cart">Cart <span class="cart-count" data-cart-count>0</span></a>
      </nav>
    </div>
  </header>
  <main class="site-main">
    ${children}
  </main>
  <footer class="site-footer">
    <div class="container">
      <div class="footer-cols">
        <div>
          <h4>Shop</h4>
          <ul>
            <li><a href="/catalog">All products</a></li>
            <li><a href="/subscriptions">Subscriptions</a></li>
            <li><a href="/gift-cards">Gift Cards</a></li>
            <li><a href="/custom-order">Custom Order</a></li>
          </ul>
        </div>
        <div>
          <h4>Account</h4>
          <ul>
            <li><a href="/account">My Account</a></li>
            <li><a href="/account/orders">Orders</a></li>
            <li><a href="/account/subscriptions">Subscriptions</a></li>
          </ul>
        </div>
        <div>
          <h4>About</h4>
          <ul>
            <li><a href="/about">Our Story</a></li>
            <li><a href="/contact">Contact</a></li>
          </ul>
        </div>
      </div>
      <div class="footer-bottom">
        <small>&copy; ${new Date().getFullYear()} ${env.EMAIL_FROM_NAME}. All rights reserved.</small>
      </div>
    </div>
  </footer>
  <script src="/js/site.js" defer></script>
</body>
</html>`;
}
