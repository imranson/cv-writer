// Helpers for the quick style controls. They edit the raw CSS text, which stays the single source of truth.

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getCssVar(css: string, name: string): string | null {
  const m = css.match(new RegExp(`--${escapeRe(name)}\\s*:\\s*([^;}{]+)`));
  return m?.[1]?.trim() ?? null;
}

export function setCssVar(css: string, name: string, value: string): string {
  const re = new RegExp(`(--${escapeRe(name)}\\s*:\\s*)([^;}{]+)`);
  if (re.test(css)) return css.replace(re, (_m, prefix: string) => `${prefix}${value}`);
  const root = css.match(/:root\s*\{/);
  if (root?.index !== undefined) {
    const at = root.index + root[0].length;
    return `${css.slice(0, at)}\n  --${name}: ${value};${css.slice(at)}`;
  }
  return `:root { --${name}: ${value}; }\n${css}`;
}

export function getPageSize(css: string): string | null {
  const page = css.match(/@page\s*\{([^}]*)\}/i)?.[1];
  return page?.match(/size\s*:\s*([^;]+)/i)?.[1]?.trim() ?? null;
}

export function setPageSize(css: string, size: string): string {
  const pageRe = /@page\s*\{([^}]*)\}/i;
  const m = css.match(pageRe);
  if (!m) return `@page { size: ${size}; }\n${css}`;
  const inner = m[1] ?? '';
  const nextInner = /size\s*:/i.test(inner) ? inner.replace(/size\s*:\s*[^;]+/i, `size: ${size}`) : ` size: ${size};${inner}`;
  return css.replace(pageRe, `@page {${nextInner}}`);
}

/** Parses a CSS length in pt (e.g. "10pt") to a number; null otherwise. */
export function parsePt(value: string | null): number | null {
  const m = value?.match(/^([\d.]+)pt$/);
  return m ? Number(m[1]) : null;
}

/** Normalises 3-digit hex colours for <input type="color">. */
export function toHexColour(value: string | null): string | null {
  if (!value) return null;
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  const short = v.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase() : null;
}

const MM_PER_IN = 25.4;
const PX_PER_MM = 96 / MM_PER_IN;

/** Converts a CSS length such as "210mm" or "8.5in" to CSS pixels. */
export function lengthToPx(value: string): number {
  const m = value.trim().match(/^([\d.]+)(mm|cm|in|px|pt)?$/);
  if (!m) return 794;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'mm':
      return n * PX_PER_MM;
    case 'cm':
      return n * 10 * PX_PER_MM;
    case 'in':
      return n * 96;
    case 'pt':
      return (n * 96) / 72;
    default:
      return n;
  }
}
