import {BillingCustomers} from './billing-customers.js';
import type {StripeCheckoutCloser} from './stripe-checkout-close.js';

/** Resolve only locally known Sessions; missing provider IDs remain a manual hold. */
export async function closeOpenCheckoutsForDeletion(
  customers:BillingCustomers,closer:Pick<StripeCheckoutCloser,'expireForDeletion'>,owner:string,
  now:()=>number=Date.now
):Promise<number>{
  const sessions=customers.openCheckoutsForDeletion(owner);
  for(const session of sessions){
    await closer.expireForDeletion(session.sessionId,session.intentId);
    customers.recordExpired(session.intentId,session.sessionId,now());
  }
  return sessions.length;
}
