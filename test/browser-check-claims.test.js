'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {Client,Transport,sha256,validateSnapshot} = require('../public/check-claim-client');
const copy = value => structuredClone(value);
const token = 'browser-check-test-token-1234567890';
const code = name => Object.assign(new Error(name),{code:name});
class MemoryStore {
  constructor() { this.rows = new Map(); this.queue = Promise.resolve(); this.fail = false; }
  transact(id, change) {
    const result = this.queue.then(() => {
      const next = change(copy(this.rows.get(id)));
      if (this.fail) throw new Error('Synthetic storage failure');
      this.rows.set(id,copy(next)); return copy(next);
    });
    this.queue = result.catch(() => {}); return result;
  }
}
function snapshot() {
  return {protocolVersion:1,serverInstanceId:'server-1',householdId:'house-1',revision:1,checkId:'dinner',shareId:sha256(token),
    shareRevision:1,createdAt:123,revisionPreconditionsRequired:true,currencyCode:'EUR',
    check:{id:'dinner',name:'Dinner',dateISO:'2026-09-27',isCompleted:false,items:[{id:'soup',name:'Soup',price:12},{id:'bread',name:'Bread',price:3}],
      taxAmount:1,tipAmount:2,discountAmount:0,compAmount:0,serviceFeeAmount:0},claims:[]};
}
function server() {
  return {value:snapshot(),receipts:new Map(),sent:[],access:'active',lose:false,
    async load() { if(this.access !== 'active') throw code('SHARE_REVOKED'); return copy(this.value); },
    async send(payload,key) {
      this.sent.push({payload,key}); const r=JSON.parse(payload);
      if(this.receipts.has(r.mutationId)) return {...copy(this.receipts.get(r.mutationId)),replayed:true,access:this.access,snapshot:this.access==='active'?copy(this.value):null};
      if(this.access!=='active') throw code('SHARE_REVOKED');
      if(r.baseRevision!==this.value.revision||r.baseShareRevision!==this.value.shareRevision) throw code('SHARE_CONFLICT');
      this.value.claims=this.value.claims.filter(c=>c.claimantId!==r.claimantId);
      this.value.claims.push({...copy(r.claim),claimantId:r.claimantId,claimedAt:'2026-09-27T12:00:00Z'}); this.value.shareRevision++;
      const receipt={protocolVersion:1,...Object.fromEntries(['serverInstanceId','householdId','checkId','shareId','claimantId','mutationId'].map(k=>[k,r[k]])),
        committedShareRevision:this.value.shareRevision,replayed:false,access:'active',snapshot:copy(this.value)};
      this.receipts.set(r.mutationId,copy(receipt));
      if(this.lose) throw new Error('Lost response'); return receipt;
    }};
}
async function ready(options={}) {
  const store=options.store||new MemoryStore(),transport=options.transport||server();
  const client=new Client({token,store,transport,...options}); await client.open(); await client.refresh();
  return {client,store,transport};
}
async function prepare(client,name='Alex',itemIds=['soup']) {
  await client.edit({...client.form(),name,itemIds}); await client.prepare(); return client.row.pending.payload;
}

test('LAN-safe SHA-256 matches independent vectors, UTF-8 and block boundaries',()=>{
  for(const value of ['', 'abc', '💛 café 日本語', ...[55,56,63,64,65,1000].map(n=>'x'.repeat(n))])
    assert.equal(sha256(value),crypto.createHash('sha256').update(value).digest('hex'));
});

test('guest identity is durable, cryptographically random and scoped by token and proxy prefix',async()=>{
  const {client,store,transport}=await ready(); const key=client.row.key;
  const reopened=new Client({token,store,transport});await reopened.open(); assert.equal(reopened.row.key,key);
  const prefixed=new Client({token,prefix:'/hive',store,transport}); await prefixed.open(); assert.notEqual(prefixed.row.key,key);
  const other=new Client({token:token+'2',store,transport});await other.open();assert.notEqual(other.storageId,client.storageId);
  const missing=new Client({token,store:new MemoryStore(),transport,crypto:null});await assert.rejects(missing.open(),/identity is unavailable/);
  assert.equal(JSON.stringify([...store.rows.values()]).includes(token),false);
});

