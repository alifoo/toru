import {expect,it} from 'vitest';
import {connectionHeadline} from './mcp-connections';
const mac=(status:'ready'|'in_use'|'awaiting_approval'|'offline'|'revoked',name='Studio Mac')=>({id:name,name,status});
it('distinguishes MCP connected, Mac connected, ready to record and recording without regressing to setup steps',()=>{
  const connected={connected:true,blocked:false,lastUsedAt:null};
  expect(connectionHeadline({...connected,connected:false},[mac('ready')]).title).toBe('Connect your agent');
  expect(connectionHeadline({...connected,blocked:true},[mac('ready')]).title).toBe('Disconnected');
  expect(connectionHeadline(connected,[]).title).toBe('Connected');
  expect(connectionHeadline(connected,[mac('offline'),mac('revoked')]).title).toBe('Connected');
  expect(connectionHeadline(connected,[mac('awaiting_approval')]).title).toBe('Mac connected');
  expect(connectionHeadline(connected,[mac('ready')]).title).toBe('Ready to record');
  expect(connectionHeadline(connected,[mac('ready'),mac('in_use','Laptop')]).title).toBe('Recording on Laptop');
  expect(connectionHeadline(connected,[mac('revoked')]).detail).not.toContain('Add Toru');
});
