/** Use the compositor's native animation, including the scrollable panel under the pointer. */
export const smoothScrollScript = `
const [x,y,deltaX,deltaY]=arguments;
let element=document.elementFromPoint(x,y);
if (!element || element.closest('canvas,iframe')) return false;
const horizontal=deltaX!==0, delta=horizontal?deltaX:deltaY;
const canScroll=(node)=>{
  const position=horizontal?node.scrollLeft:node.scrollTop;
  const maximum=horizontal?node.scrollWidth-node.clientWidth:node.scrollHeight-node.clientHeight;
  return maximum>1 && (delta>0?position<maximum-1:position>0);
};
for (let node=element;node && node!==document.scrollingElement;node=node.parentElement) {
  const style=getComputedStyle(node);
  if (/^(auto|scroll|overlay)$/.test(horizontal?style.overflowX:style.overflowY) && canScroll(node)) {
    node.scrollBy({left:deltaX,top:deltaY,behavior:'smooth'});
    return true;
  }
}
const root=document.scrollingElement;
if (!root || !canScroll(root)) return false;
root.scrollBy({left:deltaX,top:deltaY,behavior:'smooth'});
return true;
`;
