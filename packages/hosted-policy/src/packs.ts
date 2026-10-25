/**
 * One-off credit packs on top of the plans. PLACEHOLDER PRICES (Slideshot reference: 1 = US$0.90,
 * 15 = US$13.50, 30 = US$27). They only become purchasable when the matching Stripe one-time prices
 * exist and HOSTED_STRIPE_PACKS lists them; until then the checkout answers packs_unavailable.
 */
export type CreditPack={id:'pack-1'|'pack-15'|'pack-30';credits:number;amountMinor:number};
export const creditPacks:readonly CreditPack[]=Object.freeze([
  {id:'pack-1',credits:1,amountMinor:90},
  {id:'pack-15',credits:15,amountMinor:1350},
  {id:'pack-30',credits:30,amountMinor:2700},
]);
export function packById(id:unknown):CreditPack|undefined{return creditPacks.find(pack=>pack.id===id);}
export const isPackId=(id:unknown):id is CreditPack['id']=>packById(id)!==undefined;
