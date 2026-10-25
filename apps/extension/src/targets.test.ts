import { expect, it } from 'vitest';
import { RECORDING_PLACEHOLDER } from './placeholder.js';
import { allowedTarget, onProductSite } from './targets.js';

it('follows a demo of a public product to any https site, never to the user\'s dev server', () => {
  const product = new URL('https://app.example.com/dashboard');
  for (const url of ['https://app.example.com/settings', 'https://accounts.google.com/o/oauth2', 'about:blank', RECORDING_PLACEHOLDER]) {
    expect(allowedTarget(url, product, [product.origin]), url).toBe(true);
  }
  for (const url of ['http://localhost:3000/', 'http://127.0.0.1:3000/', 'http://app.test/', 'http://app.example.com/', 'http://10.0.0.8/',
    'http://192.168.1.20/', 'file:///etc/passwd', 'chrome://settings', 'javascript:alert(1)', 'https://user:pw@app.example.com/']) {
    expect(allowedTarget(url, product, [product.origin]), url).toBe(false);
  }
});

it('keeps a demo of a development server on its origin, plus public https sites', () => {
  for (const start of ['http://localhost:3000/', 'https://localhost:8443/', 'http://127.0.0.1:5173/', 'http://[::1]:3000/', 'http://shop.localhost:3000/', 'http://acme.test/']) {
    const product = new URL(start);
    expect(allowedTarget(new URL('/invoices/new?x=1', product).href, product, [product.origin]), start).toBe(true);
    expect(allowedTarget('https://accounts.google.com/signin', product, [product.origin]), start).toBe(true);
    expect(onProductSite(new URL('/login', product).href, product), start).toBe(true);
  }
  const product = new URL('http://localhost:3000/');
  for (const url of ['http://127.0.0.1:3000/', 'http://admin.localhost:3000/', 'http://10.0.0.8:3000/', 'http://service.internal/']) {
    expect(allowedTarget(url, product, [product.origin]), url).toBe(false);
  }
  // The same local host on another port or scheme is the same product: an app on :3000 signing in through :3001.
  for (const url of ['http://localhost:3001/callback', 'https://localhost:3000/']) {
    expect(allowedTarget(url, product, [product.origin]), url).toBe(true);
  }
  expect(allowedTarget('http://127.0.0.1:3000/', product, [product.origin, 'http://127.0.0.1:3000'])).toBe(true);
  expect(onProductSite('http://localhost:3001/login', product)).toBe(true);
  expect(onProductSite('http://127.0.0.1:3000/login', product)).toBe(false);
  expect(onProductSite('https://accounts.google.com/signin', product)).toBe(false);
});