test('same-name guests and legacy selections never seed or overwrite another identity',async()=>{
  const transport=server();transport.value.claims.push({claimerName:'Alex',itemIds:['bread'],claimedAt:'legacy'});
  const a=(await ready({transport})).client,b=(await ready({transport})).client;
  assert.equal(a.form().name,'');await prepare(a);await a.submit();
  await b.refresh();assert.equal(b.form().name,'');await prepare(b);await b.submit();
  await a.refresh();await prepare(a,'Alex renamed',[]);await a.submit();
  assert.equal(transport.value.claims.length,3);
  assert.deepEqual(transport.value.claims.find(c=>c.claimantId===a.row.claimantId).itemIds,[]);
  assert.deepEqual(transport.value.claims.find(c=>c.claimantId===b.row.claimantId).itemIds,['soup']);
  assert.deepEqual(transport.value.claims.find(c=>!c.claimantId).itemIds,['bread']);
});

test('lost response persists immutable request across reopen and replays once after newer guests',async()=>{
  const {client,store,transport}=await ready();const payload=await prepare(client,' Alex ');transport.lose=true;
  await assert.rejects(client.submit(),/Lost/);await assert.rejects(client.edit({...client.form(),name:'Changed'}),/Retry/);
  await assert.rejects(client.discard(),/unknown/);assert.equal(client.row.pending.payload,payload);
  const b=(await ready({transport})).client;transport.lose=false;await prepare(b,'Other',['bread']);await b.submit();
  const reopened=new Client({token,store,transport});await reopened.open();const receipt=await reopened.submit();
  assert.equal(receipt.replayed,true);assert.equal(reopened.row.pending,null);assert.equal(reopened.row.draft,null);
  assert.equal(reopened.row.snapshot.claims.length,2);assert.equal(transport.receipts.size,2);
  assert.deepEqual(transport.sent.at(-1),transport.sent[0]);assert.equal(reopened.form().name,'Alex');
});

test('definite rejection keeps raw draft; removed items need explicit review; unrelated revision can advance',async()=>{
  const {client,transport}=await ready();await prepare(client,'  Alex  ');
  transport.value.revision++;transport.value.check.items=transport.value.check.items.filter(i=>i.id!=='soup');
  await assert.rejects(client.submit(),/SHARE_CONFLICT/);await client.refresh();assert.equal(client.needsReview(),true);
  assert.equal(client.form().name,'  Alex  ');assert.deepEqual(client.form().itemIds,['soup']);
  await assert.rejects(client.review(client.form()),/Remove unavailable/);
  await client.review({...client.form(),itemIds:['bread']});transport.value.revision++;await client.refresh();
  assert.equal(client.needsReview(),false);await client.prepare();
  assert.equal(JSON.parse(client.row.pending.payload).baseRevision,3);
  assert.equal(client.row.pending.draft.baseline.revision,3);await client.submit();assert.equal(client.row.draft,null);
});

test('concurrent tabs reject stale edits without losing either saved or in-memory choices',async()=>{
  const {client,store,transport}=await ready();const tab=new Client({token,store,transport});await tab.open();
  const form={...tab.form(),name:'Unsaved in second tab',itemIds:['bread']};
  await client.edit({...client.form(),name:'Saved first tab',itemIds:['soup']});
  await assert.rejects(tab.edit(form),/another tab/);assert.equal(JSON.parse(tab.recovery(form)).working.name,form.name);
  await tab.open();assert.equal(tab.form().name,'Saved first tab');assert.equal(tab.row.key,client.row.key);
});

