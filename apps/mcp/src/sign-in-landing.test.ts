import { expect, it } from 'vitest';
import { openAfterSignIn, signedInPage } from './sign-in-landing.js';

it('keeps only origin and path of the signed-in page', () => {
  expect(signedInPage('https://app.example.com/home?token=secret#x')).toBe('https://app.example.com/home');
  expect(signedInPage('about:blank')).toBeUndefined();
  expect(signedInPage('not a url')).toBeUndefined();
  expect(signedInPage(undefined)).toBeUndefined();
});
it('replaces only a bare home page with where the sign-in landed', () => {
  expect(openAfterSignIn('https://example.com', 'https://app.example.com/home')).toBe('https://app.example.com/home');
  expect(openAfterSignIn('https://example.com/', 'https://app.example.com/home')).toBe('https://app.example.com/home');
  expect(openAfterSignIn('https://example.com/sheets', 'https://app.example.com/home')).toBe('https://example.com/sheets');
  expect(openAfterSignIn('https://example.com/?tab=2', 'https://app.example.com/home')).toBe('https://example.com/?tab=2');
  expect(openAfterSignIn('https://example.com', undefined)).toBe('https://example.com');
});
