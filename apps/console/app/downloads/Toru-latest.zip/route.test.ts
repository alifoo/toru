import {expect,it,vi} from 'vitest';
vi.mock('../../../lib/mac-release',()=>({macRelease:vi.fn()}));
import {macRelease} from '../../../lib/mac-release';
import {GET} from './route';
it('redirects to the versioned archive only once a release exists',async()=>{
  vi.mocked(macRelease).mockReturnValue({channel:'beta',minimumMacOS:'15.0',latest:null,releases:[]});
  expect((await GET(new Request('https://toru.tools/downloads/Toru-latest.zip'))).status).toBe(404);
  vi.mocked(macRelease).mockReturnValue({channel:'beta',minimumMacOS:'15.0',latest:{version:'0.2.0',build:'7',sha256:'a'.repeat(64),bytes:1,url:'/downloads/mac/Toru-0.2.0.zip',publishedAt:'',notes:[]},releases:[]});
  const response=await GET(new Request('https://toru.tools/downloads/Toru-latest.zip'));
  expect(response.status).toBe(302);expect(response.headers.get('location')).toBe('https://toru.tools/downloads/mac/Toru-0.2.0.zip');
});