test('storage failures roll back edits, preparation and receipt consumption',async()=>{
  const {client,store,transport}=await ready();const initial=copy(client.row);store.fail=true;
  await assert.rejects(client.edit({...client.form(),name:'Alex'}),/storage failure/);assert.deepEqual(client.row,initial);
  store.fail=false;await client.edit({...client.form(),name:'Alex',itemIds:['soup']});const draft=copy(client.row);
  store.fail=true;await assert.rejects(client.prepare(),/storage failure/);assert.deepEqual(client.row,draft);assert.equal(transport.sent.length,0);
  store.fail=false;await client.prepare();const pending=copy(client.row);store.fail=true;
  await assert.rejects(client.submit(),/storage failure/);assert.equal(transport.sent.length,0);
  store.fail=false;const send=transport.send.bind(transport);
  transport.send=async(...args)=>{const receipt=await send(...args);store.fail=true;return receipt;};
  await assert.rejects(client.submit(),/storage failure/);assert.deepEqual(client.row,pending);assert.equal(transport.receipts.size,1);
  store.fail=false;transport.send=send;await client.submit();assert.equal(client.row.pending,null);assert.equal(transport.receipts.size,1);
});

test('corrupt identity or request is retained without reset or network submission',async()=>{
  for(const damage of [r=>r.key='bad',r=>r.claimantId='0'.repeat(64),r=>r.pending.rejection='UNRECOGNIZED',
    r=>r.pending.draft.baseline.revision++,r=>{const p=JSON.parse(r.pending.payload);p.extra='unsafe';r.pending.payload=JSON.stringify(p);}]) {
    const {client,store,transport}=await ready();await prepare(client);const saved=store.rows.get(client.storageId);damage(saved);const before=copy(saved);
    const reopened=new Client({token,store,transport});await assert.rejects(reopened.open());assert.deepEqual(store.rows.get(client.storageId),before);
    assert.equal(transport.sent.length,0);
  }
});

test('a stale tab cannot submit a request rejected and discarded by another tab',async()=>{
  const {client,store,transport}=await ready();await prepare(client);
  const tab=new Client({token,store,transport});await tab.open();
  transport.value.revision++;await assert.rejects(tab.submit(),/SHARE_CONFLICT/);await tab.discard();
  const count=transport.sent.length;await assert.rejects(client.submit(),/another tab/);assert.equal(transport.sent.length,count);
});

test('forged receipts and impossible revisions retain the exact pending request',async()=>{
  for(const damage of [r=>r.mutationId='forged',r=>r.claimantId='0'.repeat(64),r=>r.committedShareRevision=1,
    r=>r.snapshot.claims[0].itemIds=[],r=>r.snapshot.revision++,r=>r.snapshot=null,r=>r.snapshot.shareId='0'.repeat(64)]) {
    const {client,transport}=await ready();const payload=await prepare(client);const send=transport.send.bind(transport);
    transport.send=async(...args)=>{const receipt=await send(...args);damage(receipt);return receipt;};
    await assert.rejects(client.submit());assert.equal(client.row.pending.payload,payload);assert.equal(client.row.draft.name,'Alex');
  }
});

test('refresh rejects identity switches, backwards and changed-without-revision snapshots',async()=>{
  for(const damage of [s=>s.serverInstanceId='different',s=>s.revision=0,s=>s.shareRevision=0,
    s=>s.check.items[0].price++,s=>s.claims.push({claimerName:'new',itemIds:[],claimedAt:'now'})]) {
    const {client,transport}=await ready();const previous=copy(client.row);damage(transport.value);
    await assert.rejects(client.refresh());assert.deepEqual(client.row,previous);
  }
});

test('revocation keeps unknown requests; exact replay can acknowledge without restoring access',async()=>{
  const {client,transport}=await ready();await prepare(client);transport.lose=true;await assert.rejects(client.submit());
  transport.access='revoked';await assert.rejects(client.refresh(),/SHARE_REVOKED/);assert.equal(client.row.access,'revoked');
  const receipt=await client.submit();assert.equal(receipt.snapshot,null);assert.equal(client.row.pending,null);assert.equal(client.row.access,'revoked');
  assert.deepEqual(client.form().itemIds,['soup']);assert.equal(client.form().name,'Alex');
  await assert.rejects(client.edit({...client.form(),name:'Changed'}));
});

