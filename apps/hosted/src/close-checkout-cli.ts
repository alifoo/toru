import {withRecorderStore} from '@agent-recorder/mcp/store/open';
import {BillingCustomers} from '@agent-recorder/hosted-policy/dist/billing-customers.js';
import {closeOpenCheckoutsForDeletion} from '@agent-recorder/hosted-policy/dist/billing-checkout-close.js';
import {StripeCheckoutCloser} from '@agent-recorder/hosted-policy/dist/stripe-checkout-close.js';
import {stripeCheckoutConfigFromEnvironment} from './billing-checkout.js';

async function main(args:string[]){
  const owner=args[1];
  if(args.length!==4||args[0]!=='--owner'||args[2]!=='--confirm-owner'||
    typeof owner!=='string'||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner)||
    owner!==args[3])throw new Error('checkout_close_confirmation_required');
  const config=stripeCheckoutConfigFromEnvironment(process.env);
  if(!config)throw new Error('checkout_test_config_required');
  const {account,livemode,secretKey}=config.stripe;
  const closer=new StripeCheckoutCloser({account,livemode,secretKey});
  const closed=await withRecorderStore(process.env.DATA_DIR??'/data',db=>
    closeOpenCheckoutsForDeletion(new BillingCustomers(db,account,livemode),closer,owner));
  console.log(JSON.stringify({mode:'test',state:'checkout_expired',closed}));
}

main(process.argv.slice(2)).catch((error:unknown)=>{
  const code=error instanceof Error&&/^[a-z][a-z0-9_]{2,80}$/.test(error.message)?error.message:'checkout_close_failed';
  console.error(code);process.exitCode=1;
});
