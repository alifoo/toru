import { describe, expect, it } from "vitest";
import { brandFromSite, hexColour, isPublicAddress, readManifest, readPage } from "./brand-from-site";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("logo")]);

describe("brand from a site", () => {
  it("never reaches private, loopback or link-local addresses", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "not-an-ip"])
      expect(isPublicAddress(address), address).toBe(false);
    for (const address of ["93.184.216.34", "2606:4700::1111"]) expect(isPublicAddress(address), address).toBe(true);
  });

  it("reads plain colours and ignores anything else", () => {
    expect(hexColour("#ABC")).toBe("#aabbcc");
    expect(hexColour("rgb(61, 111, 216)")).toBe("#3d6fd8");
    expect(hexColour("#3d6fd8cc")).toBe("#3d6fd8");
    expect(hexColour("var(--brand)")).toBeUndefined();
  });

  it("reads the name, theme colour, manifest and PNG icons a page declares", () => {
    const page = readPage(`<html><head><title>Acme — Invoices</title>
      <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#3d6fd8">
      <meta property="og:site_name" content="Acme"><link rel="manifest" href="/site.webmanifest">
      <link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="icon" type="image/png" sizes="32x32" href="/i32.png">
      <link rel="icon" type="image/png" sizes="192x192" href="/i192.png"><link rel="icon" href="/favicon.ico"></head></html>`, new URL("https://acme.example/app"));
    expect(page).toMatchObject({ name: "Acme", themeColour: "#3d6fd8", manifest: "https://acme.example/site.webmanifest", appleIcon: "https://acme.example/apple-touch-icon.png" });
    expect(page.icons).toEqual(["https://acme.example/i192.png", "https://acme.example/i32.png"]);
    expect(readManifest('{"theme_color":"#123456","icons":[{"src":"/a.png","sizes":"1024x1024"},{"src":"/b.png","sizes":"256x256"},{"src":"/c.svg"}]}', new URL("https://acme.example/m.json")))
      .toEqual({ themeColour: "#123456", icons: ["https://acme.example/b.png", "https://acme.example/a.png"] });
  });

  it("prefills colour and logo, skipping a white theme colour and anything that is not a PNG", async () => {
    const files: Record<string, { type: string; body: Buffer }> = {
      "https://acme.example/": { type: "text/html", body: Buffer.from(`<meta name="theme-color" content="#fff"><link rel="manifest" href="/m.json"><link rel="apple-touch-icon" href="/touch.png">`) },
      "https://acme.example/m.json": { type: "application/json", body: Buffer.from('{"theme_color":"#d36b59","name":"Acme","icons":[{"src":"/i.png","sizes":"192x192"}]}') },
      "https://acme.example/touch.png": { type: "text/html", body: Buffer.from("<html>not an image</html>") },
      "https://acme.example/i.png": { type: "image/png", body: png },
    };
    const fetcher = async (url: string) => { const file = files[url]; if (!file) throw new Error("site_unavailable"); return { url: new URL(url), ...file }; };
    expect(await brandFromSite("acme.example", fetcher)).toEqual({ origin: "https://acme.example", name: "Acme", accent: "#d36b59",
      logo: `data:image/png;base64,${png.toString("base64")}`, found: { accent: "manifest", logo: "manifest" } });
  });
});
