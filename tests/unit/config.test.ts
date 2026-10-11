import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, isDirectCloud, loadConfig, normaliseHost, parseThink, resolveModelName } from '../../src/config.ts';

describe('config', () => {
  it('defaults to the local Ollama daemon and the default cloud model', () => {
    const c = loadConfig({});
    expect(c.ollama.host).toBe('http://127.0.0.1:11434');
    expect(c.ollama.model).toBe(DEFAULT_MODEL);
    expect(c.ollama.writerModel).toBe(DEFAULT_MODEL);
    expect(c.ollama.criticModel).toBe(DEFAULT_MODEL);
    expect(c.port).toBe(4317);
    expect(c.compactThreshold).toBe(0.8);
    expect(c.pdfAllowedHosts).toEqual(['fonts.googleapis.com', 'fonts.gstatic.com']);
  });

  it('uses ollama.com directly when an API key is set and strips the :cloud suffix', () => {
    const c = loadConfig({ OLLAMA_API_KEY: 'k', OLLAMA_MODEL: 'gpt-oss:120b-cloud', CRITIC_MODEL: 'kimi-k2.6:cloud' });
    expect(c.ollama.host).toBe('https://ollama.com');
    expect(c.ollama.apiKey).toBe('k');
    expect(c.ollama.model).toBe('gpt-oss:120b');
    expect(c.ollama.criticModel).toBe('kimi-k2.6');
  });

  it('keeps cloud suffixes when going through a local daemon', () => {
    expect(resolveModelName('kimi-k2.6:cloud', 'http://localhost:11434')).toBe('kimi-k2.6:cloud');
    expect(isDirectCloud('ollama.com')).toBe(true);
    expect(isDirectCloud('localhost:11434')).toBe(false);
  });

  it('normalises hosts without a scheme', () => {
    expect(normaliseHost('127.0.0.1:11434/')).toBe('http://127.0.0.1:11434');
    expect(normaliseHost('https://ollama.com')).toBe('https://ollama.com');
  });

  it('parses think settings and rejects bad values', () => {
    expect(parseThink(undefined)).toBeUndefined();
    expect(parseThink('true')).toBe(true);
    expect(parseThink('off')).toBe(false);
    expect(parseThink('High')).toBe('high');
    expect(() => parseThink('maybe')).toThrow(/OLLAMA_THINK/);
  });

  it('validates numeric settings', () => {
    expect(loadConfig({ PORT: '9000', CONTEXT_LENGTH: '32000', OLLAMA_TEMPERATURE: '0' }).ollama.temperature).toBe(0);
    expect(loadConfig({ CONTEXT_LENGTH: '32000' }).ollama.contextLength).toBe(32000);
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ COMPACT_THRESHOLD: '1.5' })).toThrow(/COMPACT_THRESHOLD/);
    expect(() => loadConfig({ OLLAMA_TEMPERATURE: '3' })).toThrow(/TEMPERATURE/);
  });
});
