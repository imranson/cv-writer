import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  it('defaults to ./data and the default model for both agents', () => {
    expect(loadConfig([], {}, '/work')).toEqual({ dataDir: '/work/data', model: DEFAULT_MODEL, writerModel: DEFAULT_MODEL });
  });

  it('reads flags, falling back to environment variables', () => {
    expect(
      loadConfig(['--data', 'store', '--writer-model', 'claude-sonnet-5-5', '--resume', 'abc', '--budget', '2.5'], { CV_WRITER_MODEL: 'm' }, '/w'),
    ).toEqual({ dataDir: '/w/store', model: 'm', writerModel: 'claude-sonnet-5-5', resume: 'abc', maxBudgetUsd: 2.5 });
    expect(loadConfig([], { CV_WRITER_DATA_DIR: '/abs', CV_WRITER_WRITER_MODEL: 'w', CV_WRITER_BUDGET_USD: '1' }, '/w')).toMatchObject({
      dataDir: '/abs',
      writerModel: 'w',
      maxBudgetUsd: 1,
    });
  });

  it('flags take precedence over the environment', () => {
    expect(loadConfig(['--model', 'flag'], { CV_WRITER_MODEL: 'env' }, '/w')).toMatchObject({ model: 'flag', writerModel: 'flag' });
  });

  it('handles --help and rejects bad input', () => {
    expect(loadConfig(['-h'], {}, '/w')).toBe('help');
    expect(() => loadConfig(['--budget', '0'], {}, '/w')).toThrow(/Invalid budget/);
    expect(() => loadConfig(['--budget', 'abc'], {}, '/w')).toThrow(/Invalid budget/);
    expect(() => loadConfig(['--nope'], {}, '/w')).toThrow();
  });
});
