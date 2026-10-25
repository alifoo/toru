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
