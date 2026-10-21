import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '../../src/agents/types';
import { renderMarkdown } from '../../web/src/markdown';
import { createSSEParser } from '../../web/src/sse';
import { applyEvent, createTimeline, formatTokens, settle, summarizeArgs } from '../../web/src/timeline';

describe('SSE parser', () => {
  it('handles frames split across chunks, multi-line data and comments', () => {
    const got: any[] = [];
    const p = createSSEParser((m) => got.push(m));
    p.push('event: delta\nda');
    p.push('ta: {"a":1}\n\n: keep-alive\n\nevent: done\r\ndata: line1\r\ndata: line2\r\n\r\n');
    p.push('data: tail');
    p.end();
    expect(got).toEqual([
      { event: 'delta', data: '{"a":1}' },
      { event: 'done', data: 'line1\nline2' },
      { event: 'message', data: 'tail' },
    ]);
  });
});

describe('renderMarkdown', () => {
  it('renders the supported subset', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** and *em* and `code`.\n\n- one\n- two\n\n1. first\n2. second\n\n```\n<b>raw</b>\n```\n[link](https://x.dev)');
    expect(html).toContain('<h3>Title</h3>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>em</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>');
    expect(html).toContain('<pre><code>&lt;b&gt;raw&lt;/b&gt;</code></pre>');
    expect(html).toContain('<a href="https://x.dev" target="_blank" rel="noopener noreferrer">link</a>');
  });

  it('escapes HTML and refuses javascript: links', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> [x](javascript:alert(1))');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href="javascript');
  });
});

describe('timeline', () => {
  const at = '2026-10-21T12:00:00Z';
  const events: StreamEvent[] = [
    { type: 'user_message', at, content: 'Write my CV' },
    { type: 'agent_start', at, runId: 'c1', agent: 'coordinator' },
    { type: 'delta', at, runId: 'c1', agent: 'coordinator', content: 'On ' },
    { type: 'delta', at, runId: 'c1', agent: 'coordinator', content: 'it' },
    { type: 'tool_call', at, runId: 'c1', agent: 'coordinator', callId: 'k1', name: 'callWriter', args: { jobId: 'j1' } },
    { type: 'agent_start', at, runId: 'w1', parentRunId: 'c1', agent: 'writer', task: 'brief' },
    { type: 'tool_call', at, runId: 'w1', agent: 'writer', callId: 'k2', name: 'editCV', args: { jobId: 'j1' } },
    { type: 'tool_result', at, runId: 'w1', agent: 'writer', callId: 'k2', name: 'editCV', ok: true, result: '{}', durationMs: 4 },
    { type: 'usage', at, runId: 'w1', agent: 'writer', usage: { used: 10, window: 100, promptTokens: 8, outputTokens: 2, estimated: false, updatedAt: at } },
    { type: 'agent_end', at, runId: 'w1', agent: 'writer', result: 'done' },
    { type: 'tool_result', at, runId: 'c1', agent: 'coordinator', callId: 'k1', name: 'callWriter', ok: true, result: '{}', durationMs: 9 },
    { type: 'assistant_message', at, runId: 'c1', agent: 'coordinator', content: 'All done.' },
  ];

  it('nests subagent runs under the tool call that started them', () => {
    const t = createTimeline();
    events.forEach((e) => applyEvent(t, e));
    expect(t.nodes.map((n) => n.kind)).toEqual(['user', 'run']);
    const run = t.nodes[1] as any;
    expect(run.children.map((c: any) => c.kind)).toEqual(['text', 'tool', 'text']);
    expect(run.children[0]).toMatchObject({ content: 'On it', streaming: false });
    const tool = run.children[1];
    expect(tool).toMatchObject({ name: 'callWriter', status: 'ok', durationMs: 9 });
    expect(tool.subrun).toMatchObject({ agent: 'writer', status: 'done', task: 'brief', usage: { used: 10 } });
    expect(tool.subrun.children[0]).toMatchObject({ name: 'editCV', status: 'ok' });
    expect(run.children[2]).toMatchObject({ content: 'All done.', streaming: false });
  });

  it('settles unfinished work when a stream ends early', () => {
    const t = createTimeline();
    events.slice(0, 7).forEach((e) => applyEvent(t, e));
    settle(t);
    expect([...t.runs.values()].every((r) => r.status !== 'running')).toBe(true);
    expect([...t.tools.values()].every((x) => x.status !== 'running')).toBe(true);
  });

  it('formats helpers', () => {
    expect(summarizeArgs({ jobId: 'abc', html: 'x'.repeat(100) })).toMatch(/^jobId: "abc", html: ".{30,}…/);
    expect(summarizeArgs(null)).toBe('');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_345)).toBe('12k');
    expect(formatTokens(262_144)).toBe('262k');
    expect(formatTokens(1_500)).toBe('1.5k');
  });
});
