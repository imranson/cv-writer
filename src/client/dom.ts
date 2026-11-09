type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, any>;

/** Tiny hyperscript helper: h('div.cls#id', { onclick }, children...). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K | string, attrs?: Attrs | Child, ...children: Child[]): HTMLElement {
  const [name, ...rest] = tag.split(/(?=[.#])/);
  const el = document.createElement(name || 'div');
  for (const part of rest) {
    if (part.startsWith('.')) el.classList.add(part.slice(1));
    else if (part.startsWith('#')) el.id = part.slice(1);
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs as Child);
  } else if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'value') (el as HTMLInputElement).value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: HTMLElement, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

export function clear(el: HTMLElement, ...children: Child[]) {
  el.replaceChildren();
  append(el, children);
}

export const fmtNum = (n: number | undefined) =>
  n === undefined ? '–' : n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : n.toLocaleString();

export function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function toast(message: string, kind: 'info' | 'error' = 'info') {
  const host = document.getElementById('toasts')!;
  const el = h('div.toast', { class: kind }, message);
  host.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3000);
}
