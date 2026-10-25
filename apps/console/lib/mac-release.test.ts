import {expect,it} from 'vitest';
import {macRelease} from './mac-release';
const release={version:'0.2.0',build:'7',sha256:'a'.repeat(64),bytes:1200,url:'/downloads/mac/Toru-0.2.0.zip',publishedAt:'2026-10-06T00:00:00Z',notes:['Initial beta']};
it('offers only well-formed same-origin releases and reads the committed manifest',()=>{
  // The committed manifest publishes a real release that the page and /downloads/Toru-latest.zip can offer.
  expect(macRelease().latest).toMatchObject({url:expect.stringMatching(/^\/downloads\/mac\/Toru-/)});
  expect(macRelease({}).latest).toBeNull();
  expect(macRelease({latest:release,releases:[release]}).latest).toEqual(release);
  expect(macRelease({latest:{...release,url:'https://evil.example/Toru.zip'}}).latest).toBeNull();
  expect(macRelease({latest:{...release,sha256:'short'}}).latest).toBeNull();
  expect(macRelease({releases:[release,{...release,version:'x'}]}).releases).toHaveLength(1);
});
