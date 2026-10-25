// Read-only, redacted inventory. This is not a consistent backup or migration validation.
import fs from 'node:fs';
import path from 'node:path';

const root=process.env.DATA_DIR||'/data';
const exists=name=>fs.existsSync(path.join(root,name));
const readJson=name=>{
  const file=path.join(root,name),info=fs.lstatSync(file);
  if(!info.isFile()||info.size>16*1024*1024)throw new Error('inventory_file_invalid');
  return JSON.parse(fs.readFileSync(file,'utf8'));
};
const report={node:process.version,sqliteRuntime:process.versions.sqlite,sqlitePresent:exists('recorder.sqlite'),
  mode:process.env.RECORDER_MODE||'unset',deletionJournalConfigured:!!process.env.HOSTED_DELETION_JOURNAL,
  deletionBucketConfigured:!!process.env.HOSTED_DELETION_BUCKET,
  workerMode:process.env.HOSTED_WORKER_MODE||'unset',
  workerCheckpointConfigured:!!process.env.HOSTED_WORKER_CHECKPOINT,
  workerImagePinned:/^sha256:[a-f0-9]{64}$/.test(process.env.HOSTED_WORKER_IMAGE_SHA256??''),
  railwayTokenConfigured:!!process.env.RAILWAY_TOKEN,
  encryptionKeyConfigured:!!process.env.SESSION_ENCRYPTION_KEY,legacy:{},processes:[]};
let unreadable=0;
try{
  if(exists('invites.json')){
    const values=readJson('invites.json').invites;
    if(Array.isArray(values))report.legacy.invites={total:values.length,owners:new Set(values.map(x=>x.owner)).size,
      active:values.filter(x=>!x.revokedAt&&new Date(x.expiresAt).getTime()>Date.now()).length};
  }
}catch{unreadable++;}
const statuses={};let jobs=0;
try{
  for(const id of fs.readdirSync(path.join(root,'jobs'))){
    if(!/^[0-9a-f-]{36}$/i.test(id))continue;
    try{
      const job=readJson(`jobs/${id}/job.json`);jobs++;
      const status=['ready','recording','captured','rendering','completed','interrupted','closed'].includes(job.status)?job.status:'unknown';
      statuses[status]=(statuses[status]||0)+1;
    }catch{unreadable++;}
  }
}catch{unreadable++;}
report.legacy.jobs={total:jobs,statuses};report.legacy.unreadableFiles=unreadable;
try{report.legacy.importFiles=fs.readdirSync(path.join(root,'imports')).filter(x=>/^[0-9a-f-]{36}\.json$/i.test(x)).length;}catch{}
try{const disk=fs.statfsSync(root);report.diskAvailableBytes=disk.bavail*disk.bsize;}catch{}
for(const pid of fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x))){
  if(Number(pid)===process.pid)continue;
  try{
    let executable;
    try{executable=path.basename(fs.readlinkSync(`/proc/${pid}/exe`));}catch{executable=fs.readFileSync(`/proc/${pid}/comm`,'utf8').trim();}
    if(!/^(node|MainThread|chromedriver|chromium|chrome|ffmpeg)$/.test(executable))continue;
    const status=fs.readFileSync(`/proc/${pid}/status`,'utf8'),command=fs.readFileSync(`/proc/${pid}/cmdline`,'utf8');
    const argv=command.split('\0').filter(Boolean);
    // Chromium can rewrite argv into a single space-separated process title.
    // Do not tokenize Node's -e source, which may merely mention this flag.
    const args=/^(chrome|chromium)$/.test(executable)&&argv.length===1?argv[0].split(/\s+/):argv;
    report.processes.push({executable,uid:status.match(/^Uid:\s+(\d+)/m)?.[1],noSandbox:args.includes('--no-sandbox')});
  }catch{}
}
console.log(JSON.stringify(report,null,2));
