import type { ReactNode } from "react";
import { APP_URL } from "./site";
import { sourceUrl } from "./pricing/plans";
import { ToruOrb } from "./toru-orb";

/** The nav every public page shares: the turning lens, quiet links, one glass button. On phones the links fold into a menu. */
export function PublicHeader({account}:{account?:ReactNode}={}){
 const links=<><a href="/#use-cases">Use cases</a><a href="/pricing">Pricing</a><a href="/docs">Docs</a>{sourceUrl&&<a href={sourceUrl} target="_blank" rel="noreferrer">Source</a>}</>;
 return <header className="st-nav"><a className="st-brand" href="/" aria-label="Toru home"><ToruOrb size={22} still/>toru</a><nav className="st-nav-links" aria-label="Main navigation">{links}</nav><div className="st-nav-end">{account??<><a className="st-signin" href={APP_URL}>Sign in</a><a className="primary st-nav-cta" href={APP_URL} data-cta="nav-start-free"><span className="record-dot" aria-hidden="true"/>Start free</a></>}<details className="st-menu"><summary aria-label="Menu"><i/></summary><nav aria-label="Menu">{links}<a href={APP_URL}>Sign in</a></nav></details></div></header>;
}
/** A public page below the landing: the same nav, a readable column, the same footer. */
export function PublicPage({children}:{children:ReactNode}){return <div className="public-site lw-site"><div className="lw-container"><PublicHeader/></div><main className="legal-page">{children}</main><PublicFooter/></div>;}


export function PublicFooter(){
 return <footer className="lw-footer">
  <div className="lw-footer-brand"><span className="st-brand"><ToruOrb size={20} still/>toru</span><p>Your agent records your product demos.</p><small>Limited public beta</small></div>
  <nav aria-label="Product"><h2>Product</h2><a href="/chrome">Toru for Chrome</a><a href="/mac">Toru for Mac</a><a href="/docs">Docs</a></nav>
  <nav aria-label="Toru"><h2>Toru</h2><a href="/#why">Why Toru</a><a href="/#how-it-works">Set up</a><a href="/pricing">Pricing</a><a href="/#faq">FAQ</a></nav>
  <nav aria-label="Company"><h2>Company</h2><a href={APP_URL}>Open app</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="mailto:support@toru.tools">Get in touch</a></nav>
  <p className="lw-copyright">© 2026 Toru</p>
 </footer>;
}

