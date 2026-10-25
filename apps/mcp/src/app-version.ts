/** Dotted numeric versions only (1.2.3). Anything else compares as 0.0.0 so an unknown client is treated as oldest. */
export function parseVersion(value:unknown):number[] {
 if(typeof value!=='string'||!/^[0-9]+(\.[0-9]+){0,3}$/.test(value))return [0,0,0];
 const parts=value.split('.').map(Number);while(parts.length<3)parts.push(0);return parts.slice(0,4);
}
export function compareVersions(a:unknown,b:unknown):number {
 const x=parseVersion(a),y=parseVersion(b);
 for(let i=0;i<Math.max(x.length,y.length);i++){const d=(x[i]??0)-(y[i]??0);if(d!==0)return Math.sign(d);}
 return 0;
}
/** Minimum compatible Mac app version for the desktop routes; unset means every app version is accepted. */
export function appUpdateRequired(header:unknown,minimum:string|undefined):boolean {
 if(!minimum||compareVersions(minimum,'0.0.0')===0)return false;
 return compareVersions(header,minimum)<0;
}
