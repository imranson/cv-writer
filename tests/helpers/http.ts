import { createApp } from '../../src/app';
import type { AgentDeps } from '../../src/agents/types';
import { PdfRenderer } from '../../src/pdf';

/** Minimal client around `app.request` that keeps a cookie jar like a browser would. */
export class TestClient {
  cookie = '';
  constructor(private app: ReturnType<typeof createApp>) {}

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.request(path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0];
      this.cookie = /=$/.test(pair) || /Max-Age=0/i.test(setCookie) ? '' : pair;
    }
    return res;
  }
  async json(method: string, path: string, body?: unknown) {
    const res = await this.request(method, path, body);
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  }
  get = (path: string) => this.json('GET', path);
  post = (path: string, body?: unknown) => this.json('POST', path, body ?? {});
  put = (path: string, body: unknown) => this.json('PUT', path, body);
  del = (path: string) => this.json('DELETE', path);

  async register(email: string, password = 'password123', name = 'Test User') {
    const res = await this.post('/api/auth/register', { email, password, name });
    if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
    return res.body.user;
  }
}

export function buildApp(deps: AgentDeps, pdf: PdfRenderer = new PdfRenderer(), publicDir?: string) {
  return createApp({ deps, secret: 'test-secret', pdf, publicDir });
}
