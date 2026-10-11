import { describe, expect, it } from 'vitest';
import { assertPublicUrl, isPrivateAddress } from '../../src/lib/netGuard.js';

describe('netGuard', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1'])(
    '%s is private',
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );
  it.each(['8.8.8.8', '172.32.0.1', '2606:4700::1111'])('%s is public', (ip) => expect(isPrivateAddress(ip)).toBe(false));

  it('blocks local and private targets', async () => {
    const lookup = async (host: string) => (host === 'internal.example' ? ['10.0.0.5'] : ['93.184.216.34']);
    await expect(assertPublicUrl('http://localhost:11434/api/tags', lookup)).rejects.toThrow('local address');
    await expect(assertPublicUrl('http://169.254.169.254/latest', lookup)).rejects.toThrow('private network');
    await expect(assertPublicUrl('https://internal.example/', lookup)).rejects.toThrow('private network');
    await expect(assertPublicUrl('file:///etc/passwd', lookup)).rejects.toThrow('Only http(s)');
    await expect(assertPublicUrl('not a url', lookup)).rejects.toThrow('Invalid URL');
    await expect(assertPublicUrl('https://example.com/job', lookup)).resolves.toBeInstanceOf(URL);
  });
});
