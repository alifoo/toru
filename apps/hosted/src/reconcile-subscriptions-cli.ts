import {withRecorderStore} from '@agent-recorder/mcp/store/open';
import {BillingEventInbox} from '@agent-recorder/hosted-policy/dist/billing-events.js';
import {BillingCustomers} from '@agent-recorder/hosted-policy/dist/billing-customers.js';
import {CreditLedger} from '@agent-recorder/hosted-policy';
import {reconcileEndedSubscriptions} from '@agent-recorder/hosted-policy/dist/stripe-reconcile.js';
import {StripeStateReader} from '@agent-recorder/hosted-policy/dist/stripe-state.js';
import {stripeCheckoutConfigFromEnvironment} from './billing-checkout.js';

async function main(){
  const config=stripeCheckoutConfigFromEnvironment(process.env);
  if(!config)throw new Error('checkout_test_config_required');
  const {account,livemode,secretKey}=config.stripe;
  const reader=new StripeStateReader({account,livemode,secretKey});
  const results=await withRecorderStore(process.env.DATA_DIR??'/data',async db=>{
    const inbox=new BillingEventInbox(db,account,livemode);
    const customers=new BillingCustomers(db,account,livemode);
    const ledger=new CreditLedger(db);
    return reconcileEndedSubscriptions(inbox,reader,customers,ledger);
  });
  const counts={ended:results.filter(result=>result.status==='ended').length,
    retry:results.filter(result=>result.status==='retry').length,
    alreadyProcessed:results.filter(result=>result.status==='already_processed').length};
  console.log(JSON.stringify({mode:'test',...counts,codes:results.filter(result=>result.code).map(result=>result.code)}));
  if(counts.retry)process.exitCode=1;
}

main().catch((error:unknown)=>{
  const code=error instanceof Error&&/^[a-z][a-z0-9_]{2,80}$/.test(error.message)?error.message:'billing_reconciliation_failed';
  console.error(code);process.exitCode=1;
});
