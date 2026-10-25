/** Single byte range (RFC 9110 §14). Unsupported/invalid ranges fall back to full GET. */
export function byteRange(header:string|undefined,size:number):{start:number;end:number}| 'unsatisfiable' | undefined {
  if(!header)return undefined;
  const match=/^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if(!match || (!match[1]&&!match[2]))return undefined;
  const length=BigInt(size);
  if(!match[1]){
    const suffix=BigInt(match[2]!);
    if(suffix===0n||length===0n)return 'unsatisfiable';
    return {start:Number(suffix>=length?0n:length-suffix),end:size-1};
  }
  const start=BigInt(match[1]),end=match[2]?BigInt(match[2]):length-1n;
  if(match[2]&&end<start)return undefined;
  if(start>=length)return 'unsatisfiable';
  return {start:Number(start),end:Number(end>=length?length-1n:end)};
}
