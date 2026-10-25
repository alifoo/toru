"use client";
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { backgroundCss, backgrounds } from './brand-look';
type Brand={accent?:string;background?:string;padding?:number;radius?:number;logo?:string;logoPosition?:'bottom-right'|'bottom-left'|'top-right'|'top-left';cards?:boolean;gif?:boolean;width?:1280|1920|2560;
 /** The camera's click zooms, on unless turned off, and the deepest it may go. */
 zoom?:{enabled:boolean;scale?:number};
 /** The rendered pointer's travel, smoothed unless turned off. */
 cursor?:{smooth:boolean}};
type Record_={origin:string;brand:Brand;updatedAt:number};
type Suggestion={origin:string;name?:string;accent?:string;logo?:string;found:{accent?:string;logo?:string}};
const empty:Brand={accent:'#405f6d',padding:30,radius:12,logoPosition:'bottom-right',cards:false,gif:false,width:1920};
const positions:Array<[NonNullable<Brand['logoPosition']>,string]>=[['top-left','Top left'],['top-right','Top right'],['bottom-left','Bottom left'],['bottom-right','Bottom right']];
const widths=[1280,1920,2560] as const;
const nameOf=(origin:string)=>origin==='*'?'All products':origin.replace('https://','');
const foundWords:Record<string,string>={'theme-color':'its theme colour',manifest:'its app manifest','mask-icon':'its pinned-tab icon','apple-touch-icon':'its app icon',icon:'its favicon'};

/** Settings for each product: paste its address, Toru reads the colour and icon from the site, the user checks and saves.
 * Every demo recorded on that domain is rendered with it. */
