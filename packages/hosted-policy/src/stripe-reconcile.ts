import type {PaidStripePlan,StripePack} from './stripe-checkout.js';
import {packById} from './packs.js';
import {BillingEventInbox} from './billing-events.js';
import {BillingCustomers} from './billing-customers.js';
import {CreditLedger} from './index.js';
import type {StripeStateReader} from './stripe-state.js';

export type CheckoutReconciliation={eventId:string;status:'bound'|'already_processed'|'retry';code?:string};

/** Bind completed Recorder checkouts; leave every other billing event pending for its lifecycle handler. */
export async function reconcileCheckoutBindings(
  inbox:BillingEventInbox,reader:Pick<StripeStateReader,'currentFor'|'verifyCreatorLineItem'>,
  customers:BillingCustomers,priceId:string,limit=25,plans:PaidStripePlan[]=[]
):Promise<CheckoutReconciliation[]>{
  const results:CheckoutReconciliation[]=[];
  for(const receipt of inbox.pendingOfType('checkout.session.completed',limit)){
    try{
      const current=await reader.currentFor(receipt);
      // One-off pack payments are granted by reconcilePackPurchases; they are not subscriptions to bind.
      if(current.mode==='payment')continue;
      await reader.verifyCreatorLineItem(receipt.objectId,priceId,plans);
      const applied=inbox.processPending(receipt.eventId,stored=>{
        if(stored.type!==receipt.type||stored.objectId!==receipt.objectId||stored.created!==receipt.created)
          throw new Error('billing_receipt_changed');
        customers.bindCompleted(current);
      });
      results.push({eventId:receipt.eventId,status:applied?'bound':'already_processed'});
    }catch(error){
      inbox.deferPending(receipt.eventId);
      const message=error instanceof Error?error.message:'';
      const code=/^(billing|checkout)_[a-z_]+$/.test(message)?message:'billing_reconciliation_failed';
      results.push({eventId:receipt.eventId,status:'retry',code});
    }
  }
  return results;
}

export type PackReconciliation={eventId:string;status:'granted'|'already_processed'|'retry'|'skipped';code?:string};

/** Grant a credit pack once per verified one-off payment that this account opened. */
export async function reconcilePackPurchases(
  inbox:BillingEventInbox,reader:Pick<StripeStateReader,'currentFor'|'verifyPackPayment'>,
  customers:BillingCustomers,ledger:CreditLedger,packs:StripePack[],limit=25
):Promise<PackReconciliation[]>{
  const results:PackReconciliation[]=[];
  if(packs.length===0)return results;
  for(const receipt of inbox.pendingOfType('checkout.session.completed',limit)){
    try{
      const current=await reader.currentFor(receipt);
      if(current.mode!=='payment'){results.push({eventId:receipt.eventId,status:'skipped'});continue;}
      const intentId=current.client_reference_id,metadata=current.metadata&&typeof current.metadata==='object'?current.metadata as Record<string,unknown>:{};
      if(typeof intentId!=='string')throw new Error('checkout_session_invalid');
      const opened=customers.packForIntent(intentId);
      if(!opened)throw new Error('checkout_intent_not_found');
      const configured=packs.find(pack=>pack.id===opened.pack),catalogue=packById(opened.pack);
      if(!configured||!catalogue||metadata.pack!==opened.pack||metadata.product!=='agent-recorder')throw new Error('checkout_pack_mismatch');
      const createdMs=Number(current.created)*1000;
      if(!Number.isSafeInteger(createdMs)||createdMs<opened.createdAt-60_000||createdMs>opened.expiresAt+60_000)throw new Error('checkout_intent_expired');
      const payment=await reader.verifyPackPayment(current,configured.priceId,configured.amountMinor);
      let alreadyGranted=false;
      const applied=inbox.processPending(receipt.eventId,stored=>{
        if(stored.type!==receipt.type||stored.objectId!==receipt.objectId||stored.created!==receipt.created)throw new Error('billing_receipt_changed');
        alreadyGranted=ledger.grantPack(opened.owner,opened.pack,catalogue.credits,{intentId:payment.paymentIntentId,chargeId:payment.chargeId,amount:payment.amount,currency:payment.currency}).alreadyGranted;
      });
      results.push({eventId:receipt.eventId,status:applied&&!alreadyGranted?'granted':'already_processed'});
    }catch(error){
      inbox.deferPending(receipt.eventId);
      const message=error instanceof Error?error.message:'';
      const code=/^(billing|checkout|pack)_[a-z_]+$/.test(message)?message:'billing_reconciliation_failed';
      results.push({eventId:receipt.eventId,status:'retry',code});
    }
  }
  return results;
}

export type InvoiceReconciliation={eventId:string;status:'granted'|'already_processed'|'retry';code?:string};

