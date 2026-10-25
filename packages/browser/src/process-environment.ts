/** Browser/encoder children must not inherit service credentials or runtime injection flags.
 * This limits environment exposure; it does not provide filesystem/process sandboxing.
 */
export function browserProcessEnvironment(source:Record<string,string|undefined>=process.env):Record<string,string> {
  const result:Record<string,string>={};
  for(const key of ['PATH','HOME','TMPDIR','TMP','TEMP','LANG','LC_ALL','TZ','SYSTEMROOT','WINDIR','LOCALAPPDATA']) {
    const value=source[key];if(value!==undefined)result[key]=value;
  }
  return result;
}
