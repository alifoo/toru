import { expect,it,vi } from 'vitest';
import { collectCreditHistory } from './credit-export';
const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
const entry=(id:string)=>({id,jobId:null,kind:'grant',amount:10,createdAt:'2026-09-28T00:00:00.000Z',source:'free',cycle:'2026-09'});
const signal=()=>new AbortController().signal;
it('collects all pages and exports only allowed credit fields',async()=>{
  const fetch=vi.fn().mockResolvedValueOnce({history:[{...entry(first),secret:'do-not-export'}],historyHasMore:true,historyNextCursor:first})
    .mockResolvedValueOnce({history:[entry(second)],historyHasMore:false,historyNextCursor:null});
  const result=await collectCreditHistory(fetch,signal());
  expect(result.entries).toEqual([entry(first),entry(second)]);
  expect(fetch.mock.calls.map(call=>call[0])).toEqual([undefined,first]);
  expect(JSON.stringify(result)).not.toContain('do-not-export');
});
it('fails instead of returning a partial file when a later page fails',async()=>{
  const fetch=vi.fn().mockResolvedValueOnce({history:[entry(first)],historyHasMore:true,historyNextCursor:first}).mockRejectedValueOnce(new Error('unavailable'));
  await expect(collectCreditHistory(fetch,signal())).rejects.toThrow('unavailable');
});
it('rejects repeated entries and incomplete pagination metadata',async()=>{
  const page={history:[entry(first)],historyHasMore:true,historyNextCursor:first};
  await expect(collectCreditHistory(async()=>page,signal())).rejects.toThrow('history_export_incomplete');
  await expect(collectCreditHistory(async()=>({history:[]}),signal())).rejects.toThrow('history_export_incomplete');
  await expect(collectCreditHistory(async()=>({...page,historyNextCursor:second}),signal())).rejects.toThrow('history_export_incomplete');
});
it('aborts on account teardown and enforces a limit without truncating',async()=>{
  const controller=new AbortController(),fetch=vi.fn(async()=>{
    controller.abort();return {history:[],historyHasMore:false,historyNextCursor:null};
  });
  await expect(collectCreditHistory(fetch,controller.signal)).rejects.toThrow();
  await expect(collectCreditHistory(async()=>({history:[entry(first),entry(second)],historyHasMore:false,historyNextCursor:null}),signal(),1)).rejects.toThrow('history_export_too_large');
});
