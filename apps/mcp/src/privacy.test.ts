import { expect, it } from 'vitest';
import { z } from 'zod';
import { privacyOf, privacySchema } from './privacy.js';

it('reads the privacy option as an object or as the JSON string an older tool list sends', () => {
  const options = { keepEmailDomains: ['usenock.com'], blurTexts: ['Rafael Paduan'] };
  expect(privacySchema.parse(options)).toEqual(options);
  expect(privacySchema.parse(JSON.stringify(options))).toEqual(options);
  expect(privacyOf(JSON.stringify({ keepEmailDomains: ['UseNock.com'] }))).toEqual({ keepEmailDomains: ['usenock.com'] });
  expect(() => privacySchema.parse('not json')).toThrow();
  expect(() => privacySchema.parse('{"script":"x"}')).toThrow();
  // The tool list still describes an object.
  expect(z.toJSONSchema(z.object({ privacy: privacySchema.optional() }), { io: 'input', unrepresentable: 'any' }).properties?.privacy).toBeDefined();
});
