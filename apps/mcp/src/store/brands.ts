import {z} from 'zod';
import {backgroundCatalog} from '@content-layer/render-contract';
import type {RecorderDatabase} from './database.js';
/** Per-domain look applied by the renderer. '*' is the account default. */
export const brandSchema=z.object({
 accent:z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
 /** A hex colour, a CSS gradient, a preset name, or a background from the render catalog (`toru-sky`, `openscreen-14`…). */
 background:z.string().max(400).regex(/^(#[0-9a-f]{6}|(repeating-)?(linear|radial|conic)-gradient\([^;<>]{1,300}\)|midnight|ocean|sunset|(toru|solid|openscreen)-[a-z0-9]{1,20})$/i)
  .refine(value=>!/^(toru|solid|openscreen)-/i.test(value)||backgroundCatalog.some(entry=>entry.id===value),'unknown_background').optional(),
 padding:z.number().int().min(0).max(100).optional(),
 radius:z.number().int().min(0).max(64).optional(),
 /** Small PNG, bottom-right by default; sealed to a data URL so the renderer never fetches anything. */
 logo:z.string().regex(/^data:image\/png;base64,iVBOR[A-Za-z0-9+/]+={0,2}$/).max(200_000).optional(),
 logoPosition:z.enum(['bottom-right','bottom-left','top-right','top-left']).optional(),
 /** Short intro/outro cards: brand background with the logo centred. */
 cards:z.boolean().optional(),
 gif:z.boolean().optional(),
 width:z.union([z.literal(1280),z.literal(1920),z.literal(2560)]).optional(),
 /** The camera: zoom on each click (on by default) and how deep it may go, as a zoom factor. */
 zoom:z.object({enabled:z.boolean(),scale:z.number().min(1.2).max(2.5).optional()}).strict().optional(),
 /** The rendered pointer: ease the travels the driver left stalled (on by default). */
 cursor:z.object({smooth:z.boolean()}).strict().optional(),
}).strict();
export type Brand=z.infer<typeof brandSchema>;
export type BrandRecord={origin:string;brand:Brand;updatedAt:number};
export function brandOrigin(value:string):string {
 if(value==='*')return '*';
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password)throw new Error('public_https_url_required');
 return url.origin;
}
export class BrandStore {
 constructor(private db:RecorderDatabase){}
 list(owner:string):BrandRecord[] {
  return this.db.connection.prepare('SELECT origin,settings,updated_at FROM brands WHERE owner=? ORDER BY origin').all(owner)
   .map(row=>({origin:String(row.origin),brand:brandSchema.parse(JSON.parse(String(row.settings))),updatedAt:Number(row.updated_at)}));
 }
 save(owner:string,originOrUrl:string,input:unknown,now=Date.now()):BrandRecord {
  const origin=brandOrigin(originOrUrl),brand=brandSchema.parse(input);
  return this.db.transaction(()=>{
   this.db.connection.prepare('INSERT OR IGNORE INTO accounts(owner,created_at) VALUES (?,?)').run(owner,now);
   const count=Number(this.db.connection.prepare('SELECT count(*) n FROM brands WHERE owner=? AND origin<>?').get(owner,origin)!.n);
   if(count>=30)throw new Error('brand_limit');
   this.db.connection.prepare(`INSERT INTO brands(owner,origin,settings,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(owner,origin) DO UPDATE SET settings=excluded.settings,updated_at=excluded.updated_at`).run(owner,origin,JSON.stringify(brand),now);
   return {origin,brand,updatedAt:now};
  });
 }
 remove(owner:string,originOrUrl:string):boolean {
  return Number(this.db.connection.prepare('DELETE FROM brands WHERE owner=? AND origin=?').run(owner,brandOrigin(originOrUrl)).changes)===1;
 }
 removeAll(owner:string):void {this.db.connection.prepare('DELETE FROM brands WHERE owner=?').run(owner);}
 /** The domain brand wins over the account default; absent both, the renderer keeps Toru's look. */
 resolve(owner:string,url:string|undefined):Brand|undefined {
  let origin:string|undefined;
  try{origin=url?new URL(url).origin:undefined;}catch{origin=undefined;}
  const rows=this.db.connection.prepare('SELECT origin,settings FROM brands WHERE owner=? AND origin IN (?,?)').all(owner,origin??'','*');
  const pick=(o:string)=>{const row=rows.find(r=>r.origin===o);return row?brandSchema.parse(JSON.parse(String(row.settings))):undefined;};
  return (origin?pick(origin):undefined)??pick('*');
 }
}
