import type {Metadata} from 'next';
import {PublicPage} from '../public-landing';
import {macRelease} from '../../lib/mac-release';
export const metadata:Metadata={title:'Toru for Mac: record a window or display',description:'Record a window or display on your Mac. Your agent renders and delivers the video.',alternates:{canonical:'https://toru.tools/mac'}};
export default function MacPage(){
 const {latest,releases,minimumMacOS,channel}=macRelease();
 return <PublicPage>
   <p className="eyebrow">macOS {minimumMacOS} or newer · Apple silicon · {channel}</p><h1>Toru for Mac</h1>
   <p>Record one window or one display that you choose, when you approve it. Toru uploads the finished video for rendering and your agent delivers the MP4.</p>
   <h2>Download</h2>
   {latest ? <>
    <p>Install with one line in Terminal:</p>
    <pre className="install-line"><code>curl -fsSL https://toru.tools/install.sh | bash</code></pre>
    <p>It downloads Toru {latest.version}, checks its SHA-256, puts it in Applications and opens it, with no security prompt. <a className="text-link" href="/install.sh">Read the script</a>; it is short.</p>
    <p>Or with Homebrew:</p>
    <pre className="install-line"><code>brew install --cask alifoo/toru/toru</code></pre>
    <p>Updates with <code>brew upgrade --cask toru</code>.</p>
    <h3>Or download the zip</h3>
    <p><a className="primary" href="/downloads/Toru-latest.zip" data-cta="download-mac">Download Toru {latest.version} ↓</a></p>
    <p>Stable link: <code>https://toru.tools/downloads/Toru-latest.zip</code> · Build {latest.build} · {(latest.bytes/1048576).toFixed(1)} MB · Published {new Date(latest.publishedAt).toLocaleDateString('en-US',{dateStyle:'medium'})}</p>
    <p>SHA-256 <code>{latest.sha256}</code> · Verify with <code>shasum -a 256 ~/Downloads/Toru-{latest.version}.zip</code></p>
    {latest.notarized===false ? <>
     <p>This beta build is not notarized by Apple yet, so a browser download asks you to confirm it the first time (the Terminal install above does not):</p>
     <ol>
      <li>Unzip the download and move Toru to Applications.</li>
      <li>Open Toru. When macOS says it cannot verify the app, click <b>Done</b>.</li>
      <li>Open <b>System Settings → Privacy &amp; Security</b>, scroll to the message about Toru and click <b>Open Anyway</b>, then confirm.</li>
     </ol>
     <p>You only do this once. macOS asks for Screen Recording permission the first time you choose a source. A notarized build replaces this one as soon as it is available.</p>
    </> : <p>The app is signed with a Developer ID and notarized by Apple. Unzip, move Toru to Applications and open it. macOS asks for Screen Recording permission the first time you choose a source.</p>}
    {latest.notes.length>0 && <><h3>What’s new in {latest.version}</h3><ul>{latest.notes.map(note=><li key={note}>{note}</li>)}</ul></>}
   </> : <p>The first signed beta build is not published yet. The stable link <code>https://toru.tools/downloads/Toru-latest.zip</code> will serve it with a SHA-256 checksum and release notes. Until then, record web apps with <a href="/chrome">Toru for Chrome</a>.</p>}
   <h2>Set up</h2>
   <ol>
    <li>Open <a className="text-link" href="https://app.toru.tools/#agents">Connections</a> and click <b>Pair a Mac</b>, or ask your agent to call <code>desktop_recording_pair</code>. Either gives you a one-time setup link.</li>
    <li>Open the link (or paste the code into Toru). Choose a window or display and approve recording and upload.</li>
    <li>Click <b>Share selected source</b> and tell your agent “ready”, or click <b>Record now</b> to record yourself and ask your agent to render it afterwards.</li>
   </ol>
   <h2>What leaves your Mac</h2>
   <p>Capture happens locally and is written to <code>Movies/Toru</code>. Only after you approve a recording is the finished video uploaded to Toru for rendering and delivery; your agent sees status and the rendered MP4, not your screen in real time. Desktop content is uploaded unredacted: close private windows and notifications before you approve. Recordings are video only, without audio. Toru operates the shared window only if you turn on “Let your agent operate the shared window” in Settings, and then only during recordings your agent requests. Raw captures and MP4s follow your plan’s retention; local copies stay until you delete them or the 30-day rule moves uploaded copies to the Trash. Failure reports to Toru are off unless you enable them and contain only error codes and versions. See <a className="text-link" href="/privacy#mac">privacy details</a>.</p>
   <h2>Requirements and limits</h2>
   <p>macOS {minimumMacOS} or newer on Apple silicon, Screen Recording permission, 500 MB free disk space, and a Toru account connected to an MCP client. Recordings are limited to one source and five minutes per capture. Protected content (DRM video, some secure fields) may record as black.</p>
   {releases.length>1 && <><h2>Previous releases</h2><ul>{releases.filter(r=>r.version!==latest?.version).map(r=><li key={r.version}><a className="text-link" href={r.url}>Toru {r.version}</a> · SHA-256 <code>{r.sha256}</code></li>)}</ul></>}
  </PublicPage>;
}
