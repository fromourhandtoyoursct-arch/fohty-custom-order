import { Hono } from 'hono';
import { getCatalog } from '../lib/catalog';
import type { Env, HonoVars } from '../types';

const sitemap = new Hono<{ Bindings: Env; Variables: HonoVars }>();

sitemap.get('/sitemap.xml', async (c) => {
  const snap = await getCatalog(c.env, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });
  const origin = c.env.SITE_ORIGIN.replace(/\/$/, '');
  const urls: string[] = [
    `${origin}/`,
    `${origin}/catalog`,
    `${origin}/subscriptions`,
    `${origin}/gift-cards`,
    `${origin}/custom-order`,
    ...snap.categories.filter((cat) => cat.onlineVisible).map((cat) => `${origin}/catalog/${cat.id}`),
    ...snap.items.map((it) => `${origin}/product/${it.id}`),
  ];
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${escapeXml(u)}</loc></url>`).join('\n') +
    `\n</urlset>\n`;
  return c.body(xml, 200, {
    'content-type': 'application/xml; charset=utf-8',
    'cache-control': 'public, max-age=600',
  });
});

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export default sitemap;
