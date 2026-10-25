import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, mkdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer, type RecorderApi } from "./server.js";
import { revokeInvites, runInviteCli } from "./invites.js";

const directories:string[]=[];
const servers: ReturnType<typeof createMcpServer>[] = [];
const sessionId = "11111111-1111-4111-8111-111111111111";

async function fixture(token = "invite-test", owner = randomUUID(), expiresAt = Date.now() + 60_000): Promise<{ dataDir: string; token: string; owner: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-recorder-mcp-"));
  directories.push(dataDir);
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await writeFile(join(dataDir, "invites.json"), JSON.stringify({ invites: [{ tokenHash, owner, expiresAt }] }));
  return { dataDir, token, owner };
}

function recorder(callResult: CallToolResult = { content: [{ type: "text", text: "ok" }], structuredContent: { id: sessionId, status: "ready" } }): RecorderApi & { calls: Array<{ owner: string; name: string; args: unknown }> } {
  const calls: Array<{ owner: string; name: string; args: unknown }> = [];
  return {
    calls,
    call: async (owner, name, args) => { calls.push({ owner, name, args }); return callResult; },
    artifact: async () => ({ path: "/does/not/exist", contentType: "video/mp4" }),
    importSession: async () => ({ id: sessionId }),
  };
}

async function start(options: Parameters<typeof createMcpServer>[0]): Promise<string> {
  const server = createMcpServer(options); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function localLink(serverUrl: string, link: string): string {
  const target = new URL(link); target.port = new URL(serverUrl).port; return target.toString();
}

async function post(url: string, body: unknown, token?: string, origin?: string): Promise<Response> {
  return fetch(`${url}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})));
});

describe("hosted MCP transport", () => {
  it('mounts an optional host-owned route without changing the engine routes',async()=>{
    const f=await fixture();
    const url=await start({recorder:recorder(),dataDir:f.dataDir,publicUrl:'http://127.0.0.1',
      httpExtension:(request,response,target)=>{
        if(target.pathname!=='/external-test')return false;
        response.writeHead(request.method==='POST'?204:405).end();
        return true;
      }});
    expect((await fetch(`${url}/external-test`,{method:'POST'})).status).toBe(204);
    expect((await fetch(`${url}/external-test`)).status).toBe(405);
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
  });
  it('requires admin auth and exact owner confirmation for account erasure and distinguishes pending from completed',async()=>{
    const f=await fixture(),api=recorder();let calls=0,pending=false,unsafe=false,billingReview=false;
    api.deleteAccountData=async owner=>{calls++;expect(owner).toBe(f.owner);if(unsafe)throw new Error('sensitive driver detail');if(pending)throw new Error('account_deletion_pending');if(billingReview)throw new Error('account_deletion_review_required');return {state:'data_removed',backupsErased:false};};
    const url=await start({recorder:api,dataDir:f.dataDir,publicUrl:'http://127.0.0.1',adminKey:'admin-secret'});
    const erase=(body:unknown,key='admin-secret')=>fetch(`${url}/admin/account-data`,{method:'DELETE',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify(body)});
    expect((await erase({owner:f.owner,confirmOwner:f.owner},'wrong')).status).toBe(404);
    expect((await erase({owner:f.owner,confirmOwner:randomUUID()})).status).toBe(400);expect(calls).toBe(0);
    const completed=await erase({owner:f.owner,confirmOwner:f.owner});expect(completed.status).toBe(200);
    expect(completed.headers.get('cache-control')).toBe('private, no-store');expect(await completed.json()).toMatchObject({state:'data_removed'});
    pending=true;const waiting=await erase({owner:f.owner,confirmOwner:f.owner});expect(waiting.status).toBe(202);expect(await waiting.json()).toMatchObject({state:'deletion_pending'});
    unsafe=true;const failed=await erase({owner:f.owner,confirmOwner:f.owner});expect(failed.status).toBe(503);expect(await failed.text()).not.toContain('sensitive driver detail');
    unsafe=false;pending=false;billingReview=true;
    const blocked=await erase({owner:f.owner,confirmOwner:f.owner});expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({error:'account_deletion_review_required'});
  });
  it('keeps bandwidth reserved after a client disconnects and remains responsive',async()=>{
    const f=await fixture(),api=recorder(),path=join(f.dataDir,'video.mp4'),size=8*1024*1024;
    let downloads=0;api.artifactDownloaded=()=>{downloads++;};
    await writeFile(path,Buffer.alloc(size,1));
    api.recordings=async()=>[{id:sessionId,status:'completed'}];
    api.artifact=async()=>({path,contentType:'video/mp4'});
    const url=await start({recorder:api,dataDir:f.dataDir,publicUrl:'http://127.0.0.1',adminKey:'admin-secret',bandwidthLimitBytes:size});
    const gallery=await (await fetch(`${url}/admin/recordings?owner=${f.owner}`,{headers:{authorization:'Bearer admin-secret'}})).json() as {recordings:Array<{downloadUrl:string}>};
    const link=localLink(url,gallery.recordings[0]!.downloadUrl),controller=new AbortController();
    const response=await fetch(link,{signal:controller.signal});expect(response.status).toBe(200);
    const reader=response.body!.getReader();const first=await reader.read();
    expect(first.value!.length).toBeLessThan(size);controller.abort();await reader.cancel().catch(()=>undefined);
    expect((await fetch(link,{headers:{range:'bytes=0-0'}})).status).toBe(429);
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    expect(downloads).toBe(0);
  });
  it.each([{range:'bytes=0-0','if-range':'"unverified-version"'},{range:'bytes=0-0,2-2'}])('sends the full representation for unsupported conditional/multipart range %j',async headers=>{
    const f=await fixture(),api=recorder(),path=join(f.dataDir,'video.mp4');await writeFile(path,'video');
    api.recordings=async()=>[{id:sessionId,status:'completed'}];api.artifact=async()=>({path,contentType:'video/mp4'});
    const url=await start({recorder:api,dataDir:f.dataDir,publicUrl:'http://127.0.0.1',adminKey:'admin-secret'});
    const gallery=await (await fetch(`${url}/admin/recordings?owner=${f.owner}`,{headers:{authorization:'Bearer admin-secret'}})).json() as {recordings:Array<{videoUrl:string}>};
    const response=await fetch(localLink(url,gallery.recordings[0]!.videoUrl),{headers:headers as Record<string,string>});
    expect(response.status).toBe(200);expect(await response.text()).toBe('video');expect(response.headers.get('content-range')).toBeNull();
  });
  it('serves authenticated byte ranges, leaves HEAD and 416 uncharged, and enforces the selected-byte quota',async()=>{
    const f=await fixture(),api=recorder(),path=join(f.dataDir,'video.mp4');
    await writeFile(path,'0123456789');
    api.recordings=async()=>[{id:sessionId,status:'completed'}];
    api.artifact=async()=>({path,contentType:'video/mp4'});
    const url=await start({recorder:api,dataDir:f.dataDir,publicUrl:'http://127.0.0.1',adminKey:'admin-secret',bandwidthLimitBytes:10});
    const gallery=await (await fetch(`${url}/admin/recordings?owner=${f.owner}`,{headers:{authorization:'Bearer admin-secret'}})).json() as {recordings:Array<{videoUrl:string}>};
    const link=localLink(url,gallery.recordings[0]!.videoUrl);
    const head=await fetch(link,{method:'HEAD',headers:{range:'bytes=2-4'}});
    expect(head.status).toBe(200);expect(head.headers.get('content-length')).toBe('10');expect(await head.text()).toBe('');
    const invalid=await fetch(link,{headers:{range:'bytes=10-'}});
    expect(invalid.status).toBe(416);expect(invalid.headers.get('content-range')).toBe('bytes */10');
    for(const [range,body,contentRange] of [['bytes=2-4','234','bytes 2-4/10'],['bytes=-2','89','bytes 8-9/10'],['bytes=5-','56789','bytes 5-9/10']]){
      const response=await fetch(link,{headers:{range:range!}});
      expect(response.status).toBe(206);expect(response.headers.get('content-range')).toBe(contentRange);
      expect(response.headers.get('content-length')).toBe(String(body!.length));
      expect(response.headers.get('cache-control')).toBe('private, no-store');expect(await response.text()).toBe(body);
    }
    expect((await fetch(link,{headers:{range:'bytes=0-0'}})).status).toBe(429);
    expect((await fetch(link,{method:'HEAD'})).status).toBe(200);
    await revokeInvites(f.dataDir,{owner:f.owner});
    expect((await fetch(link,{headers:{range:'bytes=0-0'}})).status).toBe(404);
    expect((await fetch(link,{method:'HEAD'})).status).toBe(404);
  });
  it("provisions and revokes invites through the locked admin endpoint", async () => {
    const f = await fixture();
    const url = await start({ recorder: recorder(), dataDir: f.dataDir, publicUrl: "http://127.0.0.1", adminKey: "admin-secret" });
    expect((await fetch(`${url}/admin/invites`, { method: "POST", headers: { authorization: "Bearer wrong", "content-type": "application/json" }, body: JSON.stringify({}) })).status).toBe(404);
    const owner = randomUUID();
    const created = await fetch(`${url}/admin/invites`, { method: "POST", headers: { authorization: "Bearer admin-secret", "content-type": "application/json" }, body: JSON.stringify({ owner, expiresIn: "1h" }) });
    expect(created.status).toBe(201);
    const invite = await created.json() as { token?: string; owner?: string };
    expect(invite.owner).toBe(owner); expect(invite.token).toMatch(/^ar_[A-Za-z0-9_-]+$/);
    expect((await post(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }, invite.token!)).status).toBe(200);
    const revoked = await fetch(`${url}/admin/invites?owner=${owner}`, { method: "DELETE", headers: { authorization: "Bearer admin-secret" } });
    expect(revoked.status).toBe(200);
    expect((await post(url, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }, invite.token!)).status).toBe(401);
  });

  it("rejects unauthenticated requests", async () => {
    const f = await fixture();
    const url = await start({ recorder: recorder(), dataDir: f.dataDir, publicUrl: "http://127.0.0.1" });
    const response = await post(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    expect(response.status).toBe(401);
  });

  it("rejects expired invitations and an untrusted Origin", async () => {
    const expired = await fixture("expired", randomUUID(), Date.now() - 1);
    const expiredUrl = await start({ recorder: recorder(), dataDir: expired.dataDir, publicUrl: "http://127.0.0.1" });
    expect((await post(expiredUrl, {}, expired.token)).status).toBe(401);

    const current = await fixture();
    const originUrl = await start({ recorder: recorder(), dataDir: current.dataDir, publicUrl: "http://127.0.0.1" });
    expect((await post(originUrl, {}, current.token, "https://evil.example")).status).toBe(403);
  });

  it("authenticates the owner for calls, then exposes MCP initialize and tools/list", async () => {
    const f = await fixture(); const api = recorder();
    api.mcpToolUsed=vi.fn();
    const url = await start({ recorder: api, dataDir: f.dataDir, publicUrl: "http://127.0.0.1" });
    const initialize = await post(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }, f.token);
    expect(initialize.status).toBe(200);
    const initBody = await initialize.json() as { result?: { serverInfo?: { name?: string; icons?: Array<{src:string}> }; instructions?: string } };
    expect(initBody.result?.serverInfo?.name).toBe("toru");
    expect(initBody.result?.serverInfo?.icons?.[0]?.src).toBe("https://toru.tools/icon.png");
    expect(initBody.result?.instructions).toContain("setup, meaningful action, visible result");

    const listed = await post(url, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, f.token);
    expect(listed.status).toBe(200);
    const listBody = await listed.json() as { result?: { tools?: Array<{ name: string }> } };
    expect(listBody.result?.tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining(["session_open", "browser_observe", "browser_move", "browser_wait", "mark_demo_moment", "recording_render", "recording_links"]));
    const guide = await post(url,{jsonrpc:'2.0',id:20,method:'tools/call',params:{name:'recording_guide',arguments:{}}},f.token);
    const guideBody = await guide.json() as {result:{content:Array<{text:string}>}};
    expect(guideBody.result.content[0]?.text).toContain('END THE TURN');
    expect(guideBody.result.content[0]?.text).toContain('marketing homepage');
    expect(api.mcpToolUsed).not.toHaveBeenCalled();
    expect((await post(url,{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'session_close',arguments:{id:sessionId}}},'wrong-token')).status).toBe(401);
    expect(api.mcpToolUsed).not.toHaveBeenCalled();

    const called = await post(url, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "session_close", arguments: { id: sessionId } } }, f.token);
    expect(called.status).toBe(200);
    const callBody = await called.json() as { result?: unknown; error?: unknown };
    expect(callBody.result).toBeDefined();
    expect(api.calls[0]?.owner).toBe(f.owner);
    expect(api.mcpToolUsed).toHaveBeenCalledExactlyOnceWith(f.owner);
    api.mcpToolUsed=()=>{throw new Error('telemetry_failed');};
    expect((await post(url,{jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'session_close',arguments:{id:sessionId}}},f.token)).status).toBe(200);
  });

  it("hands the secure link back while the product waits for an e-mailed code, not while verifying", async () => {
    const f = await fixture();
    const api = recorder();
    let current = "awaiting_code";
    api.call = async () => ({ content: [{ type: "text", text: "status" }], structuredContent: { id: sessionId, status: "ready", connectionStatus: current } });
    const url = await start({ recorder: api, dataDir: f.dataDir, publicUrl: "http://127.0.0.1", downloadSecret: "test-secret" });
    const call = async (connectionStatus: string) => {
      current = connectionStatus;
      const response = await post(url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "connection_status", arguments: { id: sessionId } } }, f.token);
      return (await response.json() as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent;
    };
    const awaiting = await call("awaiting_code");
    expect(awaiting.setupUrl).toMatch(/^http:\/\/127\.0\.0\.1\/connect\//);
    expect(String(awaiting.userMessage)).toContain("sign-in code");
    expect((await call("verifying")).setupUrl).toBeUndefined();
    expect((await call("ready")).setupUrl).toBeUndefined();
  });

  it("returns a temporary hosted connection page for authenticated products", async () => {
    const f = await fixture();
    const api = recorder({ content: [{ type: "text", text: "connected" }], structuredContent: { id: sessionId, status: "ready" } });
    const url = await start({ recorder: api, dataDir: f.dataDir, publicUrl: "http://127.0.0.1", downloadSecret: "test-secret" });
    const response = await post(url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "session_connect", arguments: { url: "https://example.com" } } }, f.token);
    const body = await response.json() as { result?: { structuredContent?: { setupUrl?: string; openUrl?: string; agentAction?: string }; content?: unknown[] } };
    const setupUrl = body.result?.structuredContent?.setupUrl;
    expect(setupUrl).toMatch(/^http:\/\/127\.0\.0\.1\/connect\//);
    expect(body.result?.structuredContent).toMatchObject({ openUrl: setupUrl, agentAction: "display_url_and_end_turn" });
    expect(JSON.stringify(body.result?.content)).toContain(setupUrl!);
    expect(body.result?.content).toContainEqual(expect.objectContaining({ type: "resource_link", uri: setupUrl }));
    const page = await fetch(localLink(url, setupUrl!));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Connect your product");
  });

  it('rate limits signed connection pages without exhausting the owner MCP budget',async()=>{
    const f=await fixture(),api=recorder();
    const url=await start({recorder:api,dataDir:f.dataDir,publicUrl:'http://127.0.0.1',rateLimitPerMinute:2});
    const response=await post(url,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'session_connect',arguments:{url:'https://example.com'}}},f.token);
    const body=await response.json() as {result?:{structuredContent?:{setupUrl?:string}}};
    const link=localLink(url,body.result!.structuredContent!.setupUrl!);
    expect((await fetch(link)).status).toBe(200);
    expect((await fetch(`${link}/status`)).status).toBe(200);
    expect((await fetch(`${link}/status`)).status).toBe(429);
    expect((await post(url,{jsonrpc:'2.0',id:2,method:'tools/list',params:{}},f.token)).status).toBe(200);
    expect(api.calls).toHaveLength(2);
  });

  it("lists one owner's recordings with short-lived dashboard playback and download links", async () => {
    const f = await fixture(); const api = recorder();
    const preview = join(f.dataDir, "preview.png"), video = join(f.dataDir, "video.mp4");
    await writeFile(preview, "preview"); await writeFile(video, "video");
    api.recordings = async owner => [{ id: sessionId, status: "completed", createdAt: new Date().toISOString(), owner }];
    api.artifact = async (_owner, _id, kind) => ({ path: kind === "video" ? video : preview, contentType: kind === "video" ? "video/mp4" : "image/png" });
    const url = await start({ recorder: api, dataDir: f.dataDir, publicUrl: "http://127.0.0.1", adminKey: "admin-secret", downloadSecret: "download-secret" });
    const response = await fetch(`${url}/admin/recordings?owner=${f.owner}`, { headers: { authorization: "Bearer admin-secret" } });
    expect(response.status).toBe(200);
    const body = await response.json() as { recordings: Array<{ videoUrl: string; downloadUrl: string; previewUrl: string }> };
    const recording = body.recordings[0]!;
    expect(api.recordings).toBeDefined();
    expect((await fetch(localLink(url, recording.videoUrl))).headers.get("content-disposition")).toMatch(/^inline/u);
    expect((await fetch(localLink(url, recording.downloadUrl))).headers.get("content-disposition")).toMatch(/^attachment/u);
    expect((await fetch(localLink(url, recording.previewUrl))).headers.get("content-type")).toBe("image/png");
  });

  it("enforces quota and revocation on gallery links and omits links without an active grant", async () => {
    const f = await fixture(); const api = recorder();
    const video = join(f.dataDir, "video.mp4"); await writeFile(video, "12");
    api.recordings = async () => [{ id: sessionId, status: "completed" }];
    api.artifact = async () => ({path:video,contentType:"video/mp4"});
    const url = await start({recorder:api,dataDir:f.dataDir,publicUrl:"http://127.0.0.1",adminKey:"admin-secret",downloadSecret:"secret",bandwidthLimitBytes:3});
    const gallery = async (owner=f.owner) => (await fetch(`${url}/admin/recordings?owner=${owner}`,{headers:{authorization:"Bearer admin-secret"}})).json() as Promise<{recordings:Array<{videoUrl?:string}>}>;
    const link = (await gallery()).recordings[0]!.videoUrl!;
    const first = await fetch(localLink(url,link));
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect((await fetch(localLink(url,link))).status).toBe(429);
    expect((await gallery(randomUUID())).recordings[0]!.videoUrl).toBeUndefined();
    await revokeInvites(f.dataDir,{owner:f.owner});
    expect((await fetch(localLink(url,link))).status).toBe(404);
    expect((await gallery()).recordings[0]!.videoUrl).toBeUndefined();
  });

  it("accepts secure connection credentials without exposing them to the MCP call", async () => {
    const f = await fixture();
    let received: string[] = [];
    const api = recorder({ content: [{ type: "text", text: "connected" }], structuredContent: { id: sessionId, status: "ready" } });
    api.submitConnectionCredentials = async (_owner, _id, username, password) => { received = [username, password ?? ""]; return { id: sessionId, connectionStatus: "waiting" }; };
    const url = await start({ recorder: api, dataDir: f.dataDir, publicUrl: "http://127.0.0.1", downloadSecret: "test-secret" });
    const response = await post(url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "session_connect", arguments: { url: "https://example.com" } } }, f.token);
    const body = await response.json() as { result?: { structuredContent?: { setupUrl?: string } } };
    const setupUrl = localLink(url, body.result?.structuredContent?.setupUrl!);
    const token = new URL(setupUrl).pathname.split("/")[2]!;
    const sent = await fetch(`${url}/connect/${token}/credentials`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "user@example.com", password: "secret" }) });
    expect(sent.status).toBe(202);
    expect(received).toEqual(["user@example.com", "secret"]);
    const status = await fetch(`${url}/connect/${token}/status`);
    expect(status.status).toBe(200);
    expect(await status.text()).not.toContain('secret');
    const denied = await fetch(`${url}/connect/${token}/credentials`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'user', password: 'secret' }) });
    expect(denied.status).toBe(403);
  });

  it("does not mint links before both artifacts exist", async () => {
    const f = await fixture();
    const api = recorder({ content: [{ type: "text", text: "status" }], structuredContent: { id: sessionId, status: "ready" } });
    const url = await start({ recorder: api, dataDir: f.dataDir, publicUrl: "http://127.0.0.1" });
    const response = await post(url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recording_links", arguments: { id: sessionId } } }, f.token);
    const body = await response.json() as { result?: { structuredContent?: Record<string, unknown> } };
    expect(body.result?.structuredContent).not.toHaveProperty("videoUrl");

    const missing = recorder({ content: [{ type: "text", text: "status" }], structuredContent: { id: sessionId, status: "completed" } });
    const missingUrl = await start({ recorder: missing, dataDir: f.dataDir, publicUrl: "http://127.0.0.1" });
    const missingResponse = await post(missingUrl, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "recording_links", arguments: { id: sessionId } } }, f.token);
    const missingBody = await missingResponse.json() as { result?: { isError?: boolean; structuredContent?: Record<string, unknown> } };
    expect(missingBody.result?.isError).toBe(true);
    expect(missingBody.result?.structuredContent).not.toHaveProperty("videoUrl");
  });

  it("keeps artifact links owner scoped and revocable", async () => {
    const f = await fixture();
    const artifactPath = join(f.dataDir, "video.mp4");
    const previewPath = join(f.dataDir, "preview.png");
    await writeFile(artifactPath, "video"); await writeFile(previewPath, "png");
    const api: RecorderApi = {
      call: async (_owner, name) => ({ content: [{ type: "text", text: "status" }], structuredContent: { id: sessionId, status: name === "recording_status" ? "completed" : "ready" } }),
      artifact: async (_owner, _id, kind) => ({ path: kind === "video" ? artifactPath : previewPath, contentType: kind === "video" ? "video/mp4" : "image/png" }),
      importSession: async () => ({ id: sessionId }),
    };
    const url = await start({ recorder: api, dataDir: f.dataDir, publicUrl: "http://127.0.0.1", downloadSecret: "test-secret" });
    const linksResponse = await post(url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recording_links", arguments: { id: sessionId } } }, f.token);
    const linksBody = await linksResponse.json() as { result?: { structuredContent?: { videoUrl?: string } } };
    const videoUrl = linksBody.result?.structuredContent?.videoUrl;
    expect(videoUrl).toBeTruthy();
    expect((await fetch(localLink(url, videoUrl!))).status).toBe(200);

    await revokeInvites(f.dataDir,{token:f.token});
    expect((await fetch(localLink(url, videoUrl!))).status).toBe(404);
  });

  it("persists the daily invitation bandwidth cap", async () => {
    const f = await fixture();
    const artifactPath = join(f.dataDir, "video.mp4"); const previewPath = join(f.dataDir, "preview.png");
    await writeFile(artifactPath, "12"); await writeFile(previewPath, "3");
    const api: RecorderApi = {
      call: async () => ({ content: [{ type: "text", text: "status" }], structuredContent: { id: sessionId, status: "completed" } }),
      artifact: async (_owner, _id, kind) => ({ path: kind === "video" ? artifactPath : previewPath, contentType: "application/octet-stream" }),
      importSession: async () => ({ id: sessionId }),
    };
    const options = { recorder: api, dataDir: f.dataDir, publicUrl: "http://127.0.0.1", downloadSecret: "persistent-secret", bandwidthLimitBytes: 3 };
    const first = await start(options);
    const firstBody = await (await post(first, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recording_links", arguments: { id: sessionId } } }, f.token)).json() as { result?: { structuredContent?: { videoUrl?: string } } };
    const link = firstBody.result?.structuredContent?.videoUrl;
    expect(link).toBeTruthy();
    expect((await fetch(localLink(first, link!))).status).toBe(200);
    const second = await start(options);
    const secondBody = await (await post(second, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "recording_links", arguments: { id: sessionId } } }, f.token)).json() as { result?: { structuredContent?: { videoUrl?: string } } };
    expect((await fetch(localLink(second, secondBody.result?.structuredContent?.videoUrl!))).status).toBe(429);
  });

  it("runs invite CLI smoke flow without exposing created tokens in list", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "agent-recorder-invites-"));
    directories.push(dataDir);
    const owner = "11111111-1111-4111-8111-111111111111";
    const writes: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      await runInviteCli(["create", "--data-dir", dataDir, "--owner", owner, "--expires-in", "1d"]);
      const token = writes.join("").trim(); writes.length = 0;
      await runInviteCli(["pause", "--data-dir", dataDir]);
      await expect(stat(join(dataDir, "paused"))).resolves.toBeDefined();
      await runInviteCli(["resume", "--data-dir", dataDir]);
      await expect(stat(join(dataDir, "paused"))).rejects.toThrow();
      writes.length = 0;
      await runInviteCli(["list", "--data-dir", dataDir]);
      expect(writes.join("")).toContain(owner);
      expect(writes.join("")).not.toContain(token);
      const importId = "22222222-2222-4222-8222-222222222222";
      await mkdir(join(dataDir, "imports"));
      await writeFile(join(dataDir, "imports", `${importId}.json`), JSON.stringify({ owner, data: "encrypted" }));
      await runInviteCli(["revoke", "--data-dir", dataDir, "--owner", owner]);
      await expect(stat(join(dataDir, "imports", `${importId}.json`))).rejects.toThrow();
    } finally { process.stdout.write = originalWrite; }
  });
});

it('publishes numeric waitMs and returns safe structured capacity/restore errors', async () => {
  const f = await fixture();
  const api = recorder();
  const url = await start({ recorder: api, dataDir: f.dataDir, publicUrl: 'http://127.0.0.1' });
  const listed = await (await post(url, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, f.token)).json();
  expect(listed.result.tools.find((t: { name: string }) => t.name === 'connection_status').inputSchema.properties.waitMs).toMatchObject({ type: 'integer', minimum: 0, maximum: 25000 });
  await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'connection_status', arguments: { id: sessionId, waitMs: 1 } } }, f.token);
  expect(api.calls[0]?.args).toEqual({ id: sessionId, waitMs: 1 });
  api.call = async () => { throw new Error('capacity_busy'); };
  const call = async () => (await (await post(url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'session_open', arguments: { url: 'https://example.com', importId: sessionId } } }, f.token)).json()).result;
  expect((await call()).structuredContent).toMatchObject({ code: 'capacity_busy', retryable: true, scope: 'service', retryAfterMs: 5000, queued: false });
  const { WebDriverProtocolError } = await import('@content-layer/browser');
  api.call = async () => { throw new WebDriverProtocolError('unable to set cookie', 'secret-cookie-do-not-echo'); };
  const failed = await call();
  expect(failed.isError).toBe(true);
  expect(failed.structuredContent).toMatchObject({ code: 'session_restore_failed', importId: sessionId, importPreserved: true, driverCode: 'unable to set cookie' });
  expect(JSON.stringify(failed)).not.toContain('secret-cookie');
  api.call = async () => { throw new WebDriverProtocolError('element_disabled'); };
  const disabled = (await (await post(url, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'browser_click', arguments: { id: sessionId, ref: 'ref_1' } } }, f.token)).json()).result;
  expect(disabled.structuredContent).toMatchObject({ code: 'element_disabled', retryable: false });
  expect(disabled.structuredContent.message).toContain('No click was dispatched');
});

it('exposes usage only through authenticated admin access with an explicit owner',async()=>{
  const f=await fixture();const calls:string[]=[];
  const api={...recorder(),accountUsage:(owner:string)=>{calls.push(owner);return {available:10,used:0,reserved:0};}};
  const url=await start({recorder:api,dataDir:f.dataDir,publicUrl:'http://127.0.0.1',adminKey:'admin-secret'});
  expect((await fetch(`${url}/admin/usage?owner=${f.owner}`)).status).toBe(404);
  expect((await fetch(`${url}/admin/usage?owner=${f.owner}`,{headers:{authorization:`Bearer ${f.token}`}})).status).toBe(404);
  expect((await fetch(`${url}/admin/usage?owner=invalid`,{headers:{authorization:'Bearer admin-secret'}})).status).toBe(400);
  expect(calls).toHaveLength(0);
  const response=await fetch(`${url}/admin/usage?owner=${f.owner}`,{headers:{authorization:'Bearer admin-secret'}});
  expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toContain('no-store');
  expect(await response.json()).toMatchObject({available:10});expect(calls).toEqual([f.owner]);
});

it('protects queue listing/cancel routes with admin auth and preserves owner checks',async()=>{
  const f=await fixture(),jobId=randomUUID(),calls:string[]=[];
  const api={...recorder(),accountQueue:(owner:string)=>{calls.push(owner);return [{jobId,state:'queued'}];},
    cancelQueuedJob:(owner:string,id:string)=>{if(owner!==f.owner || id!==jobId) throw new Error('queued_job_not_found');return {jobId,state:'canceled'};}};
  const url=await start({recorder:api,dataDir:f.dataDir,publicUrl:'http://127.0.0.1',adminKey:'admin-secret'});
  expect((await fetch(`${url}/admin/queue?owner=${f.owner}`)).status).toBe(404);expect(calls).toEqual([]);
  const headers={authorization:'Bearer admin-secret'};
  expect((await fetch(`${url}/admin/queue?owner=${f.owner}`,{headers})).status).toBe(200);expect(calls).toEqual([f.owner]);
  expect((await fetch(`${url}/admin/queue?owner=${randomUUID()}&jobId=${jobId}`,{headers,method:'DELETE'})).status).toBe(404);
  const canceled=await fetch(`${url}/admin/queue?owner=${f.owner}&jobId=${jobId}`,{headers,method:'DELETE'});
  expect(canceled.status).toBe(200);expect(await canceled.json()).toMatchObject({state:'canceled'});
});

it('keeps operational metrics admin-only and uncacheable',async()=>{
 const f=await fixture(),api=recorder();let called=0;
 api.operationalMetrics=async()=>{called++;return {version:1,queue:{states:{queued:2}}};};
 const url=await start({recorder:api,dataDir:f.dataDir,publicUrl:'http://127.0.0.1',adminKey:'admin-secret'});
 expect((await fetch(`${url}/admin/metrics`)).status).toBe(404);
 expect((await fetch(`${url}/admin/metrics`,{headers:{authorization:`Bearer ${f.token}`}})).status).toBe(404);expect(called).toBe(0);
 const result=await fetch(`${url}/admin/metrics`,{headers:{authorization:'Bearer admin-secret'}});
 expect(result.status).toBe(200);expect(result.headers.get('cache-control')).toBe('private, no-store');
 expect(await result.json()).toMatchObject({queue:{states:{queued:2}}});expect(called).toBe(1);
});

it('does not mint a credential when the hosted admission hook puts an account on the waitlist',async()=>{
 const f=await fixture(),api=recorder();api.accountUsage=()=>({mode:'hosted',admission:{state:'waiting'}});
 const url=await start({recorder:api,dataDir:f.dataDir,publicUrl:'http://127.0.0.1',adminKey:'admin-secret'});
 const result=await fetch(`${url}/admin/invites`,{method:'POST',headers:{authorization:'Bearer admin-secret','content-type':'application/json'},body:JSON.stringify({owner:f.owner,expiresIn:'1d'})});
 expect(result.status).toBe(403);expect(await result.json()).toEqual({error:'beta_admission_required'});
});

it('passes history cursors with the requested owner and maps invalid cursors to a safe error',async()=>{
  const f=await fixture(),api=recorder(),cursor=randomUUID();
  api.accountUsage=(owner,received)=>{
    expect(owner).toBe(f.owner);
    if(received!==cursor)throw new Error('invalid_history_cursor');
    return {history:[],historyNextCursor:null};
  };
  const url=await start({recorder:api,dataDir:f.dataDir,publicUrl:'https://recorder.example',adminKey:'admin-secret'});
  const headers={authorization:'Bearer admin-secret'};
  const page=await fetch(`${url}/admin/usage?owner=${f.owner}&historyCursor=${cursor}`,{headers});
  expect(page.status).toBe(200);expect(await page.json()).toEqual({history:[],historyNextCursor:null});
  const bad=await fetch(`${url}/admin/usage?owner=${f.owner}&historyCursor=${randomUUID()}`,{headers});
  expect(bad.status).toBe(400);expect(await bad.json()).toEqual({error:'invalid_history_cursor'});
});

it('records only a completed full attachment transfer, excluding previews, HEAD and ranges',async()=>{
  const f=await fixture(),api=recorder(),path=join(f.dataDir,'video.mp4'),downloads:Array<{owner:string;id:string}>=[];
  await writeFile(path,'synthetic video');
  api.recordings=async()=>[{id:sessionId,status:'completed'}];api.artifact=async()=>({path,contentType:'video/mp4'});
  api.artifactDownloaded=(owner,id)=>{downloads.push({owner,id});};
  const url=await start({recorder:api,dataDir:f.dataDir,publicUrl:'http://127.0.0.1',adminKey:'admin-secret'});
  const gallery=await (await fetch(`${url}/admin/recordings?owner=${f.owner}`,{headers:{authorization:'Bearer admin-secret'}})).json() as {recordings:Array<{videoUrl:string;downloadUrl:string}>};
  const links=gallery.recordings[0]!,download=localLink(url,links.downloadUrl);
  await (await fetch(localLink(url,links.videoUrl))).text();
  await (await fetch(download,{method:'HEAD'})).text();
  await (await fetch(download,{headers:{range:'bytes=0-2'}})).text();
  expect(downloads).toEqual([]);
  expect(await (await fetch(download)).text()).toBe('synthetic video');
  await expect.poll(()=>downloads).toEqual([{owner:f.owner,id:sessionId}]);
});

it('accepts admin-only bounded feedback and redacts unknown handler failures',async()=>{
 const f=await fixture(),api=recorder();let calls=0;
 api.recordingFeedback=(owner,id,input)=>{calls++;expect(owner).toBe(f.owner);expect(id).toBe(sessionId);expect(input).toEqual({useful:true});return {state:'saved',useful:true};};
 const url=await start({recorder:api,dataDir:f.dataDir,publicUrl:'http://127.0.0.1',adminKey:'admin-secret'});
 const send=(body:unknown,key='admin-secret')=>fetch(`${url}/admin/feedback`,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify(body)});
 expect((await send({owner:f.owner,id:sessionId,useful:true},'wrong')).status).toBe(404);
 expect((await send({owner:'bad',id:sessionId,useful:true})).status).toBe(400);expect(calls).toBe(0);
 const saved=await send({owner:f.owner,id:sessionId,useful:true,private:'ignored'});expect(saved.status).toBe(200);expect(saved.headers.get('cache-control')).toBe('private, no-store');
 api.recordingFeedback=()=>{throw new Error('private-db-detail');};
 const failed=await send({owner:f.owner,id:sessionId,useful:true});expect(failed.status).toBe(503);expect(await failed.text()).not.toContain('private-db-detail');
});

it('advertises OAuth discovery and challenges unauthenticated custom connectors',async()=>{
  const f=await fixture();
  const oauth={authorizationServer:'https://clerk.example',scopes:['openid','offline_access'],verify:async()=>undefined};
  const url=await start({recorder:recorder(),dataDir:f.dataDir,publicUrl:'https://toru.example',oauth});
  const metadata=await fetch(`${url}/.well-known/oauth-protected-resource/mcp`);
  expect(metadata.status).toBe(200);
  expect(await metadata.json()).toMatchObject({resource:'https://toru.example/mcp',authorization_servers:['https://clerk.example'],scopes_supported:['openid','offline_access']});
  const denied=await post(url,{jsonrpc:'2.0',id:1,method:'initialize',params:{}});
  expect(denied.status).toBe(401);
  expect(denied.headers.get('www-authenticate')).toContain('resource_metadata="https://toru.example/.well-known/oauth-protected-resource/mcp"');
  const manual=await post(url,{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}},f.token);
  expect(manual.status).toBe(200);
});

it('authenticates an OAuth owner through the MCP transport and checks admission',async()=>{
  const f=await fixture(),api=recorder();
  const {withRecorderStore}=await import('./store/open.js');
  let admitted=true;
  api.accountUsage=async owner=>{await withRecorderStore(f.dataDir,db=>db.connection.prepare('UPDATE accounts SET admission_status=? WHERE owner=?').run(admitted?'admitted':'suspended',owner));return {};};
  const oauth={authorizationServer:'https://clerk.example',scopes:['openid'],verify:async(token:string)=>token==='external'?{owner:f.owner,expiresAt:Date.now()+60_000}:undefined};
  const url=await start({recorder:api,dataDir:f.dataDir,publicUrl:'https://toru.example',oauth});
  const call={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'recording_status',arguments:{id:sessionId}}};
  expect((await post(url,call,'external')).status).toBe(200);
  expect(api.calls[0]?.owner).toBe(f.owner);
  admitted=false;
  expect((await post(url,call,'external')).status).toBe(401);
  expect(api.calls).toHaveLength(1);
});

it('allows scoped connection recovery, rejects cross-origin posts and revoked links',async()=>{
  const f=await fixture(),api=recorder();
  const childId=randomUUID();
  api.retryConnection=vi.fn(async()=>({id:childId,connectionStatus:'waiting',setupExpiresAt:new Date(Date.now()+60000).toISOString()}));
  const url=await start({recorder:api,dataDir:f.dataDir,publicUrl:'http://127.0.0.1'});
  const opened=await (await post(url,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'session_connect',arguments:{url:'https://example.com'}}},f.token)).json();
  const link=localLink(url,opened.result.structuredContent.setupUrl);
  const retry=(origin?:string)=>fetch(link+'/retry',{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify({targetUrl:'https://app.example.com/login'})});
  expect((await retry('https://evil.example')).status).toBe(403);
  expect(api.retryConnection).not.toHaveBeenCalled();
  const response=await retry();expect(response.status).toBe(200);
  expect(api.retryConnection).toHaveBeenCalledWith(f.owner,sessionId,'https://app.example.com/login',undefined);
  const result=await response.json();expect(result.id).toBe(childId);expect(result.setupUrl).toContain('/connect/');
  expect((await fetch(localLink(url,result.setupUrl))).status).toBe(200);
  await revokeInvites(f.dataDir,{owner:f.owner});
  expect((await retry()).status).toBe(404);
  const expiredPage=await fetch(link);expect(await expiredPage.text()).toContain('Copy a message for your agent');
});

it('manages paired Macs and mints setup links only through authenticated admin access',async()=>{
  const f=await fixture();
  const {LocalBrowserBridge}=await import('./local-browser.js');
  const localBrowser=new LocalBrowserBridge(f.dataDir);
  const url=await start({recorder:recorder(),dataDir:f.dataDir,publicUrl:'http://127.0.0.1',adminKey:'admin-secret',localBrowser});
  const headers={authorization:'Bearer admin-secret'};
  expect((await fetch(`${url}/admin/desktop-devices?owner=${f.owner}`)).status).toBe(404);
  expect((await fetch(`${url}/admin/desktop-devices?owner=nope`,{headers})).status).toBe(400);
  const minted=await fetch(`${url}/admin/desktop-devices?owner=${f.owner}`,{method:'POST',headers});
  expect(minted.status).toBe(200);expect(minted.headers.get('cache-control')).toContain('no-store');
  const setup=await minted.json();
  const link=new URL(setup.setupUrl);
  expect(link.origin+link.pathname).toBe('https://toru.tools/mac/setup');expect(link.search).toBe('');
  const fragment=new URLSearchParams(link.hash.slice(1));
  expect(fragment.get('code')).toBe(setup.pairingCode);expect(fragment.get('server')).toBe('http://127.0.0.1');
  const listed=await (await fetch(`${url}/admin/desktop-devices?owner=${f.owner}`,{headers})).json();
  expect(listed).toEqual({devices:[]});
  expect((await fetch(`${url}/admin/desktop-devices?owner=${f.owner}&id=bad`,{method:'DELETE',headers})).status).toBe(400);
  const revoked=await (await fetch(`${url}/admin/desktop-devices?owner=${f.owner}&id=${randomUUID()}`,{method:'DELETE',headers})).json();
  expect(revoked).toEqual({revoked:false});
  localBrowser.close();
});

it('lets the console pair the account\'s own Chrome only when the account has Toru for Chrome',async()=>{
  const f=await fixture();
  const {ExtensionBridge}=await import('./extension-bridge.js');
  const other=randomUUID();
  const extension=new ExtensionBridge(f.dataDir,[f.owner]);
  const url=await start({recorder:recorder(),dataDir:f.dataDir,publicUrl:'http://127.0.0.1',adminKey:'admin-secret',extension});
  const headers={authorization:'Bearer admin-secret'};
  expect((await fetch(`${url}/admin/extension-devices?owner=${f.owner}`)).status).toBe(404);
  expect((await fetch(`${url}/admin/extension-devices?owner=nope`,{headers})).status).toBe(400);
  expect(await (await fetch(`${url}/admin/extension-devices?owner=${other}`,{headers})).json()).toEqual({available:false,devices:[],installUrl:'https://toru.tools/chrome'});
  expect((await fetch(`${url}/admin/extension-devices?owner=${other}`,{method:'POST',headers})).status).toBe(404);
  const listed=await fetch(`${url}/admin/extension-devices?owner=${f.owner}`,{headers});
  expect(listed.headers.get('cache-control')).toContain('no-store');
  expect(await listed.json()).toEqual({available:true,devices:[],installUrl:'https://toru.tools/chrome'});
  const minted=await (await fetch(`${url}/admin/extension-devices?owner=${f.owner}`,{method:'POST',headers})).json();
  expect(minted.connectUrl).toMatch(/^http:\/\/127\.0\.0\.1\/extension\/connect#code=[\w-]{40,}$/);
  expect((await fetch(`${url}/admin/extension-devices?owner=${f.owner}&id=bad`,{method:'DELETE',headers})).status).toBe(400);
  expect(await (await fetch(`${url}/admin/extension-devices?owner=${f.owner}&id=${randomUUID()}`,{method:'DELETE',headers})).json()).toEqual({revoked:false});
  extension.close();
});

describe('dashboard runs', () => {
  const runId = '22222222-2222-4222-8222-222222222222';
  async function setup(session: Record<string, unknown>, extra: { plan?: unknown; timeline?: unknown } = {}) {
    const f = await fixture(), api = recorder();
    const files: Record<string, string> = { video: join(f.dataDir, 'video.mp4'), events: join(f.dataDir, 'events.jsonl'), plan: join(f.dataDir, 'plan.json'), gif: join(f.dataDir, 'demo.gif') };
    await writeFile(files.video!, 'video'); await writeFile(files.gif!, 'GIF89a');
    await writeFile(files.events!, [JSON.stringify({ event: 'stage', state: 'navigating' }), 'not json', JSON.stringify({ event: 'delivered' })].join('\n'));
    await writeFile(files.plan!, JSON.stringify({ goal: 'Create a demo item named Launch', render: { background: 'ocean', gif: true }, ...(extra.plan ? { plan: extra.plan } : {}) }));
    if (extra.timeline) { files.timeline = join(f.dataDir, 'timeline.json'); await writeFile(files.timeline, JSON.stringify(extra.timeline)); }
    api.artifact = async (_owner, _id, kind) => { const path = files[kind]; if (!path) throw new Error('missing'); return { path, contentType: 'application/octet-stream' }; };
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    api.call = async (_owner, name, args) => { calls.push({ name, args: args as Record<string, unknown> }); return { content: [], structuredContent: name === 'recording_status' ? session : { id: sessionId, status: 'rendering' } }; };
    const run = { runId, status: 'done', title: 'Create a demo item', url: 'https://app.example.com', sessionId, stages: {}, active: false, waitingForUser: false };
    api.listRuns = (owner, options) => { expect(owner).toBe(f.owner); expect(options.limit).toBe(5); return { runs: [run, { runId: randomUUID(), status: 'planning', active: true }], nextBefore: 123 }; };
    api.getRun = (owner, id) => owner === f.owner && id === runId ? run : undefined;
    const url = await start({ recorder: api, dataDir: f.dataDir, publicUrl: 'http://127.0.0.1', adminKey: 'admin-secret' });
    return { f, url, calls, headers: { authorization: 'Bearer admin-secret' } };
  }
  it('lists runs with their session state and signed media links, and shows recent events on the detail', async () => {
    const { f, url, headers } = await setup({ id: sessionId, status: 'completed', durationMs: 4000, credits: { available: 9 }, branding: { applied: ['logo'], gif: true }, internal: 'not exposed' });
    expect((await fetch(`${url}/admin/runs?owner=${f.owner}`)).status).toBe(404);
    expect((await fetch(`${url}/admin/runs?owner=nope`, { headers })).status).toBe(400);
    const list = await (await fetch(`${url}/admin/runs?owner=${f.owner}&limit=5`, { headers })).json() as { runs: Array<Record<string, unknown>>; nextBefore: number };
    expect(list.nextBefore).toBe(123);
    expect(list.runs[0]).toMatchObject({ runId, title: 'Create a demo item', session: { status: 'completed', durationMs: 4000, credits: { available: 9 }, branding: { gif: true } } });
    expect(list.runs[0]).not.toHaveProperty('session.internal');
    expect(String(list.runs[0]!.videoUrl)).toContain('/artifact/'); expect(String(list.runs[0]!.gifUrl)).toContain('/artifact/');
    expect(list.runs[1]).not.toHaveProperty('session');
    const gif = await fetch(localLink(url, String(list.runs[0]!.gifUrl)));
    expect(gif.status).toBe(200); expect(gif.headers.get('content-disposition') ?? 'inline').not.toContain('attachment');
    const detail = await (await fetch(`${url}/admin/runs/${runId}?owner=${f.owner}`, { headers })).json() as { run: { events: Array<{ event: string }>; goal: string } };
    expect(detail.run.events.map(e => e.event)).toEqual(['stage', 'delivered']);
    expect(detail.run.goal).toBe('Create a demo item named Launch');
    expect((await fetch(`${url}/admin/runs/${randomUUID()}?owner=${f.owner}`, { headers })).status).toBe(404);
  });
  it('delivers a held video only when a review is pending, reusing the run presentation', async () => {
    const pending = await setup({ id: sessionId, status: 'captured', needsReview: true });
    const accept = (owner: string) => fetch(`${pending.url}/admin/recordings/${sessionId}/accept-review`, { method: 'POST', headers: { ...pending.headers, 'content-type': 'application/json' }, body: JSON.stringify({ owner }) });
    expect((await accept('nope')).status).toBe(400);
    expect((await accept(pending.f.owner)).status).toBe(202);
    const render = pending.calls.find(call => call.name === 'recording_render')!;
    expect(render.args).toMatchObject({ id: sessionId, acceptReview: true, background: 'ocean', gif: true });
    const done = await setup({ id: sessionId, status: 'completed' });
    const again = await fetch(`${done.url}/admin/recordings/${sessionId}/accept-review`, { method: 'POST', headers: { ...done.headers, 'content-type': 'application/json' }, body: JSON.stringify({ owner: done.f.owner }) });
    expect(again.status).toBe(409); expect(await again.json()).toMatchObject({ error: 'review_not_pending' });
    expect(done.calls.some(call => call.name === 'recording_render')).toBe(false);
  });
  it('gives the run screen its plan and, after a render, its steps on the delivered clock', async () => {
    const plan = { steps: [{ screen: 'Items', action: 'click', target: 'button "New item"', expect: 'The form opens' }, { screen: 'Form', action: 'type', target: 'field "Name"', value: 'Launch', expect: 'Launch is typed' }], finalState: 'The item Launch is listed on the page' };
    const timeline = { version: 1, renderedAt: 1, sourceDurationMs: 8_000, outputDurationMs: 8_000, introMs: 0, outroMs: 0, cuts: [], speeds: [], zoomRegions: [],
      semanticTimeline: [{ type: 'click', atMs: 1_000, ref: null, element: 'button New item' }, { type: 'type', atMs: 3_000, ref: null, element: 'textbox Name' }],
      cursor: { scale: 2, smooth: true }, settings: { padding: 0, width: 1920, height: 1080, gif: false, logo: false, cards: false, zoom: { enabled: true }, compressPauses: true } };
    const { f, url, headers } = await setup({ id: sessionId, status: 'completed' }, { plan, timeline });
    const detail = await (await fetch(`${url}/admin/runs/${runId}?owner=${f.owner}`, { headers })).json() as { run: { plan: { steps: unknown[]; finalState: string }; studio: { steps: Array<{ matched: boolean; startMs?: number }> } } };
    expect(detail.run.plan).toEqual({ steps: plan.steps, finalState: plan.finalState });
    expect(detail.run.studio.steps.map(step => [step.matched, step.startMs])).toEqual([[true, 1_000], [true, 3_000]]);
    const planOnly = await setup({ id: sessionId, status: 'completed' }, { plan });
    const withoutTimeline = await (await fetch(`${planOnly.url}/admin/runs/${runId}?owner=${planOnly.f.owner}`, { headers })).json() as { run: Record<string, unknown> };
    expect(withoutTimeline.run).toHaveProperty('plan'); expect(withoutTimeline.run).not.toHaveProperty('studio');
  });
  it('renders a delivered video again with the brand as saved now, but never a held one', async () => {
    const done = await setup({ id: sessionId, status: 'completed' });
    const render = (target: typeof done) => fetch(`${target.url}/admin/recordings/${sessionId}/render`, { method: 'POST', headers: { ...target.headers, 'content-type': 'application/json' }, body: JSON.stringify({ owner: target.f.owner }) });
    expect((await render(done)).status).toBe(202);
    const call = done.calls.find(item => item.name === 'recording_render')!;
    expect(call.args).toMatchObject({ id: sessionId, background: 'ocean', gif: true });
    expect(call.args).not.toHaveProperty('acceptReview');
    const held = await setup({ id: sessionId, status: 'captured', needsReview: true });
    const refused = await render(held);
    expect(refused.status).toBe(409); expect(await refused.json()).toMatchObject({ error: 'review_pending' });
    const capturing = await setup({ id: sessionId, status: 'recording' });
    expect(await (await render(capturing)).json()).toMatchObject({ error: 'render_not_available' });
  });
});
