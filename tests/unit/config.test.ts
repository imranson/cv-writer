import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseThink } from '../../src/config';

describe('config', () => {
  it('parses think settings', () => {
    expect(parseThink(undefined)).toBeUndefined();
    expect(parseThink('false')).toBe(false);
    expect(parseThink('TRUE')).toBe(true);
    expect(parseThink('high')).toBe('high');
    expect(parseThink('nonsense')).toBeUndefined();
  });

  it('applies defaults and per-agent model overrides', () => {
    const cfg = loadConfig({ OLLAMA_MODEL: 'm', WRITER_MODEL: 'w', CONTEXT_WINDOW: '4096', DATA_DIR: './tmp-data' } as any);
    expect(cfg.models).toEqual({ coordinator: 'm', writer: 'w', critic: 'm' });
    expect(cfg.contextWindowOverride).toBe(4096);
    expect(cfg.dataDir).toBe(path.resolve('./tmp-data'));
    expect(cfg.port).toBe(4817);
    expect(cfg.ollamaHost).toBe('https://ollama.com');
  });

  it('ignores invalid context windows', () => {
    expect(loadConfig({ CONTEXT_WINDOW: 'abc' } as any).contextWindowOverride).toBeUndefined();
  });
});
