import type {Metadata} from 'next';
import {PublicPage} from '../public-landing';
import chromeJson from '../../public/downloads/chrome.json';
export const metadata:Metadata={title:'Toru for Chrome',description:'Record demos in your own signed-in Chrome. Your agent opens the product in a window of its own, records the flow through Toru and gets back a checked video.',alternates:{canonical:'https://toru.tools/chrome'}};

type ChromeRelease={channel:string;version:string;bytes:number;sha256:string;publishedAt:string;webStoreUrl:string|null};
function chromeRelease():ChromeRelease|null{
 const release=chromeJson as Partial<ChromeRelease>;
 return typeof release.version==='string'&&typeof release.sha256==='string'?release as ChromeRelease:null;
}
export default function ChromePage(){
 const release=chromeRelease();
 return <PublicPage>
   <p className="eyebrow">Chrome 120 or newer · {release?.webStoreUrl?'Chrome Web Store':'Beta'}</p><h1>Toru for Chrome</h1>
   <p>Record a demo in your own Chrome, where you are already signed in to your product. Your agent asks Toru for the demo; Toru opens the product in a window of its own and records the flow with the same cursor, zooms, brand and delivery check as every Toru video. No sharing dialog, no click per recording.</p>
   <h2>Install</h2>
   {release?.webStoreUrl ? <p><a className="primary" href={release.webStoreUrl} data-cta="add-to-chrome">Add to Chrome ↗</a></p> : <p>Toru for Chrome is not published yet.</p>}
   <h2>Connect</h2>
   <ol>
    <li>Ask your agent to connect Toru for Chrome. It calls <code>extension_pair</code> and gives you a one-time link.</li>
    <li>Open the link in the Chrome where you installed the extension. It connects by itself; the page says <b>Chrome connected</b>.</li>
    <li>Ask for a demo. Your agent finds the connected Chrome with <code>extension_devices</code> and records with <code>recording_run</code>.</li>
   </ol>
   <p>Each recording opens a new window on your product. Leave it open until the recording ends; Toru closes it. If the product asks you to sign in, sign in in that window and ask your agent to record again.</p>
   <h2>What the extension can do</h2>
   <p>Toru controls only the window it opens for a recording. It starts on the product your agent asked to record and follows the demo wherever it goes, such as a consent screen or a checkout; Chrome shows a notice while it does. It cannot read your other tabs, and it never sends Toru your passwords, cookies or browser storage. A password or one-time-code field stops the recording instead of being recorded. The video of that window is uploaded to Toru to produce your demo. See <a className="text-link" href="/privacy#chrome">privacy details</a>.</p>
   <h2>Disconnect</h2>
   <p>Click the Toru icon in the toolbar and choose <b>Disconnect this Chrome</b>, ask your agent to call <code>extension_disconnect</code>, or remove the extension in <code>chrome://extensions</code>.</p>
  </PublicPage>;
}
