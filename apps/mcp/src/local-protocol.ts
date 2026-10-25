export const LOCAL_METHODS = ['goto','currentUrl','readPage','pageText','screenshot','pointer','formInput','typeText','pressKey','scrollBy','redactSensitiveText','startRecording','stopRecording','markDemoMoment','dispose','listSources','selectSource'] as const;
export type LocalMethod=typeof LOCAL_METHODS[number];
export type LocalCommand={id:string;method:LocalMethod;args:unknown[]};
export const MAX_LOCAL_JSON=12*1024*1024;
export const MAX_LOCAL_VIDEO=256*1024*1024;
export function encodeLocal(value:unknown):unknown {
  if(value instanceof Uint8Array)return {$bytes:Buffer.from(value).toString('base64')};
  if(Array.isArray(value))return value.map(encodeLocal);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,encodeLocal(item)]));
  return value;
}
export function decodeLocal(value:unknown):unknown {
  if(Array.isArray(value))return value.map(decodeLocal);
  if(value&&typeof value==='object'){
    const record=value as Record<string,unknown>;
    if(Object.keys(record).length===1&&typeof record.$bytes==='string')return Buffer.from(record.$bytes,'base64');
    return Object.fromEntries(Object.entries(record).map(([key,item])=>[key,decodeLocal(item)]));
  }
  return value;
}

/** The remote agent controls page content, never the user's clipboard or browser chrome. */
export function assertLocalCommand(command:LocalCommand):void {
  if(!LOCAL_METHODS.includes(command.method)||!Array.isArray(command.args))throw new Error('local_method_forbidden');
  if(command.method==='typeText'||command.method==='formInput'){
    const value=command.args[command.method==='formInput'?1:0];
    if(typeof value==='string'&&/[\uE000-\uE05D]/u.test(value))throw new Error('local_method_forbidden');
  }
  if(command.method==='pressKey'){
    const key=command.args[0];
    if(typeof key!=='string'||key.length>50)throw new Error('local_method_forbidden');
    for(const chord of key.trim().split(/\s+/)){
      const parts=chord.toUpperCase().split('+');
      const base=parts.pop()!;
      if(!/^(ENTER|RETURN|TAB|ESC|ESCAPE|BACKSPACE|DELETE|SPACE|ARROWUP|ARROWDOWN|ARROWLEFT|ARROWRIGHT|UP|DOWN|LEFT|RIGHT|HOME|END|PAGEUP|PAGEDOWN|[A-Z0-9])$/.test(base))throw new Error('local_method_forbidden');
      if(parts.some(part=>!['SHIFT','CTRL','CONTROL','META','CMD','COMMAND'].includes(part)))throw new Error('local_method_forbidden');
      if(parts.some(part=>part!=='SHIFT')&&!['A','Z','Y','ENTER','RETURN'].includes(base))throw new Error('local_method_forbidden');
      if(parts.includes('SHIFT')&&['INSERT','DELETE'].includes(base))throw new Error('local_method_forbidden');
    }
  }
}
