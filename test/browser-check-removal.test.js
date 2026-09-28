'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {Client,copy,Store,server,ready:splitReady,prepare:prepareSplit}=require('../tools/test-support/check-review.cjs');
const Session=require('../public/check-removal-session'),SplitSession=require('../public/check-review-session');
async function ready(){const transport=server(),store=new Store(),load=transport.load.bind(transport);
  transport.load=async()=>{const f=await load(),c=f.owner.state.checks.checks.find(c=>c.id==='dinner');f.sharing.checkExists=!!c;f.sharing.isCompleted=!!c?.isCompleted;if(!c){f.sharing.share=null;f.sharing.shareUrl=null;f.sharing.shareRevision++;}return f;};
  const client=new Client({owner:transport.owner,store,transport});await client.open();await client.startRemoval(await transport.load());return {client,transport,store};
}
async function prepare(f){await f.client.confirmRemoval('dinner',true);await f.client.prepareRemoval('dinner',await f.transport.load());return f.client.row.pending.payload;}
test('deletion requires durable confirmation and removes only the reviewed check from latest data',async()=>{
  const f=await ready();await assert.rejects(f.client.prepareRemoval('dinner',await f.transport.load()),/Confirm/);assert.equal(f.transport.calls.length,0);
  f.transport.owner.state.futureState={newer:true};f.transport.owner.state.checks.futureContainer={keep:1};f.transport.owner.state.checks.checks.push({id:'other',unknown:{keep:2}});f.transport.owner.monthly['2026-10']={totals:{x:8}};f.transport.owner.revision++;
  const before=copy(f.transport.owner),payload=JSON.parse(await prepare(f));assert.equal(payload.baseRevision,before.revision);assert.deepEqual(payload.monthly,before.monthly);assert.deepEqual(payload.state.checks,{futureContainer:{keep:1},checks:[{id:'other',unknown:{keep:2}}]});assert.deepEqual(payload.state.futureState,{newer:true});
  await f.client.submit();assert.equal(f.client.row.removals.dinner,undefined);assert.equal(f.client.row.receipt.kind,'removal');
});
test('completed and uncalculable checks can be reviewed for deletion without changing their wire data',async()=>{
  const f=await ready();await f.client.discardRemoval('dinner');Object.assign(f.transport.owner.state.checks.checks[0],{isCompleted:true,claimApplications:{futureUnsupported:true},taxAmount:'not calculable'});f.transport.owner.revision++;
  await f.client.startRemoval(await f.transport.load());await prepare(f);await f.client.submit();assert.equal(f.transport.owner.state.checks.checks.length,0);
});
test('check, unknown-field, currency and sharing changes require explicit comparison and renewed confirmation',async()=>{
  for(const change of [f=>{f.transport.owner.state.checks.checks[0].name='New name';f.transport.owner.revision++;},f=>{f.transport.owner.state.checks.checks[0].futureField={changed:true};f.transport.owner.revision++;},f=>{f.transport.owner.state.settings.currencyCode='KWD';f.transport.owner.revision++;},f=>{f.transport.shareRevision++;}]){
    const f=await ready();await f.client.confirmRemoval('dinner',true);change(f);await assert.rejects(f.client.prepareRemoval('dinner',await f.transport.load()),/changed/);
    assert.equal(f.transport.calls.length,0);await f.client.reviewRemoval('dinner',await f.transport.load());assert.equal(f.client.row.removals.dinner.confirmed,false);
  }
});
test('backward and contradictory snapshots cannot replace a deletion review',async()=>{
  for(const change of [f=>{f.owner.revision--;f.sharing.revision--;},f=>f.sharing.shareRevision--,f=>f.owner.state.futureState={changed:true},f=>f.sharing.share.claims[0].claimerName='Changed']){
    const f=await ready(),fresh=await f.transport.load(),saved=copy(f.client.row);change(fresh);await assert.rejects(async()=>f.client.reviewRemoval('dinner',fresh));assert.deepEqual(f.client.row,saved);
  }
});
test('removed check and invalid identity cannot be silently adopted or deleted again',async()=>{
  const f=await ready();await f.client.confirmRemoval('dinner',true);f.transport.owner.state.checks.checks=[];f.transport.owner.revision++;const fresh=await f.transport.load();assert.equal(f.client.compareRemoval('dinner',fresh).missing,true);await assert.rejects(async()=>f.client.reviewRemoval('dinner',fresh),/removed/);
  fresh.owner.userId='other';await assert.rejects(async()=>f.client.prepareRemoval('dinner',fresh));assert.equal(f.transport.calls.length,0);
});
test('one financial queue prevents conflicting split and deletion prepares and preserves other drafts on acknowledgement',async()=>{
  const f=await splitReady();await f.client.startRemoval(await f.transport.load());const split=copy(f.client.row.drafts.dinner);await prepare(f);await assert.rejects(prepareSplit(f.client,f.transport),/pending/);
  await f.client.submit();assert.deepEqual(f.client.row.drafts.dinner,split);assert.equal(f.client.row.removals.dinner,undefined);
  const other=await splitReady();await other.client.startRemoval(await other.transport.load());await prepareSplit(other.client,other.transport);await assert.rejects(other.client.prepareRemoval('dinner',await other.transport.load()),/saved financial/);await other.client.submit();assert.ok(other.client.row.removals.dinner);
});
test('deletion rejection can only be released through its own review or explicit discard',async()=>{
  const f=await splitReady();await f.client.startRemoval(await f.transport.load());await prepare(f);f.transport.shareRevision++;await assert.rejects(f.client.submit());
  await assert.rejects(f.client.discard('dinner'),/uncertain/);await assert.rejects(f.client.review('dinner',await f.transport.load(),true),/pending/);
  await f.client.reviewRemoval('dinner',await f.transport.load());assert.equal(f.client.row.pending,null);assert.equal(f.client.row.removals.dinner.confirmed,false);assert.ok(f.client.row.drafts.dinner);
});
test('lost deletion response survives reopen and keeps a newer restoration during exact replay',async()=>{
  const f=await ready(),payload=await prepare(f);f.transport.lose=true;await assert.rejects(f.client.submit(),/lost/);await assert.rejects(f.client.discardRemoval('dinner'),/uncertain/);
  f.transport.owner.state.checks.checks=[{id:'dinner',name:'Restored later',items:[],participants:[]}];f.transport.owner.revision++;
  const reopened=new Client({owner:f.transport.owner,store:f.store,transport:f.transport});await reopened.open();await reopened.submit();assert.equal(f.transport.calls.at(-1),payload);assert.equal(reopened.row.receipt.snapshot.state.checks.checks[0].name,'Restored later');
});
test('failed prepare or acknowledgement never loses original intent or transmits before durable storage',async()=>{
  const f=await ready();await f.client.confirmRemoval('dinner',true);const saved=copy(f.client.row);f.store.fail=true;await assert.rejects(f.client.prepareRemoval('dinner',await f.transport.load()),/storage/);assert.deepEqual(f.store.rows.get(f.client.scope),saved);assert.equal(f.transport.calls.length,0);
  f.store.fail=false;const payload=await prepare(f),send=f.transport.send.bind(f.transport);f.transport.send=async p=>{const r=await send(p);f.store.fail=true;return r;};await assert.rejects(f.client.submit(),/storage/);assert.equal(f.store.rows.get(f.client.scope).pending.payload,payload);f.store.fail=false;f.transport.send=send;await f.client.open();await f.client.submit();assert.equal(f.client.row.pending,null);
});
test('stale tabs and corrupt deletion records preserve the saved journal',async()=>{
  const f=await ready(),other=new Client({owner:f.transport.owner,store:f.store,transport:f.transport});await other.open();await f.client.confirmRemoval('dinner',true);await assert.rejects(other.confirmRemoval('dinner',false),/another tab/);
  const saved=copy(f.store.rows.get(f.client.scope));saved.removals.dinner.confirmed='corrupt';f.store.rows.set(f.client.scope,saved);await assert.rejects(f.client.open(),/original record/);assert.deepEqual(f.store.rows.get(f.client.scope),saved);
});
test('deletion recovery omits bearer credentials, unknown private fields and full immutable requests',async()=>{
  const f=await ready();await f.client.discardRemoval('dinner');Object.assign(f.transport.owner.state.checks.checks[0],{shareToken:f.transport.token,futureCredentials:{apiKey:'secret-value'}});f.transport.owner.state.privateAccount='private-value';f.transport.owner.revision++;await f.client.startRemoval(await f.transport.load());await prepare(f);
  const text=f.client.removalRecovery('dinner',false),v=JSON.parse(text);for(const value of [f.transport.token,'secret-value','private-value','payload'])assert.equal(text.includes(value),false);assert.equal(v.confirmed,true);assert.equal(v.workingConfirmation,false);assert.ok(v.pending.requestHash);
});
test('sharing cleanup is durable across receipt replacement and requires its exact saved proof',async()=>{
  const f=await ready();await prepare(f);await f.client.submit();const first=copy(f.client.row.removedSharing.dinner);
  f.transport.owner.state.checks.checks.push({id:'second',name:'Second check',items:[],participants:[]});f.transport.owner.revision++;
  const fresh=await f.transport.load();Object.assign(fresh.sharing,{checkId:'second',checkExists:true,shareRevision:f.transport.shareRevision,share:null,shareUrl:null});
  await f.client.startRemoval(fresh);await f.client.confirmRemoval('second',true);await f.client.prepareRemoval('second',fresh);await f.client.submit();assert.equal(f.client.row.receipt.checkId,'second');assert.deepEqual(f.client.row.removedSharing.dinner,first);
  const reopened=new Client({owner:f.transport.owner,store:f.store,transport:f.transport});await reopened.open();await assert.rejects(reopened.finishSharingCleanup('dinner',{...first,revision:first.revision+1}),/changed/);
  f.store.fail=true;await assert.rejects(reopened.finishSharingCleanup('dinner',first),/storage/);assert.deepEqual(f.store.rows.get(reopened.scope).removedSharing.dinner,first);f.store.fail=false;await reopened.finishSharingCleanup('dinner',first);assert.equal(reopened.row.removedSharing.dinner,undefined);assert.ok(reopened.row.removedSharing.second);
});
async function sessionReady(){const f=await ready();let owner=copy(f.transport.owner);const commits=[];const s=new Session({owner:()=>owner,beforeApply:async()=>{},checkLinks:async()=>{},committed:async r=>commits.push(r),clientFactory:args=>new Client({...args,store:f.store,transport:f.transport})});await s.hydrate(owner);await s.open('dinner');return {...f,s,commits,setOwner:v=>owner=v};}
test('deletion confirmation survives offline reopening and failed storage retains the working choice',async()=>{
  const f=await sessionReady();f.s.setConfirmation(true);await f.s.queue;f.s.close();const load=f.transport.load;f.transport.load=async()=>{throw Error('offline');};assert.equal(await f.s.open('dinner'),true);assert.equal(f.s.working,true);f.transport.load=load;
  f.store.fail=true;f.s.setConfirmation(false);await f.s.queue;assert.equal(f.s.dirty,true);assert.equal(f.s.close(),false);assert.equal(JSON.parse(f.s.export()).workingConfirmation,false);f.store.fail=false;await f.s.reloadSaved();assert.equal(f.s.working,true);
});
test('deletion session compares changes again before adoption and resets confirmation',async()=>{
  const f=await sessionReady();f.s.setConfirmation(true);await f.s.queue;f.transport.shareRevision++;await f.s.apply();assert.ok(f.s.comparison);assert.equal(f.transport.calls.length,0);f.transport.shareRevision++;assert.equal(await f.s.adopt(),false);assert.match(f.s.error,/changed again/);await f.s.adopt();assert.equal(f.s.working,false);assert.equal(f.s.draft.confirmed,false);
});
test('new deletion respects ordinary and link saves; exact retry bypasses those preparation checks',async()=>{
  const f=await sessionReady();f.s.setConfirmation(true);await f.s.queue;f.s.checkLinks=async()=>{throw Error('unfinished link');};assert.equal(await f.s.apply(),false);assert.equal(f.transport.calls.length,0);f.s.checkLinks=async()=>{};f.s.beforeApply=async()=>{throw Error('ordinary edits');};await f.s.apply();assert.equal(f.transport.calls.length,0);f.s.beforeApply=async()=>{};
  f.transport.lose=true;await f.s.apply();await assert.rejects(f.s.ordinaryWriteAllowed(),/Resolve/);const original=f.s.pending.payload;f.s.beforeApply=async()=>{throw Error('ordinary edits');};await f.s.retry();assert.equal(f.transport.calls.at(-1),original);assert.equal(f.commits.length,1);
});
test('account changes during deletion load cannot prepare under the replacement identity',async()=>{
  const f=await sessionReady();f.s.setConfirmation(true);await f.s.queue;let resolve;const fresh=await f.transport.load();f.transport.load=()=>new Promise(r=>resolve=r);const saving=f.s.apply();await new Promise(r=>setImmediate(r));const other={...f.transport.owner,userId:'other'};f.setOwner(other);await f.s.hydrate(other);resolve(fresh);await saving;assert.equal(f.s.activeId,null);assert.equal(f.transport.calls.length,0);
});
test('split session cannot accidentally retry a deletion after another tab prepares it',async()=>{
  const f=await ready();await prepare(f);const split=new SplitSession({owner:()=>f.transport.owner,beforeApply:async()=>{},checkLinks:async()=>{},committed:async()=>{},clientFactory:args=>new Client({...args,store:f.store,transport:f.transport})});await split.hydrate(f.transport.owner);assert.equal(await split.open('dinner'),false);assert.equal(await split.retry(),false);assert.equal(f.transport.calls.length,0);
});
