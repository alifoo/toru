import type { RecorderDatabase } from './store/database.js';
export type RecordingPolicy = {version:string;sessionMs:number;captureMs:number;rawRetentionMs:number;videoRetentionMs:number};
export type LifecycleJob = {id:string;owner:string;createdAt:number;policy?:RecordingPolicy};
/** Synchronous hooks run in the same SQL transaction as the corresponding job transition. */
export interface RecorderLifecycle {
  admit(job:LifecycleJob,requestId:string,inputHash:string):RecordingPolicy;
  beforeRender?(job:LifecycleJob):void;
  recordingStarted?(job:LifecycleJob):void;
  captureFinalized?(job:LifecycleJob):void;
  delivered(job:LifecycleJob,artifactId:string):void;
  abandon(job:LifecycleJob):void;
  usage(owner:string,historyCursor?:string):Record<string,unknown>;
  metrics?():Record<string,unknown>;
  artifactDownloaded?(owner:string,id:string):void;
  /** A successful authenticated MCP tool call; connection probes only list tools. */
  mcpToolUsed?(owner:string):void;
  recordingFeedback?(owner:string,id:string,input:unknown):Record<string,unknown>;
  /** Periodic private-policy cleanup; called at startup and at most once per hour. */
  maintenance?(now:number):void;
  /** Async durable deletion intent, completed before access is revoked or media removed. */
  beforeAccountErase?(owner:string):Promise<void>;
  /** Refuse erasure while extension-owned account state still requires review. */
  assertAccountEraseAllowed?(owner:string):void;
  eraseAccountData?(owner:string):void;
  /** Extension-owned receipt fields, added only after successful erasure. */
  accountEraseReceipt?(owner:string):Record<string,unknown>;
}
export type LifecycleFactory=(store:RecorderDatabase)=>RecorderLifecycle;

export type AuthorizationCheck=(()=>Promise<boolean>) & {tokenHash?:string};
