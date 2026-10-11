import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  it('has sensible defaults (local daemon, kimi cloud model)', () => {
    const c = loadConfig({}, '/app');
    expect(c).toMatchObject({
      port: 3000,
      dataDir: path.resolve('/app/data'),
      skillsDir: path.resolve('/app/skills'),
      ollamaHost: 'http://127.0.0.1:11434',
      models: { coordinator: 'kimi-k2.6:cloud', writer: 'kimi-k2.6:cloud', critic: 'kimi-k2.6:cloud' },
      maxAgentSteps: 30,
    });
    expect(c.ollamaApiKey).toBeUndefined();
    expect(c.contextWindow).toBeUndefined();
  });

  it('reads overrides, including per-agent models', () => {
    const c = loadConfig(
      { PORT: '8080', OLLAMA_MODEL: 'gpt-oss:120b', CRITIC_MODEL: 'qwen3:32b', OLLAMA_API_KEY: ' key ', CONTEXT_WINDOW: '4096', DATA_DIR: '/tmp/d' },
      '/app',
    );
    expect(c).toMatchObject({ port: 8080, ollamaApiKey: 'key', contextWindow: 4096, dataDir: '/tmp/d' });
    expect(c.models).toEqual({ coordinator: 'gpt-oss:120b', writer: 'gpt-oss:120b', critic: 'qwen3:32b' });
  });

  it('rejects bad numbers', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow('PORT must be a positive integer');
  });

  it('parses the thinking setting', () => {
    expect(loadConfig({}).think).toBeUndefined();
    expect(loadConfig({ OLLAMA_THINK: 'false' }).think).toBe(false);
    expect(loadConfig({ OLLAMA_THINK: 'TRUE' }).think).toBe(true);
    expect(loadConfig({ OLLAMA_THINK: 'low' }).think).toBe('low');
    expect(() => loadConfig({ OLLAMA_THINK: 'maybe' })).toThrow('OLLAMA_THINK must be');
  });
});
