import { describe, expect, it } from 'vitest';
import { countPdfPages } from '../../src/pdf/renderer.js';
import { paperSizeOf, DEFAULT_PREFERENCES, DEFAULT_CSS } from '../../src/cv/defaults.js';
import { deriveTitle, visibleMessages } from '../../src/chat/service.js';
import { safeFilename } from '../../src/server/http.js';

describe('CV/PDF helpers', () => {
  it('counts PDF page objects but not the page tree', () => {
    const pdf = Buffer.from('<< /Type /Pages /Count 2 >> << /Type /Page >> << /Type/Page /Parent 1 0 R >>');
    expect(countPdfPages(pdf)).toBe(2);
  });

  it('derives paper size from preferences', () => {
    expect(paperSizeOf({ paperSize: 'letter' })).toBe('Letter');
    expect(paperSizeOf({})).toBe('A4');
    expect(DEFAULT_PREFERENCES.paperSize).toBe('A4');
    expect(DEFAULT_CSS).toContain('@page');
  });

  it('builds safe download filenames', () => {
    expect(safeFilename(['CV', 'Ann "O\'Neil"', undefined, 'Acme/Corp'])).toBe('CV - Ann ONeil - AcmeCorp');
    expect(safeFilename([])).toBe('CV');
  });
});

describe('chat helpers', () => {
  it('derives a session title from the first message', () => {
    expect(deriveTitle('  Help me with\nmy CV')).toBe('Help me with');
    expect(deriveTitle('x'.repeat(80))).toHaveLength(58);
    expect(deriveTitle('   ')).toBe('New chat');
  });

  it('shows only user turns and assistant text in the transcript', () => {
    expect(
      visibleMessages([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', tool_calls: [{ function: { name: 'x', arguments: {} } }] },
        { role: 'tool', content: '{}' },
        { role: 'assistant', content: 'hello', at: 't' },
      ]),
    ).toEqual([
      { role: 'user', content: 'hi', at: undefined },
      { role: 'assistant', content: 'hello', at: 't' },
    ]);
  });
});
