'use client';
import { track } from '@vercel/analytics';
import { useEffect } from 'react';

/**
 * Reports clicks on elements marked `data-cta` as one Web Analytics event, so the launch funnel is visible from the
 * site side: hero → sign-up, the route pages, the downloads. Only the CTA name and the page path are sent.
 */
export function CtaTracking() {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const name = (event.target as Element | null)?.closest('[data-cta]')?.getAttribute('data-cta');
      if (name) track('cta', { name, path: window.location.pathname });
    };
    document.addEventListener('click', onClick, { capture: true });
    return () => document.removeEventListener('click', onClick, { capture: true });
  }, []);
  return null;
}
