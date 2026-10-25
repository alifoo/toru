/**
 * The look of the small pages the recorder serves itself (pairing Chrome, the hosted sign-in), matching toru.tools:
 * a cool grey ground, a white card with a hairline, quiet type, the lens as the mark. No web fonts or images are
 * loaded, so these pages make no request outside the recorder.
 */
export const pageStyle = `:root{color-scheme:light;font-family:"IBM Plex Sans","Avenir Next",ui-sans-serif,system-ui,sans-serif;color:#22313b;background:#e7ecef}*{box-sizing:border-box}
body{margin:0;min-height:100svh;display:grid;place-items:center;padding:28px 20px;background:radial-gradient(40% 26% at 12% 0%,#dce8f1 0%,transparent 70%),radial-gradient(36% 24% at 90% 4%,#e6e1f2 0%,transparent 70%),#e7ecef}
main{position:relative;width:min(440px,100%)}
.brand{font-size:21px;font-weight:500;letter-spacing:-.06em;display:flex;align-items:center;gap:9px;margin:0 0 22px;justify-content:center}.brand svg{display:none}
.brand::before{content:"";width:22px;height:22px;border-radius:50%;border:1px solid #fff;background:radial-gradient(circle at 35% 25%,#fff,#ebf5f7 22%,#90a9b5 48%,#f9ffff 53%,#647e8b 59%,#e9f2f7 69%,#fff 74%,#a5b8c2);box-shadow:0 3px 6px #2a495326}
.card{position:relative;padding:28px;border:0;border-radius:13px;background:#fff;box-shadow:0 0 0 1px #e1e7eb,0 1px 2px #2c46540d,0 24px 48px -32px #2c465440}
h1{font-size:22px;line-height:1.25;letter-spacing:-.02em;margin:0 0 10px;font-weight:500}
p{font-size:14px;line-height:1.6;color:#64727d;margin:0}
a{color:#22313b;text-decoration-color:#aebcc6;text-underline-offset:3px}
.icon{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;margin-bottom:20px;background:#f3f6f8;box-shadow:inset 0 0 0 1px #e1e7eb;color:#3f6b5c;font-size:18px}
.fine{font-size:12px;margin:18px 12px 0;text-align:center;color:#7b8892}
@keyframes spin{to{transform:rotate(360deg)}}`;
