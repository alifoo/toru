import type {Metadata} from 'next';
import {PublicPage} from '../public-landing';
import {sourceUrl} from '../pricing/plans';
export const metadata:Metadata={title:'Docs · Toru',description:'Connect Toru to Claude Code, Claude, Cursor or Codex, pair your Chrome or Mac, and ask for a demo. Brand, delivery check and credits explained.',alternates:{canonical:'https://toru.tools/docs'}};
export default function Docs(){return <PublicPage><p className="eyebrow">Guide</p><h1>Give your agent<br/>a camera.</h1>
 <p>Toru is recording infrastructure for your AI agent. Connect it once, pair the Chrome or Mac it records in, and ask for a demo in your own words. This page is the whole of it.</p>
 <h2 id="connect">1. Connect your agent</h2>
 <p>In Claude Code, Claude, Cursor, Codex or any client that supports remote MCP servers, add a connector with the address <code>https://mcp.toru.tools/mcp</code>, then sign in to Toru and approve the connection. In Claude Code you can also install the Toru skill from <code>alifoo/toru-skills</code>. This connects your agent to Toru; it does not sign in to your product.</p>
 <h2 id="where">2. Choose where Toru records</h2>
 <p>Toru records in two places, both already signed in as you. It never asks for a password or a code, and a sign-in page stops the run instead of being recorded.</p>
 <h3 id="chrome">Web apps: your own Chrome</h3>
 <p>Install <a href="/chrome">Toru for Chrome</a> and pair it once from a link your agent gives you. Each recording opens your product in a window of its own, signed in with your session, with no click from you. Your cookies and storage never leave Chrome.</p>
 <h3 id="mac">Mac apps: Toru for Mac</h3>
 <p>Install <a href="/mac">Toru for Mac</a> with one line in Terminal, <code>curl -fsSL https://toru.tools/install.sh | bash</code> (or <code>brew install --cask alifoo/toru/toru</code>), pair it from a link your agent gives you, and choose the window or display to share. You approve what is shared, and you can stop sharing at any time.</p>
 <h2 id="ask">3. Ask for a demo</h2>
 <blockquote>Record a demo of creating an invoice in https://app.acme.com: open Invoices, click New invoice, choose Acme Inc. as the customer, save, and end on the invoice page.</blockquote>
 <p>Before recording, your agent writes a short plan of the flow: the screens, the exact buttons and fields, the values to use and what the last screen should show. If it can read your product’s code it uses that; otherwise it looks at the live product. The more specific your request, the better the demo. Ask for one flow per demo.</p>
 <p>Then your agent records the flow itself, one click at a time, in a window Toru opens for it. When the last screen is on show it tells Toru it is done; Toru holds on that screen, stops, renders the video with your brand and checks it. Your agent spends a few tokens per step; Toru adds no model of its own.</p>
 <h2 id="brand">Your brand</h2>
 <p>In the console, open <b>Settings</b> and paste your product’s address: Toru reads its colour and logo from the site. Adjust the background, padding, intro and outro cards, the camera’s zoom, the cursor, the GIF and the output size, then save. Every demo of that product uses them automatically.</p>
 <h2 id="check">Delivery check and credits</h2>
 <p>Every video is checked before delivery. Blank, frozen or too-short videos are held back as needing review and never charged; you can record again or accept the video anyway. One credit is used when a video is delivered. See <a href="/pricing">pricing</a>.</p>
 <h2 id="library">Your demos</h2>
 <p>Your agent hands you links to the MP4 and GIF. Every demo also stays in <a href="https://app.toru.tools/#demos">Demos</a> for your plan’s storage period, with each step of the plan on the video’s timeline. Changed your brand? Render a demo again from there while its capture is kept; it uses no credit.</p>
 <h2 id="help">If something goes wrong</h2>
 <ul>
  <li><b>Needs review:</b> the video did not pass the check and no credit was used. Ask your agent to record again with a clearer flow.</li>
  <li><b>Stopped at a sign-in page:</b> sign in to your product in that Chrome or app, then ask again.</li>
  <li><b>Chrome or Mac offline:</b> open Chrome or the Toru app; a paired device reconnects by itself.</li>
  <li><b>Waiting for capacity:</b> the beta records one demo at a time across all accounts. A run that finds Toru busy waits its turn, up to ten minutes, before recording; your agent can keep polling its status.</li>
  <li><b>Anything else:</b> email <a href="mailto:support@toru.tools">support@toru.tools</a>.</li>
 </ul>
{sourceUrl&&<><h2 id="self-host">Run it yourself</h2>
 <p>Toru is open source under the MIT license: the recorder, Toru for Chrome, Toru for Mac and the console are at <a href={sourceUrl}>{sourceUrl.replace('https://','')}</a>. Run it on your own machines, with no model key to bring: your agent drives. The hosted service is the same code, run for you.</p></>}
 <h2 id="more">More</h2><p><a href="/pricing">Pricing</a> · <a href="/terms">Terms of Service</a> · <a href="/privacy">Privacy Policy</a> · <a href="/llms.txt">Plain-text summary for agents</a></p>
 </PublicPage>;}