/** Only a verified paid Creator period bound to this checkout can grant a cycle. */
export async function reconcileCreatorInvoices(
  inbox:BillingEventInbox,reader:Pick<StripeStateReader,'currentFor'|'verifyCreatorInvoice'>,
  customers:BillingCustomers,ledger:CreditLedger,priceId:string,productId:string,limit=25,plans:PaidStripePlan[]=[]
):Promise<InvoiceReconciliation[]>{
  const results:InvoiceReconciliation[]=[];
  for(const receipt of inbox.pendingOfType('invoice.paid',limit)){
    try{
      const current=await reader.currentFor(receipt);
      const period=await reader.verifyCreatorInvoice(current,priceId,productId,plans);
      if(period.invoiceId!==receipt.objectId)throw new Error('billing_invoice_mismatch');
      const at=Date.now();
      const applied=inbox.processPending(receipt.eventId,stored=>{
        if(stored.type!==receipt.type||stored.objectId!==receipt.objectId||stored.created!==receipt.created)
          throw new Error('billing_receipt_changed');
        const owner=customers.ownerForSubscription(period.customerId,period.subscriptionId);
        if(!owner)throw new Error('billing_subscription_unbound');
        ledger.grantCreatorCycle(owner,period.subscriptionId,period.invoiceId,
          period.periodStartMs,period.periodEndMs,at,{
            intentId:period.paymentIntentId,chargeId:period.chargeId,
            amount:period.paidAmount,currency:period.currency
          },period.policyVersion);
        if(period.amountRefunded>0)ledger.refundCreatorCharge(owner,period.chargeId,
          period.paymentIntentId,period.amountRefunded,period.paidAmount,at);
      },at);
      results.push({eventId:receipt.eventId,status:applied?'granted':'already_processed'});
    }catch(error){
      inbox.deferPending(receipt.eventId);
      const message=error instanceof Error?error.message:'';
      const code=/^(billing|creator)_[a-z_]+$/.test(message)?message:'billing_reconciliation_failed';
      results.push({eventId:receipt.eventId,status:'retry',code});
    }
  }
  return results;
}

export type SubscriptionEndReconciliation={eventId:string;status:'ended'|'already_processed'|'retry';code?:string};

/** A terminal provider state closes unused paid allowance, even if webhooks arrive out of order. */
export async function reconcileEndedSubscriptions(
  inbox:BillingEventInbox,reader:Pick<StripeStateReader,'currentFor'|'verifyEndedSubscription'>,
  customers:BillingCustomers,ledger:CreditLedger,limit=25,now:()=>number=Date.now
):Promise<SubscriptionEndReconciliation[]>{
  const results:SubscriptionEndReconciliation[]=[];
  for(const receipt of inbox.pendingOfType('customer.subscription.deleted',limit)){
    try{
      const current=await reader.currentFor(receipt);
      const ended=reader.verifyEndedSubscription(current);
      if(ended.subscriptionId!==receipt.objectId)throw new Error('billing_subscription_mismatch');
      const at=now();
      const applied=inbox.processPending(receipt.eventId,stored=>{
        if(stored.type!==receipt.type||stored.objectId!==receipt.objectId||stored.created!==receipt.created)
          throw new Error('billing_receipt_changed');
        const owner=customers.ownerForSubscription(ended.customerId,ended.subscriptionId);
        if(!owner)throw new Error('billing_subscription_unbound');
        ledger.endCreatorSubscription(owner,ended.subscriptionId,ended.endedAtMs,at);
      },at);
      results.push({eventId:receipt.eventId,status:applied?'ended':'already_processed'});
    }catch(error){
      inbox.deferPending(receipt.eventId);
      const message=error instanceof Error?error.message:'';
      const code=/^(billing|creator)_[a-z_]+$/.test(message)?message:'billing_reconciliation_failed';
      results.push({eventId:receipt.eventId,status:'retry',code});
    }
  }
  return results;
}

export type RefundReconciliation={eventId:string;status:'adjusted'|'already_processed'|'retry';code?:string};

/** Apply cumulative partial/full refunds only to a verified Recorder charge. */
export async function reconcileCreatorRefunds(
  inbox:BillingEventInbox,reader:Pick<StripeStateReader,'currentFor'|'verifyRefundedCharge'>,
  customers:BillingCustomers,ledger:CreditLedger,limit=25,now:()=>number=Date.now
):Promise<RefundReconciliation[]>{
  const results:RefundReconciliation[]=[];
  for(const receipt of inbox.pendingOfType('charge.refunded',limit)){
    try{
      const current=await reader.currentFor(receipt);
      const charge=await reader.verifyRefundedCharge(current);
      if(charge.chargeId!==receipt.objectId)throw new Error('billing_charge_mismatch');
      const at=now();
      const applied=inbox.processPending(receipt.eventId,stored=>{
        if(stored.type!==receipt.type||stored.objectId!==receipt.objectId||stored.created!==receipt.created)
          throw new Error('billing_receipt_changed');
        const invoice=ledger.creatorInvoiceForCharge(charge.chargeId);
        if(!invoice||invoice.paymentIntentId!==charge.paymentIntentId||
          invoice.paidAmount!==charge.amountCaptured||invoice.currency!==charge.currency)
          throw new Error('creator_payment_unbound');
        if(customers.ownerForSubscription(charge.customerId,invoice.subscriptionId)!==invoice.owner)
          throw new Error('billing_subscription_unbound');
        ledger.refundCreatorCharge(invoice.owner,charge.chargeId,charge.paymentIntentId,
          charge.amountRefunded,charge.amountCaptured,at);
      },at);
      results.push({eventId:receipt.eventId,status:applied?'adjusted':'already_processed'});
    }catch(error){
      inbox.deferPending(receipt.eventId);
      const message=error instanceof Error?error.message:'';
      const code=/^(billing|creator)_[a-z_]+$/.test(message)?message:'billing_reconciliation_failed';
      results.push({eventId:receipt.eventId,status:'retry',code});
    }
  }
  return results;
}
