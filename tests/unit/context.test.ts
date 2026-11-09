import { describe, expect, it } from 'vitest';
import { compactMessages, contextInfo, estimateTokens, formatDateTime, systemInfoBlock } from '../../src/agents/context.js';
import type { ChatMessage } from '../../src/llm/types.js';

describe('context estimation', () => {
  it('estimates ~4 chars per token including tool calls and schemas', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'x'.repeat(400) }];
    expect(estimateTokens(msgs)).toBe(Math.ceil((400 + 16) / 4));
    const withTools = estimateTokens(msgs, [{ type: 'function', function: { name: 'a', description: 'b', parameters: {} } }]);
    expect(withTools).toBeGreaterThan(estimateTokens(msgs));
    const withCalls = estimateTokens([{ role: 'assistant', content: '', tool_calls: [{ function: { name: 'readCV', arguments: { jobId: '1' } } }] }]);
    expect(withCalls).toBeGreaterThan(4);
  });

  it('computes percentage of the window', () => {
    expect(contextInfo(2500, 10000)).toEqual({ estimatedTokens: 2500, window: 10000, percent: 25 });
    expect(contextInfo(1, 3, 7)).toEqual({ estimatedTokens: 1, window: 3, percent: 33.3, promptTokens: 7 });
    expect(contextInfo(5, 0).percent).toBe(0);
  });
});

describe('system information block', () => {
  const now = new Date('2026-11-09T14:05:00Z');

  it('includes datetime, time zone and the context indicator', () => {
    const block = systemInfoBlock({ now, timeZone: 'Europe/London', context: contextInfo(12345, 262144), lastPromptTokens: 12000, extra: ['Signed-in user: Ada'] });
    expect(block).toContain('# System information');
    expect(block).toContain('Monday, 9 November 2026 at 14:05 GMT');
    expect(block).toContain('ISO 2026-11-09T14:05:00.000Z');
    expect(block).toContain('time zone Europe/London');
    expect(block).toContain('~12,345 of 262,144 tokens used (4.7%, estimated)');
    expect(block).toContain('last model-reported prompt size: 12,000 tokens');
    expect(block).toContain('- Signed-in user: Ada');
    expect(block).not.toContain('getting full');
  });

  it('warns when the context is nearly full', () => {
    expect(systemInfoBlock({ now, context: contextInfo(80, 100) })).toContain('Context is getting full');
  });

  it('ignores invalid time zones', () => {
    expect(formatDateTime(now, 'Not/AZone')).not.toContain('Not/AZone');
  });
});

describe('compactMessages', () => {
  const big = 'y'.repeat(4000);
  const msgs: ChatMessage[] = [
    { role: 'user', content: 'hi' },
    ...Array.from({ length: 8 }, (_, i) => ({ role: 'tool' as const, content: `${i}:${big}`, tool_name: 'readCV' })),
  ];

  it('leaves small transcripts untouched', () => {
    const res = compactMessages(msgs, 1_000_000);
    expect(res.compacted).toBe(0);
    expect(res.messages).toBe(msgs);
  });

  it('truncates older tool outputs first, keeping recent ones intact', () => {
    const res = compactMessages(msgs, 6000, { threshold: 0.9, keepRecent: 2 });
    expect(res.compacted).toBeGreaterThan(0);
    expect(res.messages[1].content).toMatch(/truncated to save context/);
    expect(res.messages[8].content).toBe(`7:${big}`);
    expect(res.messages[7].content).toBe(`6:${big}`);
    expect(msgs[1].content).toBe(`0:${big}`); // input not mutated
  });
});
