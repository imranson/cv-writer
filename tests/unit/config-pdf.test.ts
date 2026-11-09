import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { countPdfPages, normalizePageSize } from '../../src/pdf/render.js';

describe('loadConfig', () => {
  it('defaults to a local Ollama daemon and embedded DB', () => {
    const c = loadConfig({});
    expect(c.ollamaHost).toBe('http://127.0.0.1:11434');
    expect(c.databaseUrl).toBe('');
    expect(c.models.coordinator).toBe('kimi-k2.6:cloud');
    expect(c.port).toBe(3000);
    expect(c.cookieSecure).toBe(false);
  });

  it('uses ollama.com when an API key is set and honours overrides', () => {
    const c = loadConfig({
      OLLAMA_API_KEY: 'k',
      NODE_ENV: 'production',
      PORT: '8080',
      DATABASE_URL: 'postgres://x',
      WRITER_MODEL: 'deepseek-v4-pro:cloud',
      OLLAMA_MODEL: 'glm-5:cloud',
      CONTEXT_WINDOW: 'abc',
    });
    expect(c.ollamaHost).toBe('https://ollama.com');
    expect(c.port).toBe(8080);
    expect(c.models).toEqual({ coordinator: 'glm-5:cloud', writer: 'deepseek-v4-pro:cloud', critic: 'glm-5:cloud' });
    expect(c.cookieSecure).toBe(true);
    expect(c.contextWindow).toBe(131072);
  });
});

describe('pdf helpers', () => {
  it('counts page objects but not the /Pages tree', () => {
    const fake = Buffer.from('<< /Type /Pages /Count 2 >> << /Type /Page >> << /Type/Page /Parent 1 0 R >>', 'latin1');
    expect(countPdfPages(fake)).toBe(2);
  });
  it('normalises page sizes', () => {
    expect(normalizePageSize('letter')).toBe('Letter');
    expect(normalizePageSize('A4')).toBe('A4');
    expect(normalizePageSize(undefined)).toBe('A4');
  });
});
