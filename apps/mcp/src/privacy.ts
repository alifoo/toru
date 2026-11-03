import { PrivacyOptionsSchema, type PrivacyOptions } from '@content-layer/browser';
import { z } from 'zod';

/** The recording's privacy option (recording_run and session_open): what the live blur keeps legible and what it adds. */
/**
 * A client holding a tool schema from before this option existed sends the object as a JSON string; it is read the same.
 * The published schema stays the object (the MCP SDK lists a preprocessed schema by its output).
 */
const fromJsonString = (value: unknown) => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
};
export const privacySchema = z.preprocess(fromJsonString, PrivacyOptionsSchema).describe(
  'Toru for Chrome: what the page blur keeps and adds. By default every e-mail address on screen is blurred on every page the recording shows '
  + '(also sign-in, consent and webmail pages such as accounts.google.com and mail.google.com), together with the person\'s name beside it '
  + '(same row of a list, "Name <address>"), plus phone numbers and the name columns of a table of contacts. '
  + 'keepEmailDomains: domains whose addresses (and the names beside them) stay legible, subdomains included, e.g. ["usenock.com"] for the user\'s '
  + 'own company; only when the user asks. blurTexts: extra texts to blur wherever they appear (case-insensitive, up to 200), e.g. lead or customer '
  + 'names in a list that shows no e-mail next to them. Ignored when showEmails is true.',
);

/** The option as a job stores it: absent when it changes nothing. */
export function privacyOf(value: unknown): PrivacyOptions | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = privacySchema.parse(value);
  const options: PrivacyOptions = {
    ...(parsed.keepEmailDomains?.length ? { keepEmailDomains: [...new Set(parsed.keepEmailDomains)] } : {}),
    ...(parsed.blurTexts?.length ? { blurTexts: [...new Set(parsed.blurTexts)] } : {}),
  };
  return Object.keys(options).length ? options : undefined;
}
