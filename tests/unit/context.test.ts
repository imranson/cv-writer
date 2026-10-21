import type { Message } from 'ollama';
import { describe, expect, it } from 'vitest';
import { COMPACTED_TOOL_RESULT, compactMessages, estimateTokens, formatUsage } from '../../src/agents/context';

const big = 'x'.repeat(4000); // ~1000 tokens

function conversation(): Message[] {
  return [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'readProfile', arguments: {} } }] },
    { role: 'tool', content: big, tool_name: 'readProfile' },
    { role: 'assistant', content: 'answer one' },
    { role: 'user', content: 'second question' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'readCV', arguments: {} } }] },
    { role: 'tool', content: big, tool_name: 'readCV' },
    { role: 'assistant', content: 'answer two' },
    { role: 'user', content: 'third question' },
    { role: 'assistant', content: 'answer three' },
  ];
}

describe('estimateTokens', () => {
  it('counts roughly four characters per token, including system prompt and tools', () => {
    expect(estimateTokens([{ role: 'user', content: 'x'.repeat(390) }])).toBe(100);
    expect(estimateTokens([], 'x'.repeat(400))).toBe(101);
    expect(estimateTokens(conversation())).toBeGreaterThan(2000);
  });
});

describe('compactMessages', () => {
  it('returns history unchanged when it fits', () => {
    const msgs = conversation();
    expect(compactMessages(msgs, 100_000)).toEqual(msgs);
  });

  it('blanks old tool results first, keeping recent messages intact', () => {
    const out = compactMessages(conversation(), 1200, 0, 4);
    expect(out).toHaveLength(10);
    expect(out[2].content).toBe(COMPACTED_TOOL_RESULT);
    expect(out[6].content).toBe(big); // within the last 4 messages
  });

  it('drops oldest turns when blanking is not enough, starting at a user message', () => {
    const out = compactMessages(conversation(), 300, 0, 4);
    expect(out[0].role).toBe('user');
    expect(out.length).toBeLessThan(10);
    expect(out.at(-1)!.content).toBe('answer three');
  });
});

describe('formatUsage', () => {
  it('formats used/window with a percentage', () => {
    expect(formatUsage(12345, 262144)).toBe('12,345 of 262,144 tokens used (4.7%)');
    expect(formatUsage(0, 0)).toBe('0 of 0 tokens used (0.0%)');
  });
});
