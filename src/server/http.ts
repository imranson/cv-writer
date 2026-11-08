import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';

/** Parses and validates a JSON body, turning problems into 400 responses. */
export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown = undefined;
  const text = await c.req.text();
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new HTTPException(400, { message: 'Request body must be valid JSON' });
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new HTTPException(400, { message: `${where}${issue?.message ?? 'Invalid request'}` });
  }
  return parsed.data;
}

/**
 * CSRF protection for the JSON API: state-changing requests must declare a JSON
 * content type, which browsers cannot send cross-origin without a CORS preflight
 * (and this API never answers preflights).
 */
export function requireJsonForMutations(): MiddlewareHandler {
  return async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const type = c.req.header('content-type') ?? '';
      if (!type.toLowerCase().startsWith('application/json')) {
        throw new HTTPException(415, { message: 'Use Content-Type: application/json' });
      }
    }
    await next();
  };
}

export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // srcdoc CV previews inherit this policy: allow their inline <style> and Google Fonts.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const CV_DOCUMENT_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  'font-src data: https://fonts.gstatic.com',
  'img-src data: https:',
  "base-uri 'none'",
  "form-action 'none'",
  'sandbox',
].join('; ');

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    if (!c.res.headers.has('Content-Security-Policy')) c.header('Content-Security-Policy', APP_CSP);
  };
}

export function safeFilename(parts: unknown[]): string {
  const name = parts
    .filter((p) => typeof p === 'string' && p.trim())
    .join(' - ')
    .replace(/[^\p{L}\p{N} ._-]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return name || 'CV';
}
