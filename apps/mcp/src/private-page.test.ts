import { describe, expect, it } from 'vitest';
import { privatePageScript, signInField } from './private-page.js';

const field = (overrides: Partial<Parameters<typeof signInField>[0]>) =>
  signInField({ type: 'text', autocomplete: '', name: '', id: '', ariaLabel: '', placeholder: '', ...overrides });

describe('signInField', () => {
  it('treats password and one-time-code fields as sign-in', () => {
    expect(field({ type: 'password' })).toBe(true);
    expect(field({ type: 'password', name: 'password' })).toBe(true);
    expect(field({ autocomplete: 'one-time-code' })).toBe(true);
    expect(field({ type: 'text', autocomplete: 'current-password' })).toBe(true);
  });

  it('does not treat masked API keys, tokens or secrets on a settings page as sign-in', () => {
    expect(field({ type: 'password', name: 'apiKey', autocomplete: 'off' })).toBe(false);
    expect(field({ type: 'password', placeholder: 'API key' })).toBe(false);
    expect(field({ type: 'password', id: 'stripe-secret' })).toBe(false);
    expect(field({ type: 'password', ariaLabel: 'Access token' })).toBe(false);
  });

  it('still flags a key-named field that asks for the current password', () => {
    expect(field({ type: 'password', name: 'apiKey', autocomplete: 'current-password' })).toBe(true);
  });

  it('ignores ordinary inputs', () => {
    expect(field({ type: 'email', name: 'email' })).toBe(false);
    expect(field({ type: 'search' })).toBe(false);
  });
});

describe('privatePageScript', () => {
  it('embeds the field check as standalone, runnable code', () => {
    expect(privatePageScript).toContain('const signInField=');
    // The serialized function must not reference anything outside itself.
    const check = new Function(`return ${signInField.toString()}`)() as typeof signInField;
    expect(check({ type: 'password', autocomplete: '', name: 'apiKey', id: '', ariaLabel: '', placeholder: '' })).toBe(false);
  });
});

describe('privateFieldsScript', () => {
  it('checks only sign-in fields, not the URL path, for sites other than the product', async () => {
    const { privateFieldsScript } = await import('./private-page.js');
    expect(privateFieldsScript).not.toContain('location.pathname');
    expect(privateFieldsScript).toContain('privateRoot(document)');
    expect(privatePageScript).toContain('location.pathname');
  });
});
