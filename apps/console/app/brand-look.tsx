"use client";

/**
 * The render's background catalog (`backgroundCatalog` in packages/render-contract), as the console shows it.
 * Thumbnails live in public/backgrounds; the full images are served by the render page. Keep the ids in sync.
 */
export const backgrounds: ReadonlyArray<{ id: string; label: string; group: "gradient" | "solid" | "wallpaper" }> = [
  { id: "toru-sky", label: "Sky", group: "gradient" },
  { id: "toru-mist", label: "Mist", group: "gradient" },
  { id: "toru-sand", label: "Sand", group: "gradient" },
  { id: "toru-mint", label: "Mint", group: "gradient" },
  { id: "toru-lilac", label: "Lilac", group: "gradient" },
  { id: "toru-peach", label: "Peach", group: "gradient" },
  { id: "toru-aurora", label: "Aurora", group: "gradient" },
  { id: "toru-ocean", label: "Ocean", group: "gradient" },
  { id: "toru-midnight", label: "Midnight", group: "gradient" },
  { id: "toru-graphite", label: "Graphite", group: "gradient" },
  { id: "solid-white", label: "White", group: "solid" },
  { id: "solid-paper", label: "Paper", group: "solid" },
  { id: "solid-slate", label: "Slate", group: "solid" },
  { id: "solid-black", label: "Black", group: "solid" },
  { id: "openscreen-2", label: "Rays", group: "wallpaper" },
  { id: "openscreen-11", label: "Dawn rays", group: "wallpaper" },
  { id: "openscreen-12", label: "Northern rays", group: "wallpaper" },
  { id: "openscreen-14", label: "Swirl", group: "wallpaper" },
  { id: "openscreen-15", label: "Clouds", group: "wallpaper" },
  { id: "openscreen-17", label: "Brushstroke", group: "wallpaper" },
  { id: "openscreen-18", label: "Hills", group: "wallpaper" },
  { id: "openscreen-1", label: "Crimson", group: "wallpaper" },
];

const presets: Record<string, string> = {
  midnight: "linear-gradient(135deg, #131725 0%, #344260 100%)",
  ocean: "linear-gradient(135deg, #083344 0%, #0e7490 50%, #a5f3fc 100%)",
  sunset: "linear-gradient(135deg, #312e81 0%, #be185d 55%, #fed7aa 100%)",
};

/** The CSS background a brand renders on: a catalog image, a colour, a gradient, or the accent's gradient. */
export function backgroundCss(background: string | undefined, accent: string): string {
  if (background && backgrounds.some(entry => entry.id === background)) return `center / cover url(/backgrounds/${background}.jpg)`;
  if (background && presets[background]) return presets[background];
  if (background) return background;
  return `linear-gradient(135deg, color-mix(in srgb, ${accent} 45%, #000), ${accent})`;
}

const groups: Array<{ key: "gradient" | "solid" | "wallpaper"; title: string }> = [
  { key: "gradient", title: "Gradients" },
  { key: "solid", title: "Solid" },
  { key: "wallpaper", title: "Wallpapers" },
];

/**
 * Background and padding for a brand, with a preview drawn the way the renderer lays a recording out: the
 * recording shrinks by `padding / 100 * 0.4` of the frame and sits centred on the background.
 */
export function BrandLook({ background, accent, padding, radius = 12, logo, onChange }: {
  background: string | undefined;
  accent: string;
  padding: number;
  radius?: number;
  logo?: string | undefined;
  onChange: (patch: { background?: string | undefined; padding?: number }) => void;
}) {
  const custom = background?.startsWith("#") ? background : undefined;
  const scale = 1 - (padding / 100) * 0.4;
  const swatch = (id: string | undefined, label: string, css: string) => (
    <button key={id ?? "accent"} type="button" className="look-swatch" aria-pressed={background === id} title={label}
      aria-label={label} style={{ background: css }} onClick={() => onChange({ background: id })} />
  );
  return <div className="look">
    <div className="look-preview" style={{ background: backgroundCss(background, accent) }} aria-hidden="true">
      <div className="look-window" style={{ width: `${scale * 100}%`, height: `${scale * 100}%`, borderRadius: padding === 0 ? 0 : radius * 0.5 }}>
        <span className="look-bar"><i /><i /><i /></span>
        <span className="look-lines"><b /><b /><b /></span>
      </div>
      {logo && <img className="look-logo" src={logo} alt="" />}
    </div>
    <div className="look-controls">
      <div className="look-group">
        <span>From your color</span>
        <div className="look-swatches">{swatch(undefined, "From your accent color", backgroundCss(undefined, accent))}</div>
      </div>
      {groups.map(group => <div className="look-group" key={group.key}>
        <span>{group.title}</span>
        <div className="look-swatches">
          {backgrounds.filter(entry => entry.group === group.key).map(entry => swatch(entry.id, entry.label, `center / cover url(/backgrounds/${entry.id}.jpg)`))}
          {group.key === "solid" && <label className={`look-swatch look-custom${custom ? " on" : ""}`} title="Custom color" style={custom ? { background: custom } : undefined}>
            <span aria-hidden="true">+</span>
            <input type="color" aria-label="Custom background color" value={custom ?? "#111827"} onChange={event => onChange({ background: event.target.value })} />
          </label>}
        </div>
      </div>)}
      <label className="look-padding">Padding <output>{padding}</output>
        <input type="range" min={0} max={100} value={padding} onChange={event => onChange({ padding: Number(event.target.value) })} />
      </label>
    </div>
  </div>;
}
