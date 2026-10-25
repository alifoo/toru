import {expect,it} from 'vitest';
import {parseOutline} from './jev-outline.js';

// Lines exactly as Toru for Mac writes them (AccessibilityOutline.swift and VisualOutline.swift).
const outline=[
 'Scroll areas (layout only; offscreen content is not visual proof): {"regions":[{"kind":"page","remainingPixels":{"down":420,"left":0,"right":0,"up":0},"wheelAt":{"x":480,"y":300}}]}',
 '  [ref_1] textbox "text entry area" focused value="Toru demo\\n" — visible at (855,585) window points',
 '  [ref_2] checkbox "bold" unchecked — visible at (69,52) window points',
 '  [ref_3] combobox "typeface" value="Helvetica" options=["Helvetica","Times"] — visible at (237,52) window points',
 '  [ref_4] button "Delete" in "Invoice 42 · Paid" — offscreen-below (scroll to reveal)',
 '  [ref_5] textbox "Password" secure — visible at (200,300) window points',
 '  [ref_6] menubaritem "Format" in "menu bar" — visible at (403,-12) menu bar',
 '  [ref_7] button "Export" visual — visible at (640,40) window points',
].join('\n');

it('reads the outline Toru for Mac produces, Accessibility and visual lines alike',()=>{
 const {elements,scrollAreas}=parseOutline(outline);
 expect(elements.map(element=>element.ref)).toEqual(['ref_1','ref_2','ref_3','ref_4','ref_5','ref_6','ref_7']);
 expect(elements[0]).toMatchObject({role:'textbox',name:'text entry area',states:['focused'],value:'Toru demo\n',position:'visible'});
 expect(elements[1]).toMatchObject({role:'checkbox',name:'bold',states:['unchecked']});
 expect(elements[2]).toMatchObject({role:'combobox',options:['Helvetica','Times']});
 expect(elements[3]).toMatchObject({scope:'Invoice 42 · Paid',position:'offscreen'});
 expect(elements[4]?.states).toContain('secure');
 expect(elements[5]).toMatchObject({role:'menubaritem',name:'Format',scope:'menu bar',position:'visible'});
 expect(elements[6]).toMatchObject({role:'button',name:'Export',states:['visual']});
 expect(scrollAreas).toEqual([{kind:'page',wheelAt:{x:480,y:300},remaining:{up:0,down:420,left:0,right:0}}]);
});