test('late receipt cannot roll back fresher cached declarations or revive a revoked link',async()=>{
  const {client,store,transport}=await ready();await prepare(client);
  const send=transport.send.bind(transport);let release,started;
  const reached=new Promise(r=>started=r);transport.send=async(...args)=>{const receipt=await send(...args);started();await new Promise(r=>release=r);return receipt;};
  const pending=client.submit();await reached;
  const tab=new Client({token,store,transport});await tab.open();transport.value.shareRevision++;
  transport.value.claims.push({claimerName:'Later',itemIds:['bread'],claimedAt:'later',claimantId:'a'.repeat(64)});await tab.refresh();
  transport.access='revoked';await assert.rejects(tab.refresh());release();await pending;
  assert.equal(client.row.snapshot.shareRevision,3);assert.equal(client.row.snapshot.claims.length,2);
  assert.equal(client.row.access,'revoked');assert.equal(client.row.pending,null);
});

test('closed and unprotected checks cannot prepare; recovery export excludes private identity',async()=>{
  for(const modify of [s=>s.check.isCompleted=true,s=>s.revisionPreconditionsRequired=false]) {
    const transport=server();modify(transport.value);const {client}=await ready({transport});
    await client.edit({...client.form(),name:'Alex'});await assert.rejects(client.prepare(),/open, protected/);assert.equal(transport.sent.length,0);
  }
  const {client}=await ready();await prepare(client);const exported=client.recovery(client.form());
  assert.equal(exported.includes(token),false);assert.equal(exported.includes(client.row.key),false);
  assert.equal(JSON.parse(exported).pendingRequest.claim.claimerName,'Alex');
});

test('public snapshot refuses leaked owner data and duplicate guest identities',()=>{
  for(const modify of [s=>s.userId='private',s=>s.token=token,s=>s.check.items.push(s.check.items[0]),
    s=>s.claims=[1,2].map(()=>({claimerName:'Alex',claimedAt:'now',itemIds:[],claimantId:'a'.repeat(64)}))]) {
    const s=snapshot();modify(s);assert.throws(()=>validateSnapshot(s,sha256(token)));
  }
});

test('transport scopes requests, omits cookies, refuses redirects and classifies only definite server failures',async()=>{
  const calls=[];let response=new Response(JSON.stringify(snapshot()));
  const transport=new Transport(token,'/proxy/hive',async(...args)=>{calls.push(args);return response;});
  await transport.load();assert.equal(calls[0][0],'/proxy/hive/public/share/check/'+token+'/sync/snapshot');
  assert.equal(calls[0][1].credentials,'omit');assert.equal(calls[0][1].redirect,'error');assert.equal(calls[0][1].cache,'no-store');
  response=new Response('{}');await transport.send('exact bytes','secret');
  assert.equal(calls[1][1].body,'exact bytes');assert.equal(calls[1][1].headers['X-BillHive-Claimant-Key'],'secret');
  for(const prefix of ['//attacker','/../other','/hive/./other','https://other']) assert.throws(()=>new Transport(token,prefix));
  response=new Response('{"code":"SHARE_CONFLICT"}',{status:409});await assert.rejects(transport.load(),e=>e.code==='SHARE_CONFLICT');
  response=new Response('{"code":"SHARE_CONFLICT"}',{status:500});await assert.rejects(transport.load(),e=>e.code===undefined);
  response=new Response('null',{status:502});await assert.rejects(transport.load(),/could not be confirmed/);
});

test('transport rejects unreadable and bounded responses and cancels oversized streams',async()=>{
  for(const response of [new Response('not JSON'),new Response(new Uint8Array([255])),new Response(null,{status:204})]) {
    await assert.rejects(new Transport(token,'',async()=>response).load());
  }
  for(const length of [null,'9000']) {
    let cancelled=false;
    const body=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(9000));},cancel(){cancelled=true;}});
    const response=new Response(body,{status:500,headers:length?{'content-length':length}:{}});
    await assert.rejects(new Transport(token,'',async()=>response).load(),/too large/);assert.equal(cancelled,true);
  }
});
