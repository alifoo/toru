import {join} from 'node:path';
import type {RecorderRuntime} from '@agent-recorder/mcp';
import {createSandboxJournal} from './sandbox-journal.js';
import {createRailwayBrowserAllocator} from './railway-browser.js';
import {createRailwayRenderer} from './railway-render.js';
import {createWorkerBackedRuntime} from './remote-runtime.js';
import {railwayRuntimeConfig} from './runtime-config.js';

/** The only production runtime path. Local development may omit the worker mode. */
export function createHostedRuntime(env:NodeJS.ProcessEnv,dataDir:string):RecorderRuntime|undefined{
 if(env.RECORDER_ENVIRONMENT==='local'&&env.HOSTED_WORKER_MODE===undefined)return undefined;
 const config=railwayRuntimeConfig(env);
 const journal=createSandboxJournal(join(dataDir,'sandbox-vms.json'));
 return createWorkerBackedRuntime({
  allocateBrowser:createRailwayBrowserAllocator({...config,journal}),
  render:createRailwayRenderer({...config,journal}),
  chromeBinary:'/usr/bin/chromium',
 });
}
