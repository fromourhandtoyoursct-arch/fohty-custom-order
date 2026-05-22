/**
 * Security headers middleware for HTML responses.
 * Strict CSP that allows our own assets + Google Fonts + Square CDN images.
 */
import type { Context, Next } from 'hono';
import type { Env } from '../types';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https://*.squarecdn.com https://items-images-production.s3.us-west-2.amazonaws.com https://*.squareup.com",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self' https://square.link https://*.squareup.com",
  "upgrade-insecure-requests",
].join('; ');

export async function securityHeaders(c: Context<{ Bindings: Env }>, next: Next): Promise<void> {
  await next();
  const isHtml = c.res.headers.get('content-type')?.includes('text/html');
  if (isHtml) {
    c.res.headers.set('Content-Security-Policy', CSP);
  }
  c.res.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('X-Frame-Options', 'DENY');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
}
