"use client";
import {useEffect,useState} from 'react';
/** The one-time code lives only in the URL fragment: it never reaches our server or logs. */
export function MacSetup() {
  const [link,setLink]=useState('');const [code,setCode]=useState('');const [server,setServer]=useState('');const [copied,setCopied]=useState(false);
  useEffect(()=>{
    const params=new URLSearchParams(window.location.hash.slice(1));
    const s=params.get('server')??'',c=params.get('code')??'';
    if(!/^https?:\/\/[^\s/]+$/.test(s)||!/^[A-Za-z0-9_-]{20,128}$/.test(c))return;
    setServer(s);setCode(c);
    const target=`toru-mac://pair?${new URLSearchParams({server:s,code:c}).toString()}`;
    setLink(target);
    window.location.href=target;
  },[]);
  if(!code)return <p>This setup link is incomplete or expired. Ask your agent for a new one, or use Connections → Pair a Mac in the console.</p>;
  return <>
    <p>Toru should open by itself. If it did not, use the button, or paste the code into the Toru bar (chip “Not connected”).</p>
    <p><a className="primary" href={link}>Open Toru</a></p>
    <div className="token-box">
      <label>One-time code<code>{code}</code></label>
      <label>Server<code>{server}</code></label>
      <button className="copy" onClick={async()=>{try{await navigator.clipboard.writeText(code);setCopied(true);}catch{}}}>{copied?'Copied':'Copy code'}</button>
    </div>
    <p>Don’t have Toru yet? Paste this into Terminal; it installs Toru and opens it. Then come back to this link. The code expires five minutes after it was issued.</p>
    <pre className="install-line"><code>curl -fsSL https://toru.tools/install.sh | bash</code></pre>
    <p>Or <code>brew install --cask alifoo/toru/toru</code>, or see <a className="text-link" href="/mac">other ways to install</a>.</p>
  </>;
}
