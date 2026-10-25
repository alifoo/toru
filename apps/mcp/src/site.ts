/**
 * Where Toru's public site and console live. A self-hosted server sets these to its own addresses; the defaults are
 * the hosted service's. The site address also stands for "the Mac" as a recording's target, so it must match the
 * console's `NEXT_PUBLIC_SITE_URL`.
 */
const origin = (value: string | undefined, fallback: string) => (value?.trim() || fallback).replace(/\/+$/, '');
export const siteUrl = origin(process.env.TORU_SITE_URL, 'https://toru.tools');
export const appUrl = origin(process.env.TORU_APP_URL, 'https://app.toru.tools');
