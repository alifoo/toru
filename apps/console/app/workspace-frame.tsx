"use client";

import { UserButton } from "@clerk/nextjs";
import { useEffect, useState, type ReactNode } from "react";
import { ToruOrb } from "./toru-orb";

/** Hash routes keep the console one page while still being linkable. Old links (#connect, #settings, #activity) still land. */
const views = ["demos", "demo", "recording", "brand", "accounts", "agents", "plan"] as const;
export type WorkspaceView = (typeof views)[number];
export type WorkspaceRoute = { view: WorkspaceView; param?: string; redirect?: string };
const legacy: Record<string, WorkspaceView> = { connect: "agents", settings: "plan", activity: "demos", recordings: "demos" };
/** New demos and setup live on the onboarding page now; old hash links land there. */
const elsewhere: Record<string, string> = { new: "/onboarding?step=prompt&from=demos", onboarding: "/onboarding" };

const titles: Record<WorkspaceView, string> = { demos: "Demos", demo: "Demo", recording: "Recording", brand: "Settings", accounts: "Logins", agents: "Connections", plan: "Billing" };

export function parseRoute(hash: string, search = ""): WorkspaceRoute {
  const [head = "", param] = hash.replace(/^#/, "").split("/");
  if ((head === "demo" || head === "recording") && param && /^[0-9a-f-]{36}$/i.test(param)) return { view: head, param };
  if ((views as readonly string[]).includes(head) && head !== "demo" && head !== "recording") return { view: head as WorkspaceView };
  if (elsewhere[head]) return { view: "demos", redirect: elsewhere[head] };
  if (legacy[head]) return { view: legacy[head]! };
  return { view: new URLSearchParams(search).has("billing") ? "plan" : "demos" };
}

export function useWorkspaceRoute() {
  const [route, setRoute] = useState<WorkspaceRoute>({ view: "demos" });
  useEffect(() => {
    const sync = () => {
      const next = parseRoute(window.location.hash, window.location.search);
      if (next.redirect) { window.location.assign(next.redirect); return; }
      setRoute(next);
      // One page, several views: the tab names the one on screen.
      document.title = `${titles[next.view]} · Toru`;
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  return route;
}

const icon = (path: ReactNode) => <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{path}</svg>;
/** Saved logins (#accounts) are left off: Toru records in the user's own Chrome or Mac, signed in already. The view stays
 * reachable so anyone who saved one can still remove it. */
const nav: Array<{ view: WorkspaceView; label: string; hint: string; icon: ReactNode; also?: WorkspaceView[] }> = [
  { view: "demos", label: "Demos", hint: "Every demo and recording, live", also: ["demo", "recording"],
    icon: icon(<><rect x="2.5" y="4" width="15" height="12" rx="3" /><path d="M8.5 7.6v4.8l4-2.4-4-2.4Z" fill="currentColor" stroke="none" /></>) },
  { view: "agents", label: "Connections", hint: "Your agent, and the Chrome and Macs Toru records in",
    icon: icon(<><path d="M7 3v4M13 3v4M5.5 7h9v2.5a4.5 4.5 0 0 1-9 0V7ZM10 14v3" /></>) },
  { view: "plan", label: "Billing", hint: "Credits, plan and payments",
    icon: icon(<><rect x="2.5" y="5" width="15" height="10.5" rx="2" /><path d="M2.5 8.5h15M5.5 12.5h3" /></>) },
  { view: "brand", label: "Settings", hint: "Your products' look, and your account",
    icon: icon(<><circle cx="10" cy="10" r="2.6" /><path d="M10 2.8v2.1M10 15.1v2.1M2.8 10h2.1M15.1 10h2.1M4.9 4.9l1.5 1.5M13.6 13.6l1.5 1.5M4.9 15.1l1.5-1.5M13.6 6.4l1.5-1.5" /></>) },
];

export function WorkspaceFrame({ route, locked, available, title, newDemoHref = "/onboarding?step=prompt&from=demos", identity, children }: {
  route: WorkspaceRoute; locked: boolean; available?: number; title: ReactNode; newDemoHref?: string; identity?: ReactNode; children: ReactNode;
}) {
  const block = (event: { preventDefault(): void }) => { if (locked) event.preventDefault(); };
  return <div className="studio">
    <aside className="studio-rail" aria-label="Workspace">
      <a className="st-brand studio-mark" href="#demos" aria-label="Toru demos" onClick={block}><ToruOrb size={20} still />toru</a>
      {!locked && <a className="primary studio-new" href={newDemoHref} data-cta="console-new-demo"><span className="record-dot" aria-hidden="true" />New demo</a>}
      <nav>
        {nav.map(item => {
          const current = item.view === route.view || item.also?.includes(route.view);
          return <a key={item.view} href={`#${item.view}`} title={item.hint} aria-current={current ? "page" : undefined} aria-disabled={locked || undefined} onClick={block}>
            {item.icon}<span>{item.label}</span>
          </a>;
        })}
      </nav>
      <div className="studio-rail-foot">
        {available !== undefined && !locked && <a className="credit-chip" href="#plan" title="1 credit = 1 delivered video that passed the delivery check. Held videos and failed runs are never charged.">
          <strong>{available}</strong><span>{available === 1 ? "credit" : "credits"}</span>
        </a>}
        <div className="studio-identity">{identity ?? <UserButton />}<a className="text-link" href="https://toru.tools/docs" target="_blank" rel="noreferrer">Help</a></div>
      </div>
    </aside>
    <main className="studio-main">
      {/* A dashboard needs no page headline; the name stays for screen readers and the tab. */}
      {title !== null && <h1 className="visually-hidden">{title}</h1>}
      {children}
    </main>
  </div>;
}
