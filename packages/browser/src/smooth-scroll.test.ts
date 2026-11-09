import { expect, it, vi } from 'vitest';
import { smoothScrollScript } from './smooth-scroll.js';

function element(overrides = {}) {
  return { scrollLeft: 0, scrollTop: 0, scrollWidth: 2000, scrollHeight: 4000,
    clientWidth: 1000, clientHeight: 1000, parentElement: null,
    closest: () => null, scrollBy: vi.fn(), ...overrides };
}
function scroll(target: ReturnType<typeof element>, root: ReturnType<typeof element>, x: number, y: number) {
  const run = new Function('document', 'getComputedStyle', `return function(){${smoothScrollScript}}`);
  return run({elementFromPoint:()=>target,scrollingElement:root},()=>({overflowX:'auto',overflowY:'auto'}))(20,30,x,y);
}
it('animates the root page using native smooth scrolling',()=>{
  const root=element();
  expect(scroll(root,root,0,800)).toBe(true);
  expect(root.scrollBy).toHaveBeenCalledWith({left:0,top:800,behavior:'smooth'});
});
it('scrolls a nested horizontal panel without moving the document',()=>{
  const root=element(),panel=element({parentElement:root});
  expect(scroll(panel,root,400,0)).toBe(true);
  expect(panel.scrollBy).toHaveBeenCalledWith({left:400,top:0,behavior:'smooth'});
  expect(root.scrollBy).not.toHaveBeenCalled();
});
it('chains at panel boundaries and leaves custom canvas/iframe input to WebDriver',()=>{
  const root=element(),panel=element({scrollTop:3000,parentElement:root});
  expect(scroll(panel,root,0,400)).toBe(true);
  expect(panel.scrollBy).not.toHaveBeenCalled();
  expect(root.scrollBy).toHaveBeenCalledOnce();
  expect(scroll(element({closest:()=>({})}),root,0,400)).toBe(false);
  expect(scroll(root,root,0,-400)).toBe(false);
});
it('draws a paced scroll itself and resolves when it lands',async()=>{
  const scrollTo=vi.fn();
  const root=element({scrollTo});
  let now=0;const frames:Array<(t:number)=>void>=[];
  const run=new Function('document','getComputedStyle','performance','requestAnimationFrame',`return function(){${smoothScrollScript}}`);
  const done=run({elementFromPoint:()=>root,scrollingElement:root},()=>({}),{now:()=>now},(f:(t:number)=>void)=>frames.push(f))(20,30,0,600,1200);
  expect(root.scrollBy).not.toHaveBeenCalled();
  for(let t=0;t<=1300&&frames.length;t+=100){now=t;frames.shift()!(t);}
  await expect(done).resolves.toBe(true);
  const tops=scrollTo.mock.calls.map(([o])=>(o as {top:number}).top);
  expect(tops.at(-1)).toBe(600);
  expect(tops.length).toBeGreaterThan(10);
  expect(tops[6]).toBeCloseTo(300,0);
});
