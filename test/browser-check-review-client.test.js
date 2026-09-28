'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {Client,Transport,baseline}=require('../public/check-review-client'),R=require('../public/check-claim-review');
const fixture=require('./fixtures/check-claim-review-parity.json').cases[0],copy=structuredClone,hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const fail=code=>Object.assign(new Error(code),{code});
class Store {
  constructor(){this.rows=new Map();this.queue=Promise.resolve();this.fail=false;}
  transact(key,change){const next=this.queue.then(()=>{const value=change(copy(this.rows.get(key)));if(this.fail)throw new Error('storage failed');this.rows.set(key,copy(value));return copy(value);});this.queue=next.catch(()=>{});return next;}
}
function server(){const token='abcdefghijklmnopqrstuvwxyz';return {
  owner:{protocolVersion:1,userId:'owner',serverInstanceId:'server',householdId:'household',revision:1,state:{people:[],checks:{checks:[copy(fixture.check)]},settings:{currencyCode:'USD'},futureState:{kept:true}},monthly:{'2026-09':{totals:{rent:0}}}},
  shareRevision:1,claims:[{claimerName:'Alex',claimantId:'a'.repeat(64),itemIds:['meal'],claimedAt:'2026-09-27T12:00:00.000Z'}],token,calls:[],receipts:new Map(),lose:false,
  async load(){return {owner:copy(this.owner),sharing:{protocolVersion:1,...Object.fromEntries(['userId','serverInstanceId','householdId','revision'].map(k=>[k,this.owner[k]])),checkId:'dinner',checkExists:true,isCompleted:false,revisionPreconditionsRequired:true,shareRevision:this.shareRevision,shareUrl:'https://example.test/share/'+this.token,share:{token:this.token,shareId:hash(this.token),createdAt:123,claims:copy(this.claims)}},capabilities:{checkShareGuardProtocol:1,revisionPreconditionsRequired:true}};},
  async send(payload){this.calls.push(payload);const r=JSON.parse(payload);
    if(this.receipts.has(r.mutationId))return {...copy(this.owner),mutationId:r.mutationId,committedRevision:this.receipts.get(r.mutationId),replayed:true};
    if(r.baseRevision!==this.owner.revision)throw fail('REVISION_CONFLICT');
    if(r.checkSharePreconditions[0].shareRevision!==this.shareRevision)throw fail('CHECK_SHARE_CONFLICT');
    this.owner.state=copy(r.state);this.owner.monthly=copy(r.monthly);this.owner.revision++;this.receipts.set(r.mutationId,this.owner.revision);
    if(this.lose)throw new Error('lost response');return {...copy(this.owner),mutationId:r.mutationId,committedRevision:this.owner.revision,replayed:false};
  }
};}
async function ready(){const transport=server(),store=new Store(),client=new Client({owner:transport.owner,store,transport});await client.open();const fresh=await transport.load();await client.start(fresh);
  const source=client.row.drafts.dinner.baseline.sources[0],plan=copy(fixture.plan);plan.choices={[R.sourceId(source)]:{action:'APPLY',participantId:'c'}};await client.edit('dinner',plan);return {client,store,transport};}
