export type CreditEntry = {id:string;jobId:string|null;kind:string;amount:number;createdAt:string;source:string;cycle:string};
type FetchPage = (cursor:string|undefined,signal:AbortSignal)=>Promise<unknown>;

/** Collect first, publish a file only after every page succeeds. No partial exports. */
export async function collectCreditHistory(fetchPage:FetchPage,signal:AbortSignal,maxEntries=100_000) {
  const startedAt=new Date().toISOString();
  const entries:CreditEntry[]=[],seen=new Set<string>(),cursors=new Set<string>();
  let cursor:string|undefined;
  do {
    signal.throwIfAborted();
    const body=await fetchPage(cursor,signal) as {history?:unknown;historyNextCursor?:unknown;historyHasMore?:unknown}|null;
    signal.throwIfAborted();
    if(!body||!Array.isArray(body.history)||typeof body.historyHasMore!=='boolean')throw new Error('history_export_incomplete');
    for(const row of body.history){
      if(!row||typeof row.id!=='string'||!row.id||seen.has(row.id)||
        !(row.jobId===null||typeof row.jobId==='string')||!['grant','reserve','commit','release','adjust'].includes(row.kind)||
        !Number.isSafeInteger(row.amount)||typeof row.createdAt!=='string'||!Number.isFinite(Date.parse(row.createdAt))||
        typeof row.source!=='string'||typeof row.cycle!=='string')throw new Error('history_export_incomplete');
      if(entries.length>=maxEntries)throw new Error('history_export_too_large');
      seen.add(row.id);
      // Explicit allowlist: never export arbitrary upstream properties.
      entries.push({id:row.id,jobId:row.jobId,kind:row.kind,amount:row.amount,createdAt:row.createdAt,source:row.source,cycle:row.cycle});
    }
    const next=body.historyNextCursor;
    if(body.historyHasMore){
      if(typeof next!=='string'||!/^[0-9a-f-]{36}$/i.test(next)||cursors.has(next)||!body.history.length||next!==entries.at(-1)?.id)throw new Error('history_export_incomplete');
      cursors.add(next);cursor=next;
    }else{
      if(next!==null)throw new Error('history_export_incomplete');
      cursor=undefined;
    }
  }while(cursor);
  return {format:'agent-recorder-credit-history-v1',startedAt,completedAt:new Date().toISOString(),entries};
}
