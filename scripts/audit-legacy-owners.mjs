import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clerkId=/^user_[A-Za-z0-9]+$/;

export function recorderOwnerFor(userId){
 const hex=createHash('sha256').update(`agent-recorder:${userId}`).digest('hex');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
}

export function auditLegacyOwners(invitesBody,clerkIdsBody,expectedClerkCount){
 const legacy=JSON.parse(invitesBody);
 if(!legacy || !Array.isArray(legacy.invites))throw new Error('invalid_legacy_invites');
 const invites=legacy.invites;
 if(invites.some(value=>!value || typeof value.owner!=='string' || !uuid.test(value.owner)))throw new Error('invalid_legacy_owner');
 const ids=clerkIdsBody.split(/\r?\n/).map(value=>value.trim()).filter(Boolean);
 if(ids.some(value=>!clerkId.test(value)) || new Set(ids).size!==ids.length)throw new Error('invalid_clerk_ids');
 if(!Number.isSafeInteger(expectedClerkCount) || expectedClerkCount<0 || ids.length!==expectedClerkCount)throw new Error('incomplete_clerk_export');
 const activeOwners=new Set(ids.map(recorderOwnerFor));
 const owners=[...new Set(invites.map(value=>value.owner.toLowerCase()))].sort();
 const unmatchedOwners=owners.filter(owner=>!activeOwners.has(owner));
 return {
  legacyInvitesSha256:createHash('sha256').update(invitesBody).digest('hex'),
  clerkIdsSha256:createHash('sha256').update(clerkIdsBody).digest('hex'),
  legacyGrantCount:invites.length,
  legacyOwnerCount:owners.length,
  clerkUserCount:ids.length,
  matchedOwnerCount:owners.length-unmatchedOwners.length,
  unmatchedOwners,
  interpretation:'An unmatched owner needs manual review. Absence from this Clerk export does not prove deletion; this report never creates tombstones.',
 };
}

async function main(args){
 const option=(name)=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
 const invites=option('--invites'),ids=option('--clerk-ids'),output=option('--report');
 const expected=Number(option('--expected-clerk-count'));
 if(!invites || !ids || !output || !args.includes('--expected-clerk-count') ||
  args.length!==8 || !Number.isSafeInteger(expected) || expected<0)
  throw new Error('usage: audit-legacy-owners --invites PATH --clerk-ids PATH --expected-clerk-count N --report NEW_PATH');
 const report=auditLegacyOwners(await readFile(invites,'utf8'),await readFile(ids,'utf8'),expected);
 await writeFile(output,`${JSON.stringify(report,null,2)}\n`,{flag:'wx',mode:0o600});
 process.stdout.write(`Reviewed ${report.legacyGrantCount} legacy grants, ${report.legacyOwnerCount} owners and ${report.clerkUserCount} Clerk IDs; ${report.unmatchedOwners.length} owners require manual review. Private report: ${output}\n`);
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)
 main(process.argv.slice(2)).catch(error=>{process.stderr.write(`${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;});
