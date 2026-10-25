import {withRecorderStore} from '@agent-recorder/mcp/store/open';
import {BillingCustomers} from '@agent-recorder/hosted-policy/dist/billing-customers.js';
import {closeBoundSubscriptionForDeletion} from '@agent-recorder/hosted-policy/dist/billing-close.js';
import {StripeSubscriptionCloser} from '@agent-recorder/hosted-policy/dist/stripe-close.js';
import {CreditLedger} from '@agent-recorder/hosted-policy';
import {stripeCheckoutConfigFromEnvironment} from './billing-checkout.js';

async function main(args:string[]){
  const owner=args[1];
  if(args.length!==4||args[0]!=='--owner'||args[2]!=='--confirm-owner'||
    typeof owner!=='string'||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner)||
    owner!==args[3])throw new Error('billing_close_confirmation_required');
  const config=stripeCheckoutConfigFromEnvironment(process.env);
  if(!config)throw new Error('checkout_test_config_required');
  const {account,livemode,secretKey}=config.stripe;
  const closer=new StripeSubscriptionCloser({account,livemode,secretKey});
  const result=await withRecorderStore(process.env.DATA_DIR??'/data',db=>{
    const customers=new BillingCustomers(db,account,livemode),ledger=new CreditLedger(db);
    return closeBoundSubscriptionForDeletion(db,customers,ledger,closer,owner);
  });
  console.log(JSON.stringify({mode:'test',state:'subscription_ended',...result}));
}

main(process.argv.slice(2)).catch((error:unknown)=>{
  const code=error instanceof Error&&/^[a-z][a-z0-9_]{2,80}$/.test(error.message)?error.message:'billing_close_failed';
  console.error(code);process.exitCode=1;
});
