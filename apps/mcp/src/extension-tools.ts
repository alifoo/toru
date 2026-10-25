import {z} from 'zod';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import type {ExtensionBridge} from './extension-bridge.js';

export const extensionInstallUrl='https://toru.tools/chrome';

/** Toru for Chrome tools: pair the user's Chrome once, then record with recording_run and its connectionId. */
export function registerExtensionTools(server:McpServer,owner:string,bridge:ExtensionBridge,check:()=>Promise<boolean>,publicUrl:URL):void {
 const result=(value:Record<string,unknown>):CallToolResult=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
 const denied:CallToolResult={isError:true,content:[{type:'text',text:'unauthorized'}]};
 const failure=(error:unknown):CallToolResult=>{
  const raw=error instanceof Error?error.message:'';
  return {isError:true,content:[{type:'text',text:JSON.stringify({code:/^[a-z][a-z0-9_]{2,70}$/.test(raw)?raw:'extension_failed'})}]};
 };
 server.registerTool('extension_devices',{
  description:'Toru for Chrome: list the Chrome browsers paired with this account. When one is ready, record in the user\'s own signed-in Chrome with recording_run and localConnectionId set to its connectionId: Toru opens the product in a new tab there, the Toru navigator drives it and Toru records it, with no click from the user. Offline means Chrome is closed or the extension is off. An empty list means no Chrome is paired yet: use extension_pair.',
  inputSchema:{},annotations:{readOnlyHint:true},
 },async()=>{
  if(!await check())return denied;
  try{
   const devices=await bridge.devices(owner);
   return result({devices,installUrl:extensionInstallUrl,...(devices.length===0?{nextAction:'extension_pair'}:{})});
  }catch(error){return failure(error);}
 });
 server.registerTool('extension_pair',{
  description:'Toru for Chrome: pair the user\'s Chrome once so Toru can record in it, signed in as the user. Returns connectUrl: give it to the user (or open it in their Chrome) after they install the extension from installUrl. Opening it pairs that Chrome; then end the turn and wait for the user. Afterwards extension_devices shows it ready. The link works once, for 10 minutes.',
  inputSchema:{},
 },async()=>{
  if(!await check())return denied;
  try{
   const pairing=bridge.pair(owner,check);
   return result({connectUrl:new URL(`/extension/connect#code=${pairing.pairingCode}`,publicUrl).href,expiresAt:pairing.expiresAt,installUrl:extensionInstallUrl,
    instruction:'If the user does not have Toru for Chrome yet, send them to installUrl first. Then give them connectUrl to open in that Chrome; never paste it anywhere else. Pairing needs no other step. End the turn and wait for the user to say it is connected, then call extension_devices.'});
  }catch(error){return failure(error);}
 });
 server.registerTool('extension_disconnect',{
  description:'Toru for Chrome: unpair a Chrome when the user asks. A new extension_pair is needed to record there again.',
  inputSchema:{connectionId:z.uuid()},annotations:{destructiveHint:true},
 },async({connectionId})=>{
  if(!await check())return denied;
  try{return result({revoked:await bridge.revoke(owner,connectionId)});}catch(error){return failure(error);}
 });
}
