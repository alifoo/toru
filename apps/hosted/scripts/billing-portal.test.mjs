import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import assert from 'node:assert/strict';
import test from 'node:test';
import {withRecorderStore} from '@agent-recorder/mcp/store/open';
import {BillingCustomers} from '@agent-recorder/hosted-policy/dist/billing-customers.js';
import {createStripePortalHandler} from '../dist/billing-portal.js';

const ownerA='11111111-1111-4111-8111-111111111111';
const ownerB='22222222-2222-4222-8222-222222222222';
const account='acct_123456789ABC';
const url=new URL('https://recorder.example/admin/billing/portal');
const config={account,livemode:false,secretKey:'sk_test_123456789ABC',
  priceId:'price_123456789ABC',productId:'prod_123456789ABC',amountMinor:1900,
  currency:'usd',returnOrigin:'https://recorder.example/'};
function request(owner,authorization='Bearer admin-secret'){
  const input=Readable.from([Buffer.from(JSON.stringify({owner}))]);
  input.method='POST';input.headers={authorization,'content-type':'application/json'};
  return input;
}
function reply(){return {status:0,body:'',writeHead(status){this.status=status;return this;},end(body=''){this.body=body;}};}

test('portal route only exposes the matched account customer to its owner',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'recorder-portal-route-'));
  try{
    await withRecorderStore(dir,db=>{
      new BillingCustomers(db,account,false);
      for(const owner of [ownerA,ownerB])db.connection.prepare('INSERT INTO accounts(owner,created_at) VALUES (?,?)').run(owner,Date.now());
      db.connection.prepare('INSERT INTO hosted_billing_customers VALUES (?,?,?,?,?)')
        .run(account,0,'cus_123456789ABC',ownerA,Date.now());
    });
    const seen=[];
    const handler=createStripePortalHandler(dir,'admin-secret',config,{create:async(customer)=>{
      seen.push(customer);return 'https://billing.stripe.com/p/session/test_123456789ABC';
    }});
    const denied=reply();await handler(request(ownerA,'Bearer wrong'),denied,url);
    assert.equal(denied.status,404);
    const other=reply();await handler(request(ownerB),other,url);
    assert.equal(other.status,404);assert.deepEqual(seen,[]);
    const own=reply();await handler(request(ownerA),own,url);
    assert.equal(own.status,201);
    assert.deepEqual(seen,['cus_123456789ABC']);
  }finally{await rm(dir,{recursive:true,force:true});}
});
