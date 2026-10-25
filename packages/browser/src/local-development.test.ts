import { expect, it } from 'vitest';
import { normalizeAllowedOrigin, normalizeRecipeOrigin } from './index.js';
import { isLocalDevelopmentUrl } from './local-development.js';

it('names development servers on this machine: localhost, loopback and the .localhost and .test names, http or https, any port', () => {
  for (const url of ['http://localhost:3000/dashboard', 'https://localhost', 'http://127.0.0.1:5173', 'http://127.1:8080', 'http://[::1]:3000/',
    'http://[0:0:0:0:0:0:0:1]:4000', 'http://app.localhost:3000', 'https://shop.acme.test', 'http://a.b.test:8443/x?y=1']) {
    expect(isLocalDevelopmentUrl(url), url).toBe(true);
  }
});

it('refuses other private addresses, internal names, look-alikes, credentials and every other scheme', () => {
  for (const url of ['http://10.0.0.8:3000', 'http://192.168.1.20', 'http://169.254.169.254/latest', 'http://172.16.0.1', 'http://127.0.0.2',
    'http://service.internal', 'http://printer.local', 'http://router.lan', 'http://localhost.evil.com', 'http://evil-localhost',
    'http://test.example.com', 'http://.test', 'http://a..test', 'http://user:pass@localhost:3000', 'file:///etc/passwd', 'chrome://settings',
    'data:text/html,<p>x</p>', 'javascript:alert(1)', 'ws://localhost:3000', 'ftp://localhost', 'https://example.com', 'not a url']) {
    expect(isLocalDevelopmentUrl(url), url).toBe(false);
  }
});

it('lets an allowed origin be a development server, and nothing else that is not public https', () => {
  expect(normalizeAllowedOrigin('http://localhost:3000/dashboard')).toBe('http://localhost:3000');
  expect(normalizeAllowedOrigin('http://[::1]:3000')).toBe('http://[::1]:3000');
  expect(normalizeAllowedOrigin('http://app.test:8080')).toBe('http://app.test:8080');
  expect(normalizeAllowedOrigin('https://app.example.com/x')).toBe('https://app.example.com');
  for (const origin of ['http://app.example.com', 'http://10.0.0.8', 'https://192.168.1.20', 'http://service.internal', 'https://user:pass@localhost']) {
    expect(() => normalizeAllowedOrigin(origin), origin).toThrow('recipe_invalid');
  }
});

it('keeps recipes, which run in Toru\'s own browser, on public https and the loopback fixtures', () => {
  expect(normalizeRecipeOrigin('https://app.example.com/x')).toBe('https://app.example.com');
  expect(normalizeRecipeOrigin('http://127.0.0.1:4173')).toBe('http://127.0.0.1:4173');
  expect(normalizeRecipeOrigin('http://localhost:4173')).toBe('http://localhost:4173');
  for (const origin of ['http://insecure.test', 'https://app.test', 'http://app.localhost:3000', 'http://[::1]:3000', 'https://[::1]', 'http://10.0.0.8']) {
    expect(() => normalizeRecipeOrigin(origin), origin).toThrow('recipe_invalid');
  }
});