async function prepare(client,transport){await client.prepare('dinner',await transport.load(),client.preview('dinner'),true);return client.row.pending.payload;}
test('host baseline binds exact owner/share revisions and negotiated protection',async()=>{
  const transport=server(),fresh=await transport.load();const good=baseline(fresh.owner,fresh.sharing,fresh.capabilities);assert.equal(good.sources[0].claimedAt,'2026-09-27T12:00:00Z');assert.equal(JSON.stringify(good).includes(transport.token),false);
  for(const update of [f=>f.sharing.revision++,f=>f.owner.userId='other',f=>f.capabilities.checkShareGuardProtocol=0,f=>f.sharing.revisionPreconditionsRequired=false,f=>f.owner.state.checks.checks[0].isCompleted=true]){const f=copy(fresh);update(f);assert.throws(()=>baseline(f.owner,f.sharing,f.capabilities));}
});
test('prepared application preserves unrelated records and guards both revisions',async()=>{
  const {client,transport}=await ready(),before=copy(transport.owner);const payload=await prepare(client,transport),r=JSON.parse(payload);
  assert.equal(r.baseRevision,before.revision);assert.equal(r.checkSharePreconditions[0].shareRevision,transport.shareRevision);
  assert.deepEqual(r.monthly,before.monthly);assert.deepEqual(r.state.futureState,before.state.futureState);assert.deepEqual(r.state.checks.checks[0].futureField,{kept:true});
  await client.submit();assert.equal(client.row.pending,null);assert.equal(client.row.drafts.dinner,undefined);assert.equal(client.row.receipt.mutationId,r.mutationId);
  assert.deepEqual(transport.owner.state.checks.checks[0].items[0].sharedByParticipantIds,['a','b','c']);
});
test('unknown outcome survives reopen and replay retains a later household snapshot',async()=>{
  const {client,transport,store}=await ready();const payload=await prepare(client,transport);transport.lose=true;await assert.rejects(client.submit(),/lost/);
  assert.equal(client.row.pending.payload,payload);await assert.rejects(client.discard('dinner'),/uncertain/);await assert.rejects(client.edit('dinner',fixture.plan),/pending/);
  transport.owner.state.futureState={later:true};transport.owner.revision++;const reopened=new Client({owner:transport.owner,store,transport});await reopened.open();await reopened.submit();
  assert.equal(transport.calls.at(-1),payload);assert.equal(reopened.row.pending,null);assert.deepEqual(reopened.row.receipt.snapshot.state.futureState,{later:true});
});
test('sharing conflict keeps rejected request until explicit comparison and renewed review',async()=>{
  const {client,transport}=await ready();await prepare(client,transport);transport.shareRevision++;const before=copy(transport.owner);await assert.rejects(client.submit(),e=>e.code==='CHECK_SHARE_CONFLICT');assert.deepEqual(transport.owner,before);
  await assert.rejects(client.submit(),/uncertain/);await client.review('dinner',await transport.load(),true);assert.equal(client.row.pending,null);await prepare(client,transport);await client.submit();
});
test('fresh comparison blocks household or source changes even before transmission',async()=>{
  const {client,transport}=await ready();transport.owner.state.futureState={changed:true};transport.owner.revision++;await assert.rejects(prepare(client,transport),/changed/);assert.equal(transport.calls.length,0);
  await client.review('dinner',await transport.load(),true);const v=client.preview('dinner');v.after.totals.a='123';await assert.rejects(client.prepare('dinner',await transport.load(),v,true),/totals/);
});
test('backwards and contradictory equal revisions cannot replace a reviewed baseline',async()=>{
  const {client,transport}=await ready(),original=copy(client.row);
  for(const modify of [f=>f.owner.revision--,f=>f.sharing.shareRevision--,f=>f.owner.state.futureState={unexpected:true},f=>f.sharing.share.claims[0].claimerName='Contradictory']){
    const f=await transport.load();modify(f);await assert.rejects(async()=>client.review('dinner',f,true));assert.deepEqual(client.row,original);
  }
  const f=await transport.load();Object.assign(f.owner,{mutationId:'earlier-success',committedRevision:f.owner.revision,replayed:false});assert.equal(client.compare('dinner',f).changed,false);
});
test('draft choices and missing source records survive explicit baseline adoption',async()=>{
  const {client,transport}=await ready(),old=copy(client.row.drafts.dinner);transport.token='ABCDEFGHIJKLMNOPQRSTUVWXYZ';transport.shareRevision++;transport.claims=[];
  await client.review('dinner',await transport.load(),true);assert.deepEqual(client.row.drafts.dinner.plan,old.plan);assert.deepEqual(client.row.drafts.dinner.retainedSources,old.baseline.sources);assert.equal(client.preview('dinner').ready,false);
  await client.review('dinner',await transport.load(),false);assert.deepEqual(client.row.drafts.dinner.retainedSources,[]);assert.equal(client.preview('dinner').ready,true);
});
test('stale tabs cannot overwrite a draft or send a discarded rejected action',async()=>{
  const {client,transport,store}=await ready(),other=new Client({owner:transport.owner,store,transport});await other.open();const changed=copy(client.row.drafts.dinner.plan);changed.newParticipants[0].name='New raw text';await client.edit('dinner',changed);
  await assert.rejects(other.edit('dinner',fixture.plan),/another tab/);await prepare(client,transport);await other.open();transport.shareRevision++;await assert.rejects(client.submit());await client.discard('dinner');
  const calls=transport.calls.length;await assert.rejects(other.submit());assert.equal(transport.calls.length,calls);
});
test('storage failures before sending and during acknowledgement retain original records',async()=>{
  const {client,transport,store}=await ready(),saved=copy(client.row);store.fail=true;await assert.rejects(prepare(client,transport),/storage/);assert.deepEqual(store.rows.get(client.scope),saved);assert.equal(transport.calls.length,0);
  store.fail=false;const payload=await prepare(client,transport),send=transport.send.bind(transport);transport.send=async value=>{const result=await send(value);store.fail=true;return result;};await assert.rejects(client.submit(),/storage/);
  assert.equal(store.rows.get(client.scope).pending.payload,payload);store.fail=false;transport.send=send;await client.open();await client.submit();assert.equal(client.row.pending,null);
});
test('invalid receipts and unknown responses preserve pending requests',async()=>{
  for(const mutate of [r=>r.userId='another',r=>r.mutationId='mismatched',r=>r.committedRevision=0,r=>r.revision=0,r=>delete r.replayed]){
    const {client,transport}=await ready();const payload=await prepare(client,transport),send=transport.send.bind(transport);transport.send=async p=>{const r=await send(p);mutate(r);return r;};await assert.rejects(client.submit());assert.equal(client.row.pending.payload,payload);
  }
  const {client,transport}=await ready();await prepare(client,transport);transport.send=async()=>{throw fail('HOUSEHOLD_CHANGED');};await assert.rejects(client.submit());assert.equal(client.row.pending.rejection,null);
});
test('account partitions and corrupt records never replace original intent',async()=>{
  const {client,store,transport}=await ready();for(const changes of [{userId:'other'},{householdId:'other'},{serverInstanceId:'other'}]){const other=new Client({owner:{...transport.owner,...changes},store,transport});await other.open();assert.notEqual(other.scope,client.scope);assert.deepEqual(other.row.drafts,{});}
  const differentPath=new Client({owner:transport.owner,store,transport,apiBase:'/prefix/api'});assert.notEqual(differentPath.scope,client.scope);
  const saved=copy(store.rows.get(client.scope));saved.drafts.dinner.plan='corrupt';store.rows.set(client.scope,saved);await assert.rejects(client.open(),/original record is kept/);assert.deepEqual(store.rows.get(client.scope),saved);
});
test('recovery export contains review choices but excludes household tokens and unrelated private data',async()=>{
  const {client,transport}=await ready();transport.owner.state.checks.checks[0].shareToken=transport.token;transport.owner.state.privateCredentials={apiKey:'secret'};transport.owner.revision++;await client.review('dinner',await transport.load(),true);await prepare(client,transport);
  const working=copy(client.row.drafts.dinner.plan);working.newParticipants[0].name='  unsaved raw name  ';const exported=client.recovery('dinner',working),v=JSON.parse(exported);
  assert.equal(exported.includes(transport.token),false);assert.equal(exported.includes('secret'),false);assert.equal(exported.includes('apiKey'),false);assert.equal(v.workingPlan.newParticipants[0].name,'  unsaved raw name  ');assert.ok(v.pending.requestHash);
});
test('transport requires owner and protection headers, refuses redirects and recognizes only definite conflicts',async()=>{
  const transport=server(),calls=[],network=new Transport({binding:transport.owner,fetcher:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({code:'CHECK_SHARE_CONFLICT'}),{status:409});}});
  await assert.rejects(network.send('{}'),e=>e.code==='CHECK_SHARE_CONFLICT');assert.equal(calls[0].url,'/api/sync/commit');assert.equal(calls[0].options.headers['X-BillHive-User'],'owner');assert.equal(calls[0].options.headers['X-BillHive-Require-Protection'],'1');assert.equal(calls[0].options.redirect,'error');
});
