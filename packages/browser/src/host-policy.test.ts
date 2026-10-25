import { expect, it } from 'vitest';
import { isPublicNetworkAddress } from './host-policy.js';

it('denies private, expanded IPv6, transition, multicast and documentation targets', () => {
  for (const address of ['0:0:0:0:0:0:0:1', '0:0:0:0:0:ffff:7f00:1', 'ff02::1', '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '169.254.169.254', 'fc00::1']) {
    expect(isPublicNetworkAddress(address), address).toBe(false);
  }
  expect(isPublicNetworkAddress('93.184.216.34')).toBe(true);
  expect(isPublicNetworkAddress('2606:4700:4700::1111')).toBe(true);
});
