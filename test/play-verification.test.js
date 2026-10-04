'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const Database=require('better-sqlite3');const express=require('express');
const {PlayVerifier,GooglePlayPublisher,configuredPlayVerifier,mountPlayVerification}=require('../play-verification');
const keys=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const signingKey=keys.privateKey.export({type:'pkcs8',format:'pem'});
const body=()=>({protocol:1,packageName:'com.billhive.app',productId:'com.billhive.app.unlock',purchaseToken:'synthetic-private-token',installation:'test-installation-1234',nonce:'test-nonce-1234567'});
const purchased=(extra={})=>({kind:'androidpublisher#productPurchase',purchaseState:0,acknowledgementState:1,consumptionState:0,quantity:1,...extra});
function fixture(t,publisher,clock=()=>1790000000000) {
  const db=new Database(':memory:');t.after(()=>db.close());return {db,verifier:new PlayVerifier({publisher,db,signingKey,clock})};
}
function unpack(wire) {
  const bytes=Buffer.from(wire.payload,'base64url');assert.equal(crypto.verify('RSA-SHA256',bytes,keys.publicKey,Buffer.from(wire.signature,'base64url')),true);
  return JSON.parse(bytes);
}
test('purchased ownership signs bound one-day access and stores only token hash',async t=>{
  const {db,verifier}=fixture(t,{get:async()=>purchased(),acknowledge:async()=>assert.fail('already acknowledged')});
  const input=body();const result=unpack(await verifier.verify(input));
  assert.deepEqual(result,{protocol:1,packageName:input.packageName,productId:input.productId,installation:input.installation,
    tokenHash:crypto.createHash('sha256').update(input.purchaseToken).digest('hex'),nonce:input.nonce,state:'ACTIVE',acknowledged:true,
    issuedAt:1790000000000,expiresAt:1790086400000});
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM play_purchase_audit').all()).includes(input.purchaseToken),false);
});
test('acknowledgement requires post-write readback and never consumes a purchase',async t=>{
  const calls=[];let ack=false;
  const {verifier}=fixture(t,{get:async()=>{calls.push('get');return purchased({acknowledgementState:Number(ack)});},acknowledge:async()=>{calls.push('ack');ack=true;}});
  assert.equal(unpack(await verifier.verify(body())).state,'ACTIVE');assert.deepEqual(calls,['get','ack','get']);
});
test('lost acknowledgement reply retries current Google state without re-acknowledging',async t=>{
  let ack=false;let writes=0;
  const {db,verifier}=fixture(t,{get:async()=>purchased({acknowledgementState:Number(ack)}),acknowledge:async()=>{ack=true;writes++;throw new Error('synthetic lost reply');}});
  await assert.rejects(verifier.verify(body()));assert.equal(db.prepare('SELECT count(*) n FROM play_purchase_audit').get().n,0);
  assert.equal(unpack(await verifier.verify(body())).state,'ACTIVE');assert.equal(writes,1);
});
test('pending and canceled states issue non-active evidence and never acknowledge',async t=>{
  for(const [purchaseState,state] of [[2,'PENDING'],[1,'REVOKED']]) {
    const {verifier}=fixture(t,{get:async()=>purchased({purchaseState,acknowledgementState:0}),acknowledge:async()=>assert.fail('must not acknowledge')});
    assert.equal(unpack(await verifier.verify(body())).state,state);
  }
});
test('revocation on recheck replaces audit state and prior lease is not reused',async t=>{
  let state=0;const {db,verifier}=fixture(t,{get:async()=>purchased({purchaseState:state})});
  assert.equal(unpack(await verifier.verify(body())).state,'ACTIVE');state=1;
  assert.equal(unpack(await verifier.verify({...body(),nonce:'new-nonce-12345678'})).state,'REVOKED');
  assert.equal(db.prepare('SELECT state FROM play_purchase_audit').get().state,'REVOKED');
});
test('wrong product, package, request shape or typed identifiers never reaches Google',async t=>{
  let reads=0;const {verifier}=fixture(t,{get:async()=>{reads++;return purchased();}});
  for(const patch of [{packageName:'unknown',productId:undefined},{productId:'com.billhive.selfhive.unlock'},{protocol:2},{nonce:123456789012345678},{installation:123456789012345678},{extra:'unreviewed'},{purchaseToken:'bad\nsecret'}])
    await assert.rejects(verifier.verify({...body(),...patch}),{code:'PLAY_REQUEST_INVALID'});
  assert.equal(reads,0);
});
test('consumed, multiple quantity, wrong Google product and unknown state do not issue leases',async t=>{
  for(const patch of [{consumptionState:1},{quantity:2},{productId:'foreign'},{purchaseState:9},{acknowledgementState:9},{kind:'wrong'}]) {
    const {db,verifier}=fixture(t,{get:async()=>purchased(patch)});await assert.rejects(verifier.verify(body()));
    assert.equal(db.prepare('SELECT count(*) n FROM play_purchase_audit').get().n,0);
  }
});
test('missing acknowledgement readback keeps verification unresolved',async t=>{
  const {verifier}=fixture(t,{get:async()=>purchased({acknowledgementState:0}),acknowledge:async()=>{}});
  await assert.rejects(verifier.verify(body()));
});
test('concurrent restores serialize one token and acknowledge once',async t=>{
  let ack=false;let writes=0;const {verifier}=fixture(t,{get:async()=>purchased({acknowledgementState:Number(ack)}),acknowledge:async()=>{writes++;await new Promise(resolve=>setImmediate(resolve));ack=true;}});
  const result=await Promise.all([verifier.verify(body()),verifier.verify({...body(),installation:'second-installation-1234',nonce:'second-nonce-1234567'})]);
  assert.equal(writes,1);assert.equal(result.map(unpack).every(value=>value.state==='ACTIVE'),true);assert.equal(verifier.jobs,0);
});
test('fixed Google OAuth and publisher origins encode token path and block redirects',async()=>{
  const calls=[];const publisher=new GooglePlayPublisher({client_email:'fixture@fixture.iam.gserviceaccount.com',private_key:signingKey,token_uri:'https://oauth2.googleapis.com/token'},async(url,options)=>{
    calls.push({url,options});return new Response(JSON.stringify(url.endsWith('/token')?{access_token:'synthetic-oauth-token',token_type:'Bearer',expires_in:3600}:purchased()),{status:200});
  },()=>1790000000000);
  const value={...body(),purchaseToken:'token/with?reserved#chars'};await publisher.get(value);await publisher.acknowledge(value);
  assert.equal(calls.length,3);assert.equal(calls.every(call=>call.options.redirect==='error'),true);
  assert.equal(calls[1].url,'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.billhive.app/purchases/products/com.billhive.app.unlock/tokens/token%2Fwith%3Freserved%23chars');
  assert.equal(calls[2].url,calls[1].url+':acknowledge');assert.equal(calls[2].options.method,'POST');
});
test('OAuth/publisher failures are unavailable rather than a revocation proof',async t=>{
  const {verifier}=fixture(t,{get:async()=>{throw new Error('synthetic upstream failure with private bearer');}});
  await assert.rejects(verifier.verify(body()));
  const publisher=new GooglePlayPublisher({client_email:'fixture@fixture.iam.gserviceaccount.com',private_key:signingKey,token_uri:'https://oauth2.googleapis.com/token'},async()=>new Response('denied',{status:401}));
  await assert.rejects(publisher.get(body()),{code:'PLAY_CHECK_UNAVAILABLE'});
});
test('disabled merchant route gives no paid evidence and failure body contains no bearer',async t=>{
  const db=new Database(':memory:');t.after(()=>db.close());assert.equal(configuredPlayVerifier({},db),null);
  assert.throws(()=>configuredPlayVerifier({PLAY_VERIFY_ENABLED:'1'},db),{message:'Play merchant verification configuration is invalid'});
  const app=express();app.use(express.json());mountPlayVerification(app,null,(_req,_res,next)=>next());
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/play/verify`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body())});
  assert.equal(response.status,503);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),{code:'PLAY_CHECK_UNAVAILABLE'});
});
