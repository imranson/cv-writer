import { lookup } from 'node:dns/promises';
import net from 'node:net';

/** True for loopback, private, link-local, CGNAT, multicast and other non-public ranges. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]);
    return (
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb') ||
      lower.startsWith('ff')
    );
  }
  return true;
}

export type Resolver = (hostname: string) => Promise<string[]>;

const defaultResolver: Resolver = async (hostname) => (await lookup(hostname, { all: true })).map((r) => r.address);

/** Throws unless the URL is http(s) and every resolved address is public. */
export async function assertPublicUrl(raw: string, resolve: Resolver = defaultResolver): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https URLs can be fetched');
  if (url.username || url.password) throw new Error('URLs with credentials are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new Error('Refusing to fetch a private address');
  }
  const addresses = net.isIP(host) ? [host] : await resolve(host);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new Error('Refusing to fetch a private address');
  return url;
}
