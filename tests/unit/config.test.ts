import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  it('defaults to a local daemon, PGlite and the kimi cloud model', () => {
    const c = loadConfig({}, '/app');
    expect(c.ollama).toEqual({ host: 'http://localhost:11434', apiKey: undefined });
    expect(c.databaseUrl).toBeUndefined();
    expect(c.pgliteDir).toBe(path.resolve('/app/data/pglite'));
    expect(c.agents.coordinator.model).toBe('kimi-k2.6:cloud');
    expect(c.agents.writer.maxSteps).toBeGreaterThan(c.agents.critic.maxSteps);
    expect(c.skillsDir).toBe(path.resolve('/app/skills'));
  });

  it('switches to ollama.com when an API key is present and reads per-agent settings', () => {
    const c = loadConfig({
      OLLAMA_API_KEY: 'secret',
      DATABASE_URL: 'postgres://u:p@db/cv',
      WRITER_MODEL: 'gpt-oss:120b',
      CRITIC_CONTEXT_WINDOW: '65536',
      PORT: '8080',
      NODE_ENV: 'production',
      ALLOW_REGISTRATION: 'false',
    });
    expect(c.ollama.host).toBe('https://ollama.com');
    expect(c.pgliteDir).toBeUndefined();
    expect(c.agents.writer.model).toBe('gpt-oss:120b');
    expect(c.agents.critic.contextWindow).toBe(65536);
    expect(c.port).toBe(8080);
    expect(c.production).toBe(true);
    expect(c.allowRegistration).toBe(false);
  });

  it('rejects invalid numbers', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow('PORT must be a positive integer');
  });
});
