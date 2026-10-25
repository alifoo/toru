import {expect,it} from 'vitest';
import {sameProductSite} from './product-origin.js';
it('allows actual product subdomains, not lookalikes or neighboring hosted tenants',()=>{
  expect(sameProductSite('https://app.acme.example/entrar','https://acme.example')).toBe(true);
  expect(sameProductSite('https://login.product.co.uk','https://app.product.co.uk')).toBe(true);
  for(const target of ['https://acme.example.evil.com','https://evilacme.example','http://app.acme.example','https://127.0.0.1','https://localhost','https://app.acme.example:444'])expect(sameProductSite(target,'https://acme.example')).toBe(false);
  expect(sameProductSite('https://other.vercel.app','https://product.vercel.app')).toBe(false);
  expect(sameProductSite('https://other.github.io','https://product.github.io')).toBe(false);
  expect(sameProductSite('https://app.acme.example','https://com')).toBe(false);
});
