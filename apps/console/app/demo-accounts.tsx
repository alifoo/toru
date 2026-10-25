"use client";
import { useCallback, useEffect, useState, type FormEvent } from 'react';
type Account={origin:string;username:string;kind?:'password'|'email';createdAt:number;lastUsedAt:number|null};
/** Logins Toru reuses for demos: e-mail only (the user types the code) or a demo account with a password. Agents only learn origin and username. */
export function DemoAccounts() {
  const [accounts,setAccounts]=useState<Account[]|null>(null);
  const [open,setOpen]=useState(false);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState('');
  const [kind,setKind]=useState<'email'|'password'>('email');
  const [editing,setEditing]=useState<Account|null>(null);
  const startEdit=(account:Account)=>{setEditing(account);setKind(account.kind==='email'?'email':'password');setOpen(true);setError('');};
  const close=()=>{setOpen(false);setEditing(null);};
  const refresh=useCallback(async(signal?:AbortSignal)=>{
    try {
      const response=await fetch('/api/demo-accounts',{cache:'no-store',signal});
      if(!response.ok)throw new Error();
      const body=await response.json();
      if(!signal?.aborted){setAccounts(Array.isArray(body.accounts)?body.accounts:[]);setError('');}
    }catch{if(!signal?.aborted)setError('Could not load your saved logins. Try again.');}
  },[]);
  useEffect(()=>{const controller=new AbortController();void refresh(controller.signal);return()=>controller.abort();},[refresh]);
  async function save(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();if(busy)return;
    const form=event.currentTarget,data=new FormData(form);
    setBusy('save');setError('');
    try {
      const password=String(data.get('password')??'');
      // Editing a password login with the field left blank keeps the stored password.
      const keep=Boolean(editing&&editing.kind!=='email'&&kind==='password'&&!password);
      const payload=kind==='email'?{url:data.get('url'),username:data.get('username'),kind}:keep?{url:data.get('url'),username:data.get('username'),kind,keepPassword:true}:{url:data.get('url'),username:data.get('username'),password,kind,demoAccountConfirmed:data.get('confirm')==='on'};
      const response=await fetch('/api/demo-accounts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
      if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.error==='public_https_url_required'?'Use the product\u2019s https:// address.':body.error==='demo_account_limit'?'You can keep up to 20 saved logins.':'Could not save this account. Check the fields and try again.');}
      form.reset();close();await refresh();
    }catch(caught){setError(caught instanceof Error?caught.message:'Could not save this account.');}finally{setBusy('');}
  }
  async function remove(account:Account) {
    if(busy||!window.confirm(`Remove the saved login for ${account.origin}? Your agent will ask for an e-mail next time.`))return;
    setBusy(account.origin);setError('');
    try {
      const response=await fetch(`/api/demo-accounts?origin=${encodeURIComponent(account.origin)}`,{method:'DELETE'});
      if(!response.ok)throw new Error();
      await refresh();
    }catch{setError('Could not remove this account. Try again.');}finally{setBusy('');}
  }
  return <section className="panel demo-accounts" aria-label="Saved logins">
    <div className="panel-copy"><h2>Saved logins</h2><p>Toru reuses these whenever a demo starts on the product, so your agent never asks. E-mail logins pause for you to type the code on a secure Toru page.</p></div>
    {error && <p role="alert">{error}</p>}
    {accounts===null && !error && <p role="status">Checking your saved logins…</p>}
    {accounts && accounts.length===0 && !open && <p>No saved login yet.</p>}
    {accounts && accounts.length>0 && <ul className="item-list">
      {accounts.map(account=><li key={account.origin} className="item-row">
        <span className={`item-lead login-chip ${account.kind==='email'?'email':''}`} aria-hidden="true">{account.kind==='email'?'@':'••'}</span>
        <div className="item-main"><strong>{account.origin.replace('https://','')}</strong><span>{account.username} · {account.kind==='email'?'E-mail and code':'E-mail and password'}</span></div>
        <span className="item-meta">{account.lastUsedAt?`Used ${new Date(account.lastUsedAt).toLocaleDateString(undefined,{month:'short',day:'numeric'})}`:'Not used yet'}</span>
        <div className="item-actions"><button className="item-action" disabled={busy!==''} onClick={()=>startEdit(account)}>Edit</button><button className="item-action danger" disabled={busy!==''} onClick={()=>void remove(account)}>{busy===account.origin?'Removing…':'Remove'}</button></div>
      </li>)}
    </ul>}
    {!open && <div className="connection-actions"><button className="primary" disabled={busy!==''} onClick={()=>{setEditing(null);setKind('email');setOpen(true);}}>Save a login</button></div>}
    {open && <form key={editing?.origin??'new'} className="token-box demo-account-form" onSubmit={save}>
      {editing && <p className="form-title">Edit login for {editing.origin.replace('https://','')}</p>}
      <div className="ob-kinds" role="radiogroup" aria-label="Login type">
        <button type="button" role="radio" aria-checked={kind==='email'} className={kind==='email'?'selected':undefined} onClick={()=>setKind('email')}><strong>Email only</strong><span>Magic links or one-time codes. You type the code when it arrives.</span></button>
        <button type="button" role="radio" aria-checked={kind==='password'} className={kind==='password'?'selected':undefined} onClick={()=>setKind('password')}><strong>Email and password</strong><span>A demo account with a reusable password. Fully unattended.</span></button>
      </div>
      <label>Product address<input name="url" type="url" required placeholder="https://app.example.com" maxLength={2048} defaultValue={editing?.origin} readOnly={Boolean(editing)} /></label>
      <label>E-mail<input name="username" required autoComplete="off" maxLength={500} inputMode="email" defaultValue={editing?.username} /></label>
      {kind==='password' && <><label>Password<input name="password" type="password" required={!(editing&&editing.kind!=='email')} placeholder={editing&&editing.kind!=='email'?'Leave blank to keep the current password':undefined} autoComplete="new-password" maxLength={10000} /></label>
      <label className="demo-confirm"><input name="confirm" type="checkbox" required={!(editing&&editing.kind!=='email')} /><span>This is a demo account with no real customer data. I can remove it here at any time.</span></label></>}
      <p>{kind==='password'?'Stored encrypted on Toru\u2019s server and used only to sign in to this address. Never shown to agents or shown again.':'Toru stores only the address and e-mail.'}</p>
      <div className="connection-actions"><button className="primary" type="submit" disabled={busy!==''}>{busy==='save'?'Saving…':'Save login'}</button> <button className="quiet" type="button" onClick={close}>Cancel</button></div>
    </form>}
  </section>;
}
