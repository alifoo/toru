import {withRecorderStore} from '@agent-recorder/mcp/store/open';
import {BillingEventInbox} from '@agent-recorder/hosted-policy/dist/billing-events.js';
import {BillingCustomers} from '@agent-recorder/hosted-policy/dist/billing-customers.js';
import {CreditLedger} from '@agent-recorder/hosted-policy';
import {reconcileCheckoutBindings,reconcileCreatorInvoices,reconcileEndedSubscriptions,
  reconcileCreatorRefunds,reconcilePackPurchases} from '@agent-recorder/hosted-policy/dist/stripe-reconcile.js';
import {StripeStateReader} from '@agent-recorder/hosted-policy/dist/stripe-state.js';
import type {StripeCheckoutConfig} from '@agent-recorder/hosted-policy/dist/stripe-checkout.js';

/** Webhooks save receipts first. This worker resolves them against current Stripe state. */
export async function reconcileBillingOnce(dataDir:string,config:StripeCheckoutConfig):Promise<number>{
  const reader=new StripeStateReader(config);
  return withRecorderStore(dataDir,async db=>{
    const inbox=new BillingEventInbox(db,config.account,config.livemode);
    const customers=new BillingCustomers(db,config.account,config.livemode);
    const ledger=new CreditLedger(db);
    const checkout=await reconcileCheckoutBindings(inbox,reader,customers,config.priceId,25,config.additionalPlans);
    const invoices=await reconcileCreatorInvoices(inbox,reader,customers,ledger,config.priceId,config.productId,25,config.additionalPlans);
    const refunds=await reconcileCreatorRefunds(inbox,reader,customers,ledger);
    const ended=await reconcileEndedSubscriptions(inbox,reader,customers,ledger);
    const packs=await reconcilePackPurchases(inbox,reader,customers,ledger,config.packs??[],25);
    return [...checkout,...invoices,...refunds,...ended,...packs].filter(result=>result.status==='retry').length;
  });
}

export function startBillingReconciliation(dataDir:string,config:StripeCheckoutConfig):()=>void{
  let active=true,running=false;
  const tick=async()=>{
    if(!active||running)return;
    running=true;
    try{
      const retries=await reconcileBillingOnce(dataDir,config);
      if(retries)console.error('billing_reconciliation_pending');
    }catch{console.error('billing_reconciliation_unavailable');}
    finally{running=false;}
  };
  const interval=setInterval(()=>void tick(),60_000);
  interval.unref();
  void tick();
  return ()=>{active=false;clearInterval(interval);};
}
