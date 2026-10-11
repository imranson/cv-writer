import { describe, expect, it } from 'vitest';
import { sanitizeCss, sanitizeCvHtml, stripCodeFence } from '../../src/cv/sanitize.ts';

describe('sanitizeCvHtml', () => {
  it('removes scripts, styles, iframes and event handlers', () => {
    const out = sanitizeCvHtml('<h1 onclick="x()">Jo</h1><script>alert(1)</script><style>h1{}</style><iframe src="x"></iframe><img src=x onerror=alert(1)>');
    expect(out).not.toMatch(/script|style>|iframe|onclick|onerror/i);
    expect(out).toContain('<h1>Jo</h1>');
  });

  it('strips inline style attributes so the stylesheet stays in control', () => {
    expect(sanitizeCvHtml('<p style="color:red" class="x">Hi</p>')).toBe('<p class="x">Hi</p>');
  });

  it('neutralises script and data URLs', () => {
    expect(sanitizeCvHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a href="#">x</a>');
    expect(sanitizeCvHtml("<a href='data:text/html,hi'>x</a>")).toBe('<a href="#">x</a>');
    expect(sanitizeCvHtml('<a href="https://example.com">x</a>')).toBe('<a href="https://example.com">x</a>');
  });

  it('extracts the body of full documents and unwraps code fences and <main>', () => {
    const doc = '```html\n<!doctype html><html><head><title>T</title></head><body><main class="cv"><h1>Jo</h1></main></body></html>\n```';
    expect(sanitizeCvHtml(doc)).toBe('<h1>Jo</h1>');
    expect(stripCodeFence('```\nabc\n```')).toBe('abc');
    expect(stripCodeFence('plain')).toBe('plain');
  });
});

describe('sanitizeCss', () => {
  it('prevents breaking out of the <style> element', () => {
    expect(sanitizeCss('h1{} </style><script>x</script>')).not.toContain('</style>');
    expect(sanitizeCss('<!-- h1 {} -->')).toBe(' h1 {} ');
  });
});
