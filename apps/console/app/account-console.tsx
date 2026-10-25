"use client";
import {McpConnections} from "./mcp-connections";
import {MacDevices} from "./mac-devices";
import {ChromeDevices} from "./chrome-devices";
import {DemoAccounts} from "./demo-accounts";
import {Brands} from "./brands";
import {CreditPacks} from "./credit-packs";
import {DemosHome,DemoDetail,RecordingDetail} from "./demos";
import {AgentInstall} from "./onboarding-flow";

import { Show, SignInButton, SignUpButton, useAuth, useUser } from "@clerk/nextjs";
import { ToruLoading } from "./public-landing";
import { ToruOrb } from "./toru-orb";
import { WorkspaceFrame, useWorkspaceRoute, type WorkspaceRoute } from "./workspace-frame";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AccountData } from "./account-data";
import { CreditHistory } from "./credit-history";
import { BillingControls } from "./billing-controls";
import { PlanCards } from "./pricing/pricing";

const recorderUrl = process.env.NEXT_PUBLIC_RECORDER_URL ?? "https://mcp.toru.tools";
type Recording = { id: string; status: string; createdAt: string; durationMs?: number; errorCode?: string; previewUrl?: string; videoUrl?: string; downloadUrl?: string; rawUrl?: string; planUrl?: string; eventsUrl?: string; gifUrl?: string; progress?: { currentFrame: number; totalFrames: number; percent: number } };

type QueuedJob={jobId:string;state:string;operation:string;queuedAt:string;waitExpiresAt:string;cancelRequested:boolean;errorCode?:string;result?:{id?:string;status?:string;errorCode?:string}};
type Usage = {admission?:{state:string;position?:number};history?:Array<{id:string;jobId:string|null;kind:string;amount:number;createdAt:string;source:string;cycle:string}>;historyHasMore?:boolean;historyNextCursor?:string|null;mode:string;available?:number;used?:number;reserved?:number;renewsAt?:string;policy?:{version:string;videos:number;captureMs:number;rerenders:number;videoRetentionMs:number}};

export default function HomePage() {
  const { isLoaded, userId } = useAuth();
  if (!isLoaded) return <ToruLoading />;
  // Remount all account state before rendering a different identity. Effect-only
  // resets can otherwise show the previous account's token or media for one frame.
  return <AccountConsole key={userId ?? 'signed-out'} />;
}

