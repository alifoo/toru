import {withRecorderStore} from '@agent-recorder/mcp/store/open';
import {BillingCustomers} from '@agent-recorder/hosted-policy/dist/billing-customers.js';
import {StripeCheckoutRecovery} from '@agent-recorder/hosted-policy/dist/stripe-checkout-recovery.js';
import {stripeCheckoutConfigFromEnvironment} from './billing-checkout.js';

async function main(args:string[]){
  const owner=args[1];
  if(args.length!==4||args[0]!=='--owner'||args[2]!=='--confirm-owner'||
    typeof owner!=='string'||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner)||
    owner!==args[3])throw new Error('checkout_recovery_confirmation_required');
  const config=stripeCheckoutConfigFromEnvironment(process.env);
  if(!config)throw new Error('checkout_recovery_test_config_required');
  const {account,livemode,secretKey}=config.stripe;
  const recovery=new StripeCheckoutRecovery({account,livemode,secretKey});
  const dataDir=process.env.DATA_DIR??'/data';
  const missing=await withRecorderStore(dataDir,db=>
    new BillingCustomers(db,account,livemode).missingCreatedSessionsForDeletion(owner));
  let recovered=0;
  for(const intent of missing){
    const session=await recovery.findUnique(intent);
    await withRecorderStore(dataDir,db=>new BillingCustomers(db,account,livemode)
      .recordRecoveredSession(owner,intent.intentId,session));
    recovered++;
  }
  console.log(JSON.stringify({mode:'test',state:'checkout_session_recovered',recovered}));
}

main(process.argv.slice(2)).catch((error:unknown)=>{
  const code=error instanceof Error&&/^[a-z][a-z0-9_]{2,80}$/.test(error.message)
    ?error.message:'checkout_recovery_failed';
  console.error(code);process.exitCode=1;
});
