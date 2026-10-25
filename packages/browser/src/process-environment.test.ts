import {execFileSync} from 'node:child_process';
import {expect,it} from 'vitest';
import {browserProcessEnvironment} from './process-environment.js';
it('does not pass service secrets or loader/proxy overrides to an actual child process',()=>{
 const source:Record<string,string|undefined>={...process.env,INVITE_ADMIN_KEY:'synthetic-admin',SESSION_ENCRYPTION_KEY:'synthetic-key',TYPESAFE_API_KEY:'synthetic-model',STRIPE_SECRET_KEY:'synthetic-stripe',UNRECOGNIZED_FUTURE_SECRET:'synthetic-future',NODE_OPTIONS:'--require /does-not-exist',LD_PRELOAD:'/does-not-exist',DYLD_INSERT_LIBRARIES:'/does-not-exist',HTTPS_PROXY:'https://untrusted.example'};
 const env=browserProcessEnvironment(source);
 const output=JSON.parse(execFileSync(process.execPath,['-e','process.stdout.write(JSON.stringify(process.env))'],{env,encoding:'utf8'}));
 for(const key of ['INVITE_ADMIN_KEY','SESSION_ENCRYPTION_KEY','TYPESAFE_API_KEY','STRIPE_SECRET_KEY','UNRECOGNIZED_FUTURE_SECRET','NODE_OPTIONS','LD_PRELOAD','DYLD_INSERT_LIBRARIES','HTTPS_PROXY'])expect(output).not.toHaveProperty(key);
 expect(output.PATH).toBe(source.PATH);
 expect(source.SESSION_ENCRYPTION_KEY).toBe('synthetic-key');
});
