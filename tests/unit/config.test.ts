import { describe, expect, it } from 'vitest';
import { DEFAULT_MODELS, loadConfig, normaliseHost, parseThink } from '../../src/config.js';

describe('loadConfig', () => {
  it('has local-first defaults', () => {
    const c = loadConfig([], {}, '/work');
    expect(c).toEqual({ dataDir: '/work/data', port: 5174, listen: '127.0.0.1', ollamaHost: 'http://127.0.0.1:11434', models: { ...DEFAULT_MODELS } });
  });

  it('reads flags over environment', () => {
    const c = loadConfig(['--port', '8080', '--model', 'a', '--writer-model', 'b', '--critic-model', 'c', '--think', 'high', '--data', 'x'], { CV_WRITER_MODEL: 'z', PORT: '1' }, '/w');
    expect(c).toMatchObject({ port: 8080, dataDir: '/w/x', models: { coordinator: 'a', writer: 'b', critic: 'c' }, think: 'high' });
  });

  it('calls ollama.com directly when an API key is set, unless a host is given', () => {
    expect(loadConfig([], { OLLAMA_API_KEY: 'k' })).toMatchObject({ ollamaHost: 'https://ollama.com', apiKey: 'k' });
    expect(loadConfig([], { OLLAMA_API_KEY: 'k', OLLAMA_HOST: '0.0.0.0' })).toMatchObject({ ollamaHost: 'http://127.0.0.1:11434' });
  });

  it('rejects bad values and supports --help', () => {
    expect(loadConfig(['-h'])).toBe('help');
    expect(() => loadConfig(['--port', 'abc'])).toThrow(/Invalid port/);
    expect(() => loadConfig(['--think', 'very'])).toThrow(/Invalid think level/);
    expect(() => loadConfig(['--nope'])).toThrow();
    expect(parseThink('off')).toBe(false);
  });

  it('normalises Ollama host forms', () => {
    expect(normaliseHost('localhost')).toBe('http://localhost:11434');
    expect(normaliseHost('0.0.0.0:11434')).toBe('http://127.0.0.1:11434');
    expect(normaliseHost('https://ollama.com/')).toBe('https://ollama.com');
    expect(normaliseHost('http://gpu-box:9000')).toBe('http://gpu-box:9000');
  });
});
