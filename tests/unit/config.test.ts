import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, DEFAULT_WRITER_MODEL, loadConfig, parseThink } from '../../src/config.js';

describe('loadConfig', () => {
  it('defaults to ./data, a local Ollama daemon and the default cloud models', () => {
    expect(loadConfig([], {}, '/work')).toEqual({
      dataDir: '/work/data',
      host: 'http://127.0.0.1:11434',
      model: DEFAULT_MODEL,
      writerModel: DEFAULT_WRITER_MODEL,
    });
    expect(DEFAULT_MODEL).toMatch(/[:-]cloud$/);
    expect(DEFAULT_WRITER_MODEL).toMatch(/[:-]cloud$/);
  });

  it('calls ollama.com directly when an API key is set', () => {
    expect(loadConfig([], { OLLAMA_API_KEY: ' key ' }, '/w')).toMatchObject({ host: 'https://ollama.com', apiKey: 'key' });
    expect(loadConfig([], { OLLAMA_API_KEY: 'key', OLLAMA_HOST: 'http://gpu-box:11434' }, '/w')).toMatchObject({ host: 'http://gpu-box:11434' });
    expect(loadConfig([], { OLLAMA_API_KEY: '  ' }, '/w')).not.toHaveProperty('apiKey');
  });

  it('reads flags, falling back to environment variables', () => {
    expect(
      loadConfig(['--data', 'store', '--writer-model', 'kimi-k2.6:cloud', '--resume', 'session-abc', '--think', 'HIGH', '--host', ':9999'], { CV_WRITER_MODEL: 'm' }, '/w'),
    ).toEqual({ dataDir: '/w/store', host: ':9999', model: 'm', writerModel: 'kimi-k2.6:cloud', think: 'high', resume: 'session-abc' });
    expect(
      loadConfig([], { CV_WRITER_DATA_DIR: '/abs', CV_WRITER_WRITER_MODEL: 'w', CV_WRITER_THINK: 'off', OLLAMA_HOST: 'h:1' }, '/w'),
    ).toMatchObject({ dataDir: '/abs', writerModel: 'w', think: false, host: 'h:1' });
  });

  it('flags take precedence over the environment', () => {
    expect(loadConfig(['--model', 'flag', '--think', 'on'], { CV_WRITER_MODEL: 'env', CV_WRITER_THINK: 'low' }, '/w')).toMatchObject({
      model: 'flag',
      writerModel: DEFAULT_WRITER_MODEL,
      think: true,
    });
  });

  it('--continue resumes the latest session', () => {
    expect(loadConfig(['-c'], {}, '/w')).toMatchObject({ resume: 'latest' });
    expect(() => loadConfig(['-c', '--resume', 'x'], {}, '/w')).toThrow(/either --resume/);
  });

  it('handles --help and rejects bad input', () => {
    expect(loadConfig(['-h'], {}, '/w')).toBe('help');
    expect(() => loadConfig(['--think', 'maximum'], {}, '/w')).toThrow(/Invalid --think "maximum"/);
    expect(() => loadConfig(['--nope'], {}, '/w')).toThrow();
  });
});

describe('parseThink', () => {
  it('accepts on/off and levels', () => {
    expect(['off', 'false', 'on', 'true', 'low', 'medium', 'high'].map(parseThink)).toEqual([false, false, true, true, 'low', 'medium', 'high']);
  });
});
