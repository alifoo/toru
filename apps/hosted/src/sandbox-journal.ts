import {randomUUID} from 'node:crypto';
import {open,readFile,rename,mkdir,rm} from 'node:fs/promises';
import {dirname} from 'node:path';
import {Sandbox,SandboxNotFoundError,SandboxTimeoutError} from 'railway';

export type SandboxJournal={track(id:string):Promise<void>;untrack(id:string):Promise<void>;recover():Promise<void>};
const sandboxId=/^[A-Za-z0-9_-]{12,128}$/;

/** Controller-only, fsync'd VM IDs. A failed destroy remains recorded for startup recovery. */
export function createSandboxJournal(path:string,connect:(id:string)=>Promise<Pick<Sandbox,'destroy'>>=id=>Sandbox.connect(id)):SandboxJournal{
 const ids=new Set<string>();let loaded=false;let pending=Promise.resolve();
 async function load(){
  if(loaded)return;
  let body:string;
  try{body=await readFile(path,'utf8');}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){loaded=true;return;}throw error;}
  const parsed=JSON.parse(body) as unknown;
  if(!Array.isArray(parsed)||parsed.some(value=>typeof value!=='string'||!sandboxId.test(value)))
   throw new Error('sandbox_journal_invalid');
  for(const id of parsed)ids.add(id);
  loaded=true;
 }
 async function persist(){
  const parent=dirname(path);await mkdir(parent,{recursive:true,mode:0o700});
  const temporary=`${path}.${randomUUID()}.tmp`;
  try{
   const file=await open(temporary,'wx',0o600);
   try{await file.writeFile(JSON.stringify([...ids]));await file.sync();}
   finally{await file.close();}
   await rename(temporary,path);
  }catch(error){await rm(temporary,{force:true}).catch(()=>undefined);throw error;}
  const directory=await open(parent,'r');
  try{await directory.sync();}finally{await directory.close();}
 }
 function serial<T>(action:()=>Promise<T>):Promise<T>{
  const result=pending.then(action);
  pending=result.then(()=>undefined,()=>undefined);
  return result;
 }
 return {
  track:id=>serial(async()=>{
   if(!sandboxId.test(id))throw new Error('sandbox_id_invalid');
   await load();ids.add(id);await persist();
  }),
  untrack:id=>serial(async()=>{
   await load();if(!ids.delete(id))return;await persist();
  }),
  recover:()=>serial(async()=>{
   await load();
   for(const id of [...ids]){
    try{await (await connect(id)).destroy();}
    catch(error){if(!(error instanceof SandboxNotFoundError))throw error;}
    ids.delete(id);await persist();
   }
  }),
 };
}

/** A create timeout can leave a live VM even though no Sandbox object was returned. */
export async function createTrackedSandbox<T extends {id:string;destroy():Promise<void>}>(
 create:()=>Promise<T>,journal?:SandboxJournal,
 connect:(id:string)=>Promise<Pick<Sandbox,'destroy'>>=id=>Sandbox.connect(id),
):Promise<T>{
 let sandbox:T;
 try{sandbox=await create();}
 catch(error){
  if(error instanceof SandboxTimeoutError&&error.resource==='sandbox'){
   let tracked=false;
   try{await journal?.track(error.id);tracked=Boolean(journal);}catch{/* still try immediate destroy */}
   try{
    await(await connect(error.id)).destroy();
    if(tracked)await journal?.untrack(error.id);
   }catch{/* keep registered ID for startup recovery */}
  }
  throw error;
 }
 try{await journal?.track(sandbox.id);}
 catch(error){await sandbox.destroy().catch(()=>undefined);throw error;}
 return sandbox;
}
