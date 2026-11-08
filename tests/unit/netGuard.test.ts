import { describe, expect, it } from 'vitest';
import { assertPublicUrl, isPrivateAddress } from '../../src/lib/netGuard.js';

describe('SSRF guard for webFetch', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', 'nonsense'])(
    'treats %s as private',
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '172.32.0.1'])('treats %s as public', (ip) => expect(isPrivateAddress(ip)).toBe(false));

  it('validates URLs and resolved addresses', async () => {
    const resolve = async (host: string) => (host === 'internal.example' ? ['10.0.0.5'] : ['93.184.216.34']);
    await expect(assertPublicUrl('https://example.com/job', resolve)).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('https://internal.example/', resolve)).rejects.toThrow('private');
    await expect(assertPublicUrl('http://localhost:3000', resolve)).rejects.toThrow('private');
    await expect(assertPublicUrl('http://169.254.169.254/latest', resolve)).rejects.toThrow('private');
    await expect(assertPublicUrl('file:///etc/passwd', resolve)).rejects.toThrow('Only http');
    await expect(assertPublicUrl('https://user:pw@example.com', resolve)).rejects.toThrow('credentials');
    await expect(assertPublicUrl('not a url', resolve)).rejects.toThrow('Invalid URL');
  });
});
