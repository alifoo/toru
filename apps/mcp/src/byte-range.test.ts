import {expect,it} from 'vitest';
import {byteRange} from './byte-range.js';
it('clamps ranges and safely handles arbitrarily large decimal offsets',()=>{
  expect(byteRange('bytes=2-999999999999999999999999',10)).toEqual({start:2,end:9});
  expect(byteRange('bytes=-999999999999999999999999',10)).toEqual({start:0,end:9});
  expect(byteRange('bytes=999999999999999999999999-',10)).toBe('unsatisfiable');
  expect(byteRange('bytes=-0',10)).toBe('unsatisfiable');
  expect(byteRange('bytes=0-',0)).toBe('unsatisfiable');
});
it('ignores unsupported, multiple and malformed ranges',()=>{
  for(const value of [undefined,'items=0-1','bytes=0-1,3-4','bytes=4-2','bytes=-','bytes=a-b'])expect(byteRange(value,10)).toBeUndefined();
});
