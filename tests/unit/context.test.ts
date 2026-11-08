import { describe, expect, it } from 'vitest';
import { clipToolResult, compactMessages, estimateTokens, systemInfoBlock } from '../../src/agents/context.js';
import type { ChatMessage } from '../../src/llm/types.js';

describe('system information & context window indicator', () => {
  it('renders datetime and context usage for an agent', () => {
    const block = systemInfoBlock({
      agent: 'writer',
      now: new Date('2026-11-08T12:00:00Z'),
      timezone: 'Europe/London',
      usedTokens: 12_345,
      contextWindow: 262_144,
      estimated: true,
    });
    expect(block).toContain('agent: writer');
    expect(block).toMatch(/datetime: 2026-11-08T12:00:00\.000Z \(Sunday,? 8 November 2026( at)?,? 12:00, Europe\/London\)/);
    expect(block).toContain('context_window: 12,345 / 262,144 tokens used (4.7%, estimated) — ok');
  });

  it('flags high usage and falls back to UTC for bad time zones', () => {
    const block = systemInfoBlock({ agent: 'critic', now: new Date(0), timezone: 'Mars/Base', usedTokens: 90, contextWindow: 100, estimated: false });
    expect(block).toContain('UTC');
    expect(block).toContain('(90.0%) — critical');
  });

  it('estimates tokens from messages and tool schemas', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'x'.repeat(400) }];
    expect(estimateTokens(messages)).toBe(104);
    expect(estimateTokens(messages, [{ type: 'function', function: { name: 'a', description: 'b', parameters: {} } }])).toBeGreaterThan(104);
  });

  it('clips oversized tool results', () => {
    expect(clipToolResult('abc', 10)).toBe('abc');
    expect(clipToolResult('x'.repeat(20), 10)).toMatch(/^x{10}\n…\[truncated 10 characters/);
  });

  it('compacts the oldest tool results first and keeps recent messages intact', () => {
    const big = 'y'.repeat(4000);
    const messages: ChatMessage[] = [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: '', thinking: 't'.repeat(2000), tool_calls: [{ function: { name: 'readCV', arguments: {} } }] },
      { role: 'tool', content: big, tool_name: 'readCV' },
      { role: 'tool', content: big, tool_name: 'readJob' },
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'tool', content: big, tool_name: 'recent' },
    ];
    const { messages: out, trimmed } = compactMessages(messages, { targetTokens: 1500, keepRecent: 3 });
    expect(trimmed).toBe(2);
    expect(out[1].thinking).toBeUndefined();
    expect(out[2].content).toMatch(/older tool result removed/);
    expect(out[6].content).toBe(big);
    expect(messages[2].content).toBe(big);
  });
});
