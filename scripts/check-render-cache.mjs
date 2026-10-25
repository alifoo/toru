// pnpm --filter @content-layer/render-host build && node scripts/check-render-cache.mjs
// Pass an output directory to build the fixture for a remote render host.
// Requires Chromium; compares raw pixels before the nondeterministic H.264 encoder.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../apps/render-worker/node_modules/vite/dist/node/index.js';
import { createRenderHost, resolveBrowserBinary } from '../packages/render-host/dist/index.js';
const directory = await realpath(await mkdtemp(join(tmpdir(), 'render-cache-')));
try {
  await writeFile(join(directory, 'index.html'), '<script type="module" src="/check.js"></script>');
  await writeFile(join(directory, 'check.js'), `
    import { FrameRenderer } from '@/lib/exporter/frameRenderer';
    window.renderDemo = async () => {
      try {
        let hits = 0, misses = 0;
        const source = document.createElement('canvas'); source.width = 640; source.height = 360;
        const ctx = source.getContext('2d');
        for (const mode of ['static', 'zoom', 'rotation']) {
          const config = {width:640,height:360,videoWidth:640,videoHeight:360,platform:'linux',
            wallpaper:'#243047',padding:50,borderRadius:12,showShadow:true,shadowIntensity:0.45,showBlur:false,
            cropRegion:{x:0,y:0,width:1,height:1},
            zoomRegions:mode==='static'?[]:[{id:'test',startMs:300,endMs:1300,depth:2,customScale:1.6,
              focus:{cx:0.55,cy:0.4},focusMode:'manual',...(mode==='rotation'?{rotationPreset:'iso'}:{})}]};
          const cached = new FrameRenderer(config), uncached = new FrameRenderer(config);
          await cached.initialize(); await uncached.initialize();
          try {
            for (let i = 0; i < 120; i++) {
              ctx.fillStyle = i < 60 ? '#da3344' : '#2255dd'; ctx.fillRect(0,0,640,360);
              ctx.fillStyle = '#ffffff'; ctx.fillRect(80,50,120,60);
              const frame = new VideoFrame(source,{timestamp:i*1e6/60});
              const previous = cached.shadowInput;
              try {
                await cached.renderFrame(frame,i*1e6/60);
                if (previous && previous===cached.shadowInput) hits++; else misses++;
                uncached.shadowInput = null;
                await uncached.renderFrame(frame,i*1e6/60);
                const a = cached.getCanvas().getContext('2d').getImageData(0,0,640,360).data;
                const b = uncached.getCanvas().getContext('2d').getImageData(0,0,640,360).data;
                for (let p=0;p<a.length;p++) if(a[p]!==b[p]) throw Error(mode+' frame '+i+' pixel '+p+' differs');
              } finally { frame.close(); }
            }
          } finally { cached.destroy(); uncached.destroy(); }
        }
        if (!hits || !misses) throw Error('Both cache hits and invalidation must run');
        await fetch('/result',{method:'POST',body:JSON.stringify({frames:360,hits,misses})});
        return {ok:true};
      } catch(error) { return {ok:false,error:String(error)}; }
    };`);
  const bundleDirectory = process.argv[2] || join(directory, 'dist');
  await build({ configFile:false,root:directory,publicDir:false,logLevel:'error',
    resolve:{alias:{'@':fileURLToPath(new URL('../vendor/openscreen/src',import.meta.url))}},
    build:{outDir:bundleDirectory,target:'es2022'} });
  if (!process.argv[2]) {
    const host = createRenderHost({ browserBinary:await resolveBrowserBinary(),bundleDirectory,
      browserArguments:process.platform==='linux'?['--no-sandbox']:[] });
    const result = await host.render({sourcePath:join(directory,'index.html'),config:{},timeoutMs:120000});
    assert.equal(result.status,'rendered',result.reason);
    console.log('PASS exact frame pixels, static/changed content/zoom/3D:',result.bytes.toString());
  }
} finally { await rm(directory,{recursive:true,force:true}); }