export function Brands() {
  const [brands,setBrands]=useState<Record_[]|null>(null);
  const [editing,setEditing]=useState<{origin:string;brand:Brand;saved:boolean}|null>(null);
  const [error,setError]=useState(''),[note,setNote]=useState('');
  const [busy,setBusy]=useState('');
  const refresh=useCallback(async(signal?:AbortSignal)=>{
    try {
      const response=await fetch('/api/brands',{cache:'no-store',signal});
      if(!response.ok)throw new Error();
      const body=await response.json();
      if(signal?.aborted)return;
      const list:Record_[]=Array.isArray(body.brands)?body.brands:[];
      setBrands(list);setError('');
      setEditing(current=>current??(list[0]?{origin:list[0].origin,brand:{...list[0].brand},saved:true}:{origin:'',brand:{...empty},saved:false}));
    }catch{if(!signal?.aborted)setError('Could not load your settings. Try again.');}
  },[]);
  useEffect(()=>{const controller=new AbortController();void refresh(controller.signal);return()=>controller.abort();},[refresh]);
  const set=(patch:Partial<Brand>)=>setEditing(current=>current&&{...current,brand:{...current.brand,...patch}});

  /** Reads the product's site and fills what it declares; anything the user already changed by hand is overwritten only where the site has a value. */
  async function fill() {
    if(!editing||busy||!editing.origin.trim()||editing.origin.trim()==='*')return;
    setBusy('fill');setError('');setNote('');
    try {
      const response=await fetch('/api/brands/suggest',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:editing.origin.trim()})});
      const body=await response.json().catch(()=>({})) as {suggestion?:Suggestion;error?:string};
      if(!response.ok||!body.suggestion)throw new Error(body.error==='public_https_url_required'?'Use the public https:// address of your product.':body.error==='site_not_html'?'That address is not a web page.':'Could not read that site. Fill the settings by hand, or try again.');
      const suggestion=body.suggestion;
      setEditing(current=>current&&{...current,origin:suggestion.origin,brand:{...current.brand,...(suggestion.accent?{accent:suggestion.accent,background:undefined}:{}),...(suggestion.logo?{logo:suggestion.logo,cards:true}:{})}});
      const parts=[suggestion.found.accent&&`the colour from ${foundWords[suggestion.found.accent]}`,suggestion.found.logo&&`the logo from ${foundWords[suggestion.found.logo]}`].filter(Boolean);
      setNote(parts.length?`Filled ${parts.join(' and ')}${suggestion.name?` of ${suggestion.name}`:''}. Check the preview, then save.`:`${suggestion.name??'The site'} declares no colour or PNG icon. Pick them below.`);
    }catch(caught){setError(caught instanceof Error?caught.message:'Could not read that site.');}finally{setBusy('');}
  }
  async function pickLogo(file:File|undefined) {
    if(!file){set({logo:undefined,cards:false});return;}
    if(file.type!=='image/png'||file.size>150_000){setError('Use a PNG logo under 150 KB (transparent background works best).');return;}
    const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(const b of bytes)binary+=String.fromCharCode(b);
    set({logo:'data:image/png;base64,'+btoa(binary)});setError('');
  }
  async function save(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();if(!editing||busy)return;
    setBusy('save');setError('');setNote('');
    try {
      const origin=editing.origin.trim()||'*';
      const brand=Object.fromEntries(Object.entries(editing.brand).filter(([,v])=>v!==undefined&&v!==''));
      const response=await fetch('/api/brands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({origin,brand})});
      if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.error==='public_https_url_required'?'Use the product’s https:// address, or * for every product.':body.error==='brand_limit'?'You can keep up to 30 products.':'Could not save. Check the fields and try again.');}
      // The recorder keys settings by origin (scheme and host), so the path someone pasted is dropped.
      const key=origin==='*'?'*':(()=>{try{return new URL(origin).origin;}catch{return origin;}})();
      setEditing({origin:key,brand:editing.brand,saved:true});setNote('Saved. New demos of this product use it.');await refresh();
    }catch(caught){setError(caught instanceof Error?caught.message:'Could not save.');}finally{setBusy('');}
  }
  async function remove(origin:string) {
    if(busy||!window.confirm(`Remove the settings for ${nameOf(origin)}? New demos go back to Toru’s default look.`))return;
    setBusy('remove');setError('');setNote('');
    try {
      const response=await fetch(`/api/brands?origin=${encodeURIComponent(origin)}`,{method:'DELETE'});
      if(!response.ok)throw new Error();
      setEditing(null);await refresh();
    }catch{setError('Could not remove these settings. Try again.');}finally{setBusy('');}
  }
  const open=(record:Record_)=>{setEditing({origin:record.origin,brand:{...record.brand},saved:true});setError('');setNote('');};
  const b=editing?.brand??empty;
  const accent=b.accent??'#405f6d',padding=b.padding??30,radius=b.radius??12,scale=1-(padding/100)*0.4;
  const custom=b.background?.startsWith('#')?b.background:undefined;
  const zoomOn=b.zoom?.enabled!==false,zoomScale=b.zoom?.scale??1.6,smooth=b.cursor?.smooth!==false;
  if(brands===null&&!error)return <p className="sx-loading" role="status">Loading your settings…</p>;
  return <div className="sx">
    <nav className="sx-products" aria-label="Products">
      {brands?.map(record=><button key={record.origin} type="button" aria-current={editing?.saved&&editing.origin===record.origin?'true':undefined} onClick={()=>open(record)}>
        <span className="sx-chip" style={{background:backgroundCss(record.brand.background,record.brand.accent??'#405f6d')}} aria-hidden="true">{record.brand.logo&&<img src={record.brand.logo} alt="" />}</span>{nameOf(record.origin)}
      </button>)}
      <button type="button" className="sx-add" aria-current={editing&&!editing.saved?'true':undefined} disabled={busy!==''} onClick={()=>{setEditing({origin:'',brand:{...empty},saved:false});setError('');setNote('');}}>+ Add a product</button>
    </nav>

    {editing&&<div className="sx-grid">
      <form className="sx-form" onSubmit={save} aria-label="Product settings">
        <section className="sx-section">
          <div className="sx-about"><h2>Product</h2><p>Paste your product’s address. Toru reads its colour and icon from the site and fills the rest; check the preview and save. Use <code>*</code> for every product.</p></div>
          <div className="sx-fields">
            <div className="sx-url">
              <input aria-label="Product address" value={editing.origin} onChange={e=>setEditing({...editing,origin:e.target.value,saved:false})} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();void fill();}}} required placeholder="https://app.your-product.com" maxLength={2048} autoFocus={!editing.saved} />
              <button type="button" className="sx-button" disabled={busy!==''||!editing.origin.trim()||editing.origin.trim()==='*'} onClick={()=>void fill()}>{busy==='fill'?'Reading…':'Fill from site'}</button>
            </div>
            {note&&<p className="sx-note" role="status">{note}</p>}
            {error&&<p className="sx-error" role="alert">{error}</p>}
          </div>
        </section>

        <section className="sx-section">
          <div className="sx-about"><h2>Look</h2><p>What the recording sits on.</p></div>
          <div className="sx-fields">
            <label className="sx-row">Accent colour<input type="color" value={accent} onChange={e=>set({accent:e.target.value})}/></label>
            <div className="sx-swatches" role="group" aria-label="Background">
              <button type="button" aria-pressed={b.background===undefined} title="From the accent colour" aria-label="From the accent colour" style={{background:backgroundCss(undefined,accent)}} onClick={()=>set({background:undefined})}/>
              {backgrounds.map(entry=><button key={entry.id} type="button" aria-pressed={b.background===entry.id} title={entry.label} aria-label={entry.label} style={{background:`center / cover url(/backgrounds/${entry.id}.jpg)`}} onClick={()=>set({background:entry.id})}/>)}
              <label className={`sx-custom${custom?' on':''}`} title="Custom colour" style={custom?{background:custom}:undefined}><span aria-hidden="true">+</span><input type="color" aria-label="Custom background colour" value={custom??'#111827'} onChange={e=>set({background:e.target.value})}/></label>
            </div>
            <label className="sx-range">Padding<output>{padding}</output><input type="range" min={0} max={100} value={padding} onChange={e=>set({padding:Number(e.target.value)})}/></label>
            <label className="sx-range">Corner radius<output>{radius}</output><input type="range" min={0} max={64} value={radius} onChange={e=>set({radius:Number(e.target.value)})}/></label>
          </div>
        </section>

        <section className="sx-section">
          <div className="sx-about"><h2>Logo</h2><p>A small PNG in a corner, and optional title cards before and after the flow.</p></div>
          <div className="sx-fields">
            <div className="sx-logo">
              <label className="sx-file">{b.logo?<img src={b.logo} alt="Logo" />:<span>PNG, up to 150 KB</span>}<input type="file" accept="image/png" onChange={e=>void pickLogo(e.target.files?.[0])}/></label>
              {b.logo&&<button type="button" className="sx-link" onClick={()=>set({logo:undefined,cards:false})}>Remove logo</button>}
            </div>
            <div className="sx-seg sx-seg-4" role="group" aria-label="Logo position">{positions.map(([value,label])=><button key={value} type="button" aria-pressed={(b.logoPosition??'bottom-right')===value} aria-label={label} title={label} disabled={!b.logo} onClick={()=>set({logoPosition:value})}><i className={`bx-pos bx-pos-${value}`}/></button>)}</div>
            <Toggle label="Intro and outro cards" on={Boolean(b.cards)} disabled={!b.logo} set={value=>set({cards:value})}/>
          </div>
        </section>

        <section className="sx-section">
          <div className="sx-about"><h2>Camera and cursor</h2><p>How the video follows the flow.</p></div>
          <div className="sx-fields">
            <Toggle label="Zoom on every click" on={zoomOn} set={value=>set({zoom:{...(b.zoom??{}),enabled:value}})}/>
            <label className={`sx-range${zoomOn?'':' sx-off'}`}>Deepest zoom<output>{zoomScale.toFixed(1)}×</output><input type="range" min={1.2} max={2.5} step={0.1} value={zoomScale} disabled={!zoomOn} onChange={e=>set({zoom:{enabled:true,scale:Number(e.target.value)}})}/></label>
            <Toggle label="Smooth the pointer’s travel" on={smooth} set={value=>set({cursor:{smooth:value}})}/>
            <span className="sx-hint">It always rests on a target before it presses.</span>
          </div>
        </section>

        <section className="sx-section">
          <div className="sx-about"><h2>Output</h2><p>The files every demo comes back as.</p></div>
          <div className="sx-fields">
            <div className="sx-seg st-mono" role="group" aria-label="Output width">{widths.map(value=><button key={value} type="button" aria-pressed={(b.width??1920)===value} onClick={()=>set({width:value})}>{value}</button>)}</div>
            <Toggle label="Also produce a GIF" on={Boolean(b.gif)} set={value=>set({gif:value})}/>
          </div>
        </section>

        <div className="sx-actions">
          <button className="primary" type="submit" disabled={busy!==''}>{busy==='save'?'Saving…':'Save settings'}</button>
          {editing.saved&&<button type="button" className="sx-remove" disabled={busy!==''} onClick={()=>void remove(editing.origin)}>{busy==='remove'?'Removing…':'Remove this product'}</button>}
        </div>
      </form>

      <aside className="sx-preview" aria-label="Preview">
        <p className="sx-preview-label"><span>{editing.origin.trim()?nameOf(editing.origin.trim().replace(/\/+$/,'')):'New product'}</span><span>{b.width??1920} × {(b.width??1920)*9/16} · {b.gif?'MP4 + GIF':'MP4'}</span></p>
        <div className="bx-frame" style={{background:backgroundCss(b.background,accent)}}>
          <div className="bx-window" style={{width:`${scale*100}%`,height:`${scale*100}%`,borderRadius:padding===0?0:radius*0.6}}>
            <span className="bx-bar"><i/><i/><i/></span>
            <span className="bx-lines"><b/><b/><b/><b/></span>
          </div>
          {zoomOn&&<span className="bx-camera" style={{width:`${scale*100/zoomScale}%`,height:`${scale*100/zoomScale}%`}} aria-hidden="true"><em>Camera · {zoomScale.toFixed(1)}×</em></span>}
          {b.logo&&<img className={`bx-logo bx-logo-${b.logoPosition??'bottom-right'}`} src={b.logo} alt="" />}
        </div>
        {b.cards&&b.logo&&<div className="bx-cards">
          <span style={{background:backgroundCss(b.background,accent)}}><img src={b.logo} alt="" /><small>Intro</small></span>
          <span style={{background:backgroundCss(b.background,accent)}}><img src={b.logo} alt="" /><small>Outro</small></span>
        </div>}
      </aside>
    </div>}
  </div>;
}

function Toggle({label,on,set,disabled=false}:{label:string;on:boolean;set:(value:boolean)=>void;disabled?:boolean}){
 return <label className={`st-toggle${disabled?' st-toggle-off':''}`}><span>{label}</span><input type="checkbox" checked={on} disabled={disabled} onChange={event=>set(event.target.checked)}/><i aria-hidden="true"/></label>;
}
