import type {TransactionalStore} from './index.js';
import {CreditLedger} from './index.js';
import {BillingCustomers} from './billing-customers.js';
import type {StripeSubscriptionCloser} from './stripe-close.js';

/** Provider cancellation is recoverable: a retry rereads a canceled subscription. */
export async function closeBoundSubscriptionForDeletion(
  store:TransactionalStore,customers:BillingCustomers,ledger:CreditLedger,
  closer:Pick<StripeSubscriptionCloser,'endForDeletion'>,owner:string,now:()=>number=Date.now
):Promise<{effectiveAt:number;revoked:number}>{
  const bound=customers.subscriptionForDeletion(owner);
  const assertNoOtherPaidSubscription=()=>{
    const outstanding=store.connection.prepare(`SELECT 1 FROM hosted_paid_invoices
      WHERE owner=? AND subscription_id<>? LIMIT 1`).get(owner,bound.subscriptionId);
    if(outstanding)throw new Error('billing_subscription_requires_review');
  };
  assertNoOtherPaidSubscription();
  const endedAt=await closer.endForDeletion(bound.customerId,bound.subscriptionId,bound.intentId);
  return store.transaction(()=>{
    const current=customers.subscriptionForDeletion(owner);
    if(current.customerId!==bound.customerId||current.subscriptionId!==bound.subscriptionId||
      current.intentId!==bound.intentId)
      throw new Error('billing_subscription_changed');
    assertNoOtherPaidSubscription();
    return ledger.endCreatorSubscription(owner,bound.subscriptionId,endedAt,now());
  });
}
