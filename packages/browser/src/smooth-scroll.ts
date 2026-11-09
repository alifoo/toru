/**
 * Scrolls the panel under the pointer (or the page), with the compositor's native animation.
 *
 * With a duration (fifth argument) the script draws the animation itself over that many milliseconds and resolves when
 * it lands: a capture that takes a frame only every 90ms (a sharp capture on a 1x screen) gets a few frames out of
 * Chrome's own 400ms glide and the scroll looks like it stutters, so the driver scrolls slower and the render plays
 * that span back faster. Each step is placed by the clock, not counted, so a frame the capture holds up delays nothing.
 */
export const smoothScrollScript = `
const [x,y,deltaX,deltaY,durationMs]=arguments;
let element=document.elementFromPoint(x,y);
if (!element || element.closest('canvas,iframe')) return false;
const horizontal=deltaX!==0, delta=horizontal?deltaX:deltaY;
const canScroll=(node)=>{
  const position=horizontal?node.scrollLeft:node.scrollTop;
  const maximum=horizontal?node.scrollWidth-node.clientWidth:node.scrollHeight-node.clientHeight;
  return maximum>1 && (delta>0?position<maximum-1:position>0);
};
const run=(node)=>{
  if (!(durationMs>0)) { node.scrollBy({left:deltaX,top:deltaY,behavior:'smooth'}); return true; }
  const fromX=node.scrollLeft, fromY=node.scrollTop;
  const ease=(t)=>t<0.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
  return new Promise((done)=>{
    const start=performance.now();
    const step=(now)=>{
      const t=Math.min(1,(now-start)/durationMs), f=ease(t);
      node.scrollTo({left:fromX+deltaX*f,top:fromY+deltaY*f,behavior:'instant'});
      if (t<1) requestAnimationFrame(step); else done(true);
    };
    requestAnimationFrame(step);
  });
};
for (let node=element;node && node!==document.scrollingElement;node=node.parentElement) {
  const style=getComputedStyle(node);
  if (/^(auto|scroll|overlay)$/.test(horizontal?style.overflowX:style.overflowY) && canScroll(node)) return run(node);
}
const root=document.scrollingElement;
if (!root || !canScroll(root)) return false;
return run(root);
`;
