/**
 * Toru's lens, turning: a seamless loop of the 3D lens (rendered offline from a three.js scene whose light is the
 * icon's own reflection) as an animated WebP, so no WebGL runs in the page. Reduced motion shows a still frame;
 * `still` always does (small marks such as the nav). Decorative only.
 */
export function ToruOrb({ size = 56, still = false }: { size?: number; still?: boolean }) {
  if (still) return <span className="toru-orb" style={{ ["--orb" as string]: `${size}px` }} aria-hidden="true"><img src="/loading/toru-orb-still.png" width={size} height={size} alt="" decoding="async" /></span>;
  return <span className="toru-orb" style={{ ["--orb" as string]: `${size}px` }} aria-hidden="true">
    <picture>
      <source media="(prefers-reduced-motion: reduce)" srcSet="/loading/toru-orb-still.png" />
      <img src={size > 64 ? "/loading/toru-orb-256.webp" : "/loading/toru-orb-128.webp"} width={size} height={size} alt="" decoding="async" />
    </picture>
  </span>;
}