function AccountConsole() {
  const { isSignedIn, userId } = useAuth();
  const currentUser=useRef(userId);currentUser.current=userId;
  const [deletingFor, setDeletingFor] = useState<string | null>(null);
  const deletionStarted = Boolean(userId && deletingFor === userId);
  const requestedRoute = useWorkspaceRoute();
  const route: WorkspaceRoute = deletionStarted ? { view: "brand" } : requestedRoute;
  const view = route.view;
  const { user, isLoaded: userLoaded } = useUser();
  const [expiresIn, setExpiresIn] = useState("1d");
  const [token, setToken] = useState("");
  const tokenRef=useRef(token);tokenRef.current=token;
  const [status, setStatus] = useState("");
  const [connectionMessage,setConnectionMessage]=useState('');
  const [checkingCredential,setCheckingCredential]=useState(false);
  const [copied, setCopied] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  const credentialBusy=useRef(false);
  const [credentialPending,setCredentialPending]=useState(false);
  const [queue,setQueue]=useState<QueuedJob[]>([]);
  const [queueError,setQueueError]=useState(false);
  const [canceling,setCanceling]=useState<string|null>(null);
  const [queueMessage,setQueueMessage]=useState('');
  const [usage,setUsage]=useState<Usage|null>(null);
  const [usageError,setUsageError]=useState(false);
  const [libraryState,setLibraryState]=useState<'loading'|'ready'|'error'>('loading');
  const [recordings, setRecordings] = useState<Recording[]>([]);
  useEffect(() => {
    setToken('');setStatus('');setConnectionMessage('');setCopied(false);setUsage(null);setRecordings([]);setQueue([]);setLibraryState('loading');
    if (deletionStarted) return;
    if (!isSignedIn) {setUsage(null);setRecordings([]);setUsageError(false);setQueue([]);setQueueError(false);setQueueMessage('');return;}
    let stopped = false,inFlight=false;
    const controller=new AbortController();
    const refresh = async () => {
      if(inFlight || document.hidden) return;inFlight=true;
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(12000)]);
      const [response,usageResponse,queueResponse]=await Promise.all([
        fetch('/api/recordings',{cache:'no-store',signal}).catch(()=>undefined),
        fetch('/api/usage',{cache:'no-store',signal}).catch(()=>undefined),
        fetch('/api/queue',{cache:'no-store',signal}).catch(()=>undefined),
      ]);
      const usageBody=usageResponse?.ok?await usageResponse.json().catch(()=>null):null;
      const library=response?.ok?await response.json().catch(()=>null):null;
      const queueBody=queueResponse?.ok?await queueResponse.json().catch(()=>null):null;
      inFlight=false;
      if(!stopped) {setQueue(queueBody?.jobs ?? []);setQueueError(!queueBody);setUsage(usageBody);setUsageError(!usageBody);if(Array.isArray(library?.recordings)){setLibraryState('ready');setRecordings(library.recordings);}else{setLibraryState(previous=>previous==='ready'?'ready':'error');}}
    };
    const onVisibility=()=>{if(!document.hidden)void refresh();};
    document.addEventListener('visibilitychange',onVisibility);
    void refresh(); const timer = setInterval(() => void refresh(), 3_000);
    return () => { stopped = true; controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange',onVisibility); };
  }, [isSignedIn,userId,deletionStarted]);
  // Every account goes through setup once; completion lives on the Clerk account, so it follows the user across devices.
  useEffect(()=>{
    if(isSignedIn&&userLoaded&&user&&!deletionStarted&&!user.unsafeMetadata?.onboardedAt)window.location.assign('/onboarding');
  },[isSignedIn,userLoaded,user,deletionStarted]);
  const agentPrompt = `You are connected to Toru, recording infrastructure for agents.

Use it whenever I ask you to record a product flow or demo. You plan the flow and drive it with Toru's tools; Toru records, renders and checks the MP4.

Where Toru records (only these two)
- Web apps: in my own Chrome with Toru for Chrome, where I'm already signed in. Call extension_devices and use the ready Chrome's connectionId as localConnectionId in recording_run. If none is paired, call extension_pair and give me installUrl and connectUrl.
- Mac apps: on my Mac with Toru for Mac. Call desktop_devices, pick the window with desktop_sources and desktop_select_source, then desktop_recording_run. If no Mac is paired, give me the install command it returns, then desktop_recording_pair.
- Never launch or suggest a separate browser for Toru, and never ask me for passwords or codes in chat. If the product shows a sign-in screen, ask me to sign in in my Chrome or app, then record.

Preparation with my codebase (when available)
- First check whether your workspace or already-authorized repository tools contain this product. Use your own tools to read it; never send source, repository tokens or secrets to Toru.
- Read only the code needed to write the plan: each screen, the exact button and field labels, the values to use and what the last screen shows. Inspect and reuse existing items first; create only when absent or explicitly requested.
- Source access is optional: without it, plan from the live UI. Do not read .env files or unrelated private data.
- Choose sensible example content yourself and give me only a concise summary of the plan.

Recording
1. Read recording_guide, state the intended flow in one sentence, then call recording_run (web) or desktop_recording_run (Mac) with the plan. Use a fresh UUID requestId and reuse it after a transport timeout.
2. The run records and hands you the window (agent_driving): drive the flow with the browser tools on its sessionId, mark the result with mark_demo_moment, then call recording_run_finish. Then poll recording_run_status. On done, give me the MP4 and GIF links from recording_links. needs_review means the video failed the check and no credit was used: offer to record again with a corrected plan.
3. Use the step-by-step tools (session_open with localConnectionId, browser_*, recording_start/stop/render) only when the flow needs your judgement at each screen.
4. Describe what the video actually shows. Export useful partial attempts too.

Recovery rules
- Do not repeat an identical failed attempt: change the plan, inspect the current state and preserve useful work.
- Ask me only for information that blocks progress; otherwise choose sensible defaults and keep going.
- If the product rejects an action or Chrome or the Mac is offline, tell me the concrete cause and the next action I can take.`;

  async function createInvite() {
    if(credentialBusy.current)return;
    credentialBusy.current=true;setCredentialPending(true);
    const requestedFor=userId;
    setStatus("Creating your token…"); setToken(""); setConnectionMessage(''); setCopied(false);
    try {
      const response = await fetch("/api/invites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expiresIn }) });
      const body = await response.json();
      if(currentUser.current!==requestedFor)return;
      if (!response.ok) { setStatus(body.error==='active_invite_limit' ? 'You have 5 active credentials. Revoke old credentials before creating another.' : body.error==='invite_issuance_limit' ? 'Credential creation limit reached. Try again after older issuances leave the 24-hour window.' : ['account_not_admitted','beta_admission_required'].includes(body.error) ? 'This account is not currently admitted to the beta.' : 'Creation could not be confirmed. A credential may already exist. Revoke manual tokens before retrying if you did not receive a token.'); return; }
      setToken(body.token); setStatus(`Ready · expires ${new Date(body.expiresAt).toLocaleString()}`);
    } catch { setStatus("Creation could not be confirmed. A credential may already exist. Revoke manual tokens before retrying."); }
    finally {credentialBusy.current=false;setCredentialPending(false);}
  }

  async function revokeCredentials() {
    if(credentialBusy.current)return;
    credentialBusy.current=true;setCredentialPending(true);setToken('');setConnectionMessage('');setCopied(false);
    setStatus('Revoking your manual tokens…');
    try {
      const response=await fetch('/api/invites',{method:'DELETE'});
      if(!response.ok)throw new Error('Revocation could not be confirmed. Existing credentials may still work. Retry revocation before reconnecting.');
      setToken('');setCopied(false);setStatus('Manual tokens revoked. Generate a new token to reconnect a manual client. OAuth connections are unchanged.');
    }catch{setStatus('Revocation could not be confirmed. Existing credentials may still work. Retry revocation before reconnecting.');}
    finally {credentialBusy.current=false;setCredentialPending(false);}
  }

  async function verifyCredential(){
    const requestedFor=userId,requestedToken=token;
    if(!requestedToken||checkingCredential)return;
    setCheckingCredential(true);setConnectionMessage('Checking Toru authentication and tools…');
    try{
      const response=await fetch('/api/connection-check',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({token:requestedToken}),cache:'no-store',signal:AbortSignal.timeout(12_000)});
      const body=await response.json().catch(()=>null);
      if(currentUser.current!==requestedFor||tokenRef.current!==requestedToken)return;
      setConnectionMessage(response.ok&&body?.connected===true
        ?'Toru accepted this credential and exposes the recording tools. Add it to your MCP client; this check does not test that client’s setup.'
        :body?.error==='credential_rejected'?'Toru rejected this credential. Generate a new invite.'
        :body?.error==='recorder_tools_unavailable'?'Toru responded, but the recording tools are unavailable. Retry shortly.'
        :'Could not verify Toru now. Your credential may still work; retry.');
    }catch{
      if(currentUser.current===requestedFor&&tokenRef.current===requestedToken)
        setConnectionMessage('Could not verify Toru now. Your credential may still work; retry.');
    }finally{setCheckingCredential(false);}
  }

  async function cancelJob(jobId:string) {
    setCanceling(jobId);setQueueMessage('');
    try {
      const response=await fetch(`/api/queue?jobId=${encodeURIComponent(jobId)}`,{method:'DELETE'});
      if(!response.ok) throw new Error('Could not cancel this job. Refresh its status and try again.');
      const updated=await response.json() as QueuedJob;
      setQueue(current=>current.map(job=>job.jobId===jobId?updated:job));
      setQueueMessage(updated.state==='canceled'?'Job canceled.':'Cancellation requested. Waiting for the browser or render to stop safely.');
    } catch(error) {setQueueMessage(error instanceof Error?error.message:'Could not cancel this job.');}
    finally {setCanceling(null);}
  }

  async function copySetup() {
    await navigator.clipboard.writeText(agentPrompt);
    setCopied(true); setTimeout(() => setCopied(false), 1600);
  }

  const titles:Record<string,ReactNode>={demos:'Demos',demo:'Demo',recording:'Recording',brand:'Settings',accounts:'Saved logins',agents:'Connections',plan:'Billing'};
  const activeJobs=queue.filter(job=>['queued','running'].includes(job.state)).length;
  return <>
    <Show when="signed-out"><div className="public-site lw-site st-site"><div className="lw-container"><header className="st-nav"><a className="st-brand" href="https://toru.tools" aria-label="Toru home"><ToruOrb size={22} still />toru</a><div className="st-nav-end"><a className="st-signin" href="https://toru.tools/docs">Help</a></div></header></div><main className="app-signin"><h1>Sign in to Toru</h1><p>Your demos, connections, billing and settings.</p><SignInButton mode="modal"><button className="primary">Sign in</button></SignInButton><SignUpButton mode="modal"><button className="quiet">Create an account</button></SignUpButton></main></div></Show>
    <Show when="signed-in">
      <WorkspaceFrame route={route} locked={deletionStarted} available={usage?.available} title={view==='demo'||view==='recording'?null:titles[view]}>
        {!deletionStarted && <>
          {view === "demos" && <DemosHome usage={usage} recordings={recordings} recordingsState={libraryState} activeJobs={activeJobs} />}
          {view === "demo" && route.param && <DemoDetail key={route.param} id={route.param} usage={usage} />}
          {view === "recording" && route.param && <RecordingDetail key={route.param} recording={recordings.find(item=>item.id===route.param)} loading={libraryState==='loading'} />}
          {view === "brand" && !deletionStarted && <Brands />}
          {view === "accounts" && <DemoAccounts />}
          {view === "agents" && <McpConnections newRecording={false}>{connected=><>
            <div className="cx-devices"><ChromeDevices /><MacDevices /></div>
            <details className="cx-card cx-more" open={!connected}><summary><b>{connected?'Connect another agent':'Connect your agent'}</b><span>Claude Code, Claude, Cursor, Codex or any MCP client. Toru adds itself as tools.</span></summary><AgentInstall /><p className="cx-quiet"><a className="cx-text" href="/onboarding">Run the setup again</a></p></details>
            <details className="cx-card cx-more"><summary><b>Advanced</b><span>The MCP address, manual tokens and the instructions for your agent.</span></summary><div className="connector">
              <div className="oauth-connection"><label htmlFor="mcp-url">MCP server URL</label><div className="mcp-url-row"><input id="mcp-url" readOnly value={`${recorderUrl}/mcp`} onFocus={event=>event.currentTarget.select()} /><button className="copy" onClick={async()=>{try{await navigator.clipboard.writeText(`${recorderUrl}/mcp`);setUrlCopied(true);setTimeout(()=>setUrlCopied(false),1600);}catch{setStatus('Select the URL above and copy it.');}}}>{urlCopied?'Copied':'Copy URL'}</button></div><p>Choose a remote HTTP connector in your MCP client and paste this URL. Toru opens a secure login and consent screen. Compatible clients renew access automatically.</p><p className="connection-hint">Compatible clients keep the connection active. Manage access here or remove Toru in your client.</p><button className="quiet" onClick={copySetup}>{copied?'Copied':'Copy agent instructions'}</button></div>
              <details className="manual-connection"><summary>Manual token setup</summary><p>For clients that support bearer tokens instead of OAuth.</p><label>Token lifetime<select value={expiresIn} onChange={(event) => setExpiresIn(event.target.value)}><option value="1h">1 hour</option><option value="1d">1 day</option><option value="7d">7 days</option></select></label><button className="primary wide" disabled={credentialPending} onClick={createInvite}>Generate token <b>↗</b></button><button className="quiet" disabled={credentialPending} onClick={()=>void revokeCredentials()}>Revoke manual tokens</button><details className="connection-notes"><summary>Connection limits & compatibility</summary><p>Up to 5 active credentials and 20 new credentials per 24 hours. Revoking disables these manual tokens and their links. OAuth connections are managed by your client.</p><p>Manual setup requires an HTTP MCP client with bearer header support.</p></details><p className="status" role="status">{status}</p>{token && <div className="token-box"><label>HTTP MCP URL<code>{recorderUrl}/mcp</code></label><label>Bearer token<code>{token}</code></label><p>Put the URL and token only in your MCP client's connection settings. The copied agent instructions are the same for every account and include neither value.</p><button className="quiet" disabled={checkingCredential||credentialPending} onClick={()=>void verifyCredential()}>{checkingCredential?'Checking…':'Verify recorder credential'}</button><p role="status">{connectionMessage}</p><label>Agent instruction prompt<pre>{agentPrompt}</pre></label><button className="copy" onClick={copySetup}>{copied ? "Copied" : "Copy agent instructions"}</button></div>}</details></div></details>
          </>}</McpConnections>}
        </>}
        {view === "plan" && !deletionStarted && <div className="bl">
          <section className="cx-card bl-usage" aria-label="Your credits">
            {usage?.admission && usage.admission.state!=='admitted' ? <p role="status">{usage.admission.state==='waiting'?`The limited beta is currently full. You are ${usage.admission.position ? `#${usage.admission.position} on the waiting list` : 'on the waiting list'}. We check for a place while this page is open. No credits have been reserved.`:'Your account is not currently admitted. Contact support before starting another recording.'}</p>
            : usage?.mode==='hosted' && usage.policy ? <>
              <div className="bl-balance"><b className="st-mono">{usage.available}</b><span>{usage.available === 1 ? "credit" : "credits"} available</span></div>
              <div className="bl-meter" aria-hidden="true"><i style={{width:`${Math.min(100,Math.round(((usage.used??0)+(usage.reserved??0))/Math.max(1,(usage.used??0)+(usage.reserved??0)+(usage.available??0))*100))}%`}} /></div>
              <dl className="bl-facts">
                <div><dt>Plan</dt><dd>{usage.policy.version==='studio-v1'?'Studio':usage.policy.version==='creator-v1'?'Creator':'Free'}</dd></div>
                <div><dt>Used</dt><dd className="st-mono">{usage.used}{usage.reserved ? ` · ${usage.reserved} reserved` : ''}</dd></div>
                <div><dt>{usage.policy.version!=='free-v1'?'Paid period ends':'Renews'}</dt><dd>{usage.renewsAt ? new Date(usage.renewsAt).toLocaleDateString(undefined,{timeZone:'UTC',month:'short',day:'numeric'}) : 'Next month'}</dd></div>
                <div><dt>Per capture</dt><dd>Up to {usage.policy.captureMs / 60000} min</dd></div>
                <div><dt>Videos kept</dt><dd>{usage.policy.videoRetentionMs / 86400000} days</dd></div>
              </dl>
              <p className="cx-quiet">1 credit = 1 delivered video that passed the delivery check. Held videos, failed runs, re-renders and downloads never use a credit. Unused credits do not roll over{usage.policy.version!=='free-v1'?'; free credits used before upgrading count toward the first paid cycle':''}.</p>
            </> : <p role={usageError?'status':undefined}>{usageError ? 'Usage is temporarily unavailable. Refresh shortly; no balance has been assumed.' : usage?.mode==='self-hosted' ? 'This recorder uses operational limits without a monthly credit balance.' : 'Loading your credits…'}</p>}
          </section>
          {usage?.mode==='hosted' && <section className="bl-plans" aria-label="Plans"><PlanCards key={userId ?? 'signed-out'} signedIn loaded /></section>}
          <BillingControls usage={usage} />
          <CreditPacks usage={usage} />
          {usage?.history && <section className="cx-card bl-history"><CreditHistory key={userId} latest={{history:usage.history,historyNextCursor:usage.historyNextCursor}} /></section>}
        </div>}
        <div hidden={view !== "brand" && !deletionStarted} className="sx-account">
          <section className="cx-card"><div className="sx-about"><h2>Account and data</h2><p>Export or delete what Toru keeps about you.</p></div>
            <details className="account-disclosure" open={deletionStarted || undefined}><summary>Privacy and account deletion</summary>{isSignedIn && userId && <AccountData key={userId} onStart={() => {setDeletingFor(userId);setToken('');setRecordings([]);setQueue([]);}} onBlocked={() => setDeletingFor(null)} />}</details>
          </section>
        </div>
      </WorkspaceFrame>
    </Show>
  </>;
}

