import { describe, expect, it } from 'vitest';
import { ContextMeter, estimateTokens, formatSystemInfo, isoWithOffset } from '../../src/agents/context.js';
import type { ChatMessage } from '../../src/llm/types.js';

describe('system information', () => {
  const now = new Date('2026-10-11T14:30:00Z');

  it('formats ISO timestamps with the zone offset', () => {
    expect(isoWithOffset(now, 'UTC')).toBe('2026-10-11T14:30:00+00:00');
    expect(isoWithOffset(now, 'Europe/London')).toBe('2026-10-11T15:30:00+01:00');
    expect(isoWithOffset(now, 'America/New_York')).toBe('2026-10-11T10:30:00-04:00');
    expect(isoWithOffset(new Date('2026-01-11T14:30:00Z'), 'Asia/Kolkata')).toBe('2026-01-11T20:00:00+05:30');
  });

  it('shows date, time and context usage', () => {
    const text = formatSystemInfo({ now, timeZone: 'Europe/London', usedTokens: 12_345, contextWindow: 262_144 });
    expect(text).toMatch(/Current date and time: Sunday,? 11 October 2026,? at 15:30 \(Europe\/London\)/);
    expect(text).toContain('ISO 2026-10-11T15:30:00+01:00');
    expect(text).toContain('Context window: 12,345 / 262,144 tokens used (4.7%), 249,799 remaining');
    expect(text).not.toContain('running low');
  });

  it('warns when the context is nearly full', () => {
    expect(formatSystemInfo({ now, timeZone: 'UTC', usedTokens: 900, contextWindow: 1000 })).toContain('Context is running low');
  });
});

describe('ContextMeter', () => {
  it('estimates before any report, then uses reported counts plus estimates for new messages', () => {
    const meter = new ContextMeter(1000);
    const msgs: ChatMessage[] = [{ role: 'user', content: 'x'.repeat(40) }];
    expect(meter.used('s'.repeat(8), msgs)).toBe(2 + 10);
    msgs.push({ role: 'assistant', content: 'ok' });
    meter.record({ promptTokens: 50, completionTokens: 5 }, msgs.length);
    expect(meter.used('ignored', msgs)).toBe(55);
    msgs.push({ role: 'user', content: 'y'.repeat(20) });
    expect(meter.used('ignored', msgs)).toBe(55 + 5);
  });

  it('ignores missing usage', () => {
    const meter = new ContextMeter(1000);
    meter.record(undefined, 3);
    meter.record({ promptTokens: 0, completionTokens: 0 }, 3);
    expect(meter.used('', [{ role: 'user', content: 'abcd' }])).toBe(estimateTokens('abcd'));
  });
});
