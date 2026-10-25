/** Node-only paths of the shared driver (ffmpeg, ChromeDriver, temp profiles) never run in the extension. */
export function unavailable(name: string): never {
  throw new Error(`${name}_unavailable_in_extension`);
}
