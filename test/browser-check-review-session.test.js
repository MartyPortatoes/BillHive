'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const Session=require('../public/check-review-session');
const {Client,R,copy,fixture,Store,server}=require('../tools/test-support/check-review.cjs');
const defer=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};
async function ready(options={}){const transport=server(),store=new Store();let owner=copy(transport.owner),commits=[];
  const s=new Session({owner:()=>owner,beforeApply:async()=>{},checkLinks:async()=>{},committed:async r=>commits.push(r),clientFactory:args=>new Client({...args,store,transport}),...options});
  await s.hydrate(owner);await s.open('dinner');const plan=copy(fixture.plan);plan.choices={[R.sourceId(s.draft.baseline.sources[0])]:{action:'APPLY',participantId:'c'}};s.edit(p=>Object.assign(p,plan));await s.queue;await s.calculateCurrent();
  return {s,transport,store,commits,setOwner:value=>{owner=value;}};
}
test('ordered raw edits retain the newest name and discard late preview results',async()=>{
  const {s}=await ready(),waits=[];s.calculate=draft=>{const d=defer();waits.push({d,draft});return d.promise;};
  s.edit(p=>{p.newParticipants[0].name=' First ';});s.edit(p=>{p.newParticipants[0].name=' Second ';});await s.queue;
  waits[1].d.resolve(require('../public/check-review-client').preview(waits[1].draft));await Promise.resolve();await Promise.resolve();const latest=copy(s.preview);
  waits[0].d.resolve(require('../public/check-review-client').preview(waits[0].draft));await Promise.resolve();await Promise.resolve();assert.deepEqual(s.preview,latest);assert.equal(s.draft.plan.newParticipants[0].name,' Second ');assert.equal(s.dirty,false);
});
test('failed draft storage keeps raw input, export and explicit saved reload',async()=>{
  const {s,store}=await ready();store.fail=true;s.edit(p=>{p.newParticipants[0].name='  Unsaved  ';});await s.queue;assert.equal(s.dirty,true);assert.equal(s.close(),false);assert.equal(JSON.parse(s.export()).workingPlan.newParticipants[0].name,'  Unsaved  ');
  store.fail=false;await s.reloadSaved();assert.equal(s.dirty,false);assert.equal(s.working.newParticipants[0].name,fixture.plan.newParticipants[0].name);
});
test('changed current data opens a comparison and clears prior payment confirmation',async()=>{
  const {s,transport}=await ready();s.confirmPaymentResets=true;transport.shareRevision++;await s.apply();assert.ok(s.comparison);assert.equal(s.confirmPaymentResets,false);assert.equal(transport.calls.length,0);
  await s.adopt(true);assert.equal(s.comparison,null);assert.equal(s.preview.ready,true);assert.equal(s.confirmPaymentResets,false);
});
test('a comparison that changes again cannot be adopted without another review',async()=>{
  const {s,transport}=await ready();transport.shareRevision++;await s.refresh();const old=copy(s.draft);transport.shareRevision++;assert.equal(await s.adopt(true),false);assert.match(s.error,/changed again/);assert.deepEqual(s.draft,old);assert.equal(s.comparison.fresh.sharing.shareRevision,transport.shareRevision);
});
test('unknown saves retain exact retry and block ordinary saves across a fresh journal read',async()=>{
  const {s,transport,commits}=await ready();s.confirmPaymentResets=true;transport.lose=true;await s.apply();const payload=s.pending.payload;assert.equal(s.editable,false);await assert.rejects(s.ordinaryWriteAllowed(),/Resolve/);
  await s.retry();assert.equal(transport.calls.at(-1),payload);assert.equal(s.pending,null);assert.equal(commits.length,1);assert.equal(s.draft,undefined);await s.ordinaryWriteAllowed();
});
test('ordinary household save failure prevents new split preparation but cannot block exact retry',async()=>{
  const {s,transport}=await ready();s.confirmPaymentResets=true;s.beforeApply=async()=>{throw new Error('ordinary edits not saved');};await s.apply();assert.equal(s.pending,null);assert.equal(transport.calls.length,0);
  s.beforeApply=async()=>{};transport.lose=true;await s.apply();s.beforeApply=async()=>{throw new Error('ordinary edits not saved');};await s.retry();assert.equal(s.pending,null);
});
test('pending link action prevents a new review application',async()=>{
  const {s,transport}=await ready();s.checkLinks=async()=>{throw new Error('saved link action');};s.confirmPaymentResets=true;await s.apply();assert.equal(transport.calls.length,0);assert.equal(s.pending,null);
});
test('existing draft can reopen without network and removed or completed records stay recoverable',async()=>{
  const {s,transport}=await ready(),original=copy(s.draft);s.close();transport.load=async()=>{throw new Error('offline');};await s.open('dinner');assert.deepEqual(s.draft,original);assert.ok(s.preview);
  const fresh=await server().load();fresh.owner.state.checks.checks[0].isCompleted=true;fresh.sharing.isCompleted=true;s.inspect(fresh);assert.equal(s.comparison.unavailable,true);assert.ok(s.export());
});
test('account changes while a request loads cannot prepare or publish into the new account',async()=>{
  const {s,transport,setOwner}=await ready(),wait=defer(),fresh=await transport.load();transport.load=()=>wait.promise;s.confirmPaymentResets=true;const applying=s.apply();await Promise.resolve();await Promise.resolve();await new Promise(r=>setImmediate(r));
  const next={...transport.owner,userId:'another'};setOwner(next);await s.hydrate(next);wait.resolve(fresh);await applying;assert.equal(s.activeId,null);assert.equal(transport.calls.length,0);assert.deepEqual(s.client.row.drafts,{});
});
test('an operation queued behind storage cannot start under a replacement account',async()=>{
  const {s,transport,setOwner}=await ready(),wait=defer();s.queue=wait.promise;const opening=s.open('dinner');const next={...transport.owner,userId:'another'};setOwner(next);await s.hydrate(next);wait.resolve();assert.equal(await opening,false);assert.equal(s.activeId,null);assert.deepEqual(s.client.row.drafts,{});
});
test('stale-tab storage conflict preserves on-screen raw choices until explicit reload',async()=>{
  const {s,transport,store}=await ready(),other=new Client({owner:transport.owner,store,transport});await other.open();const p=copy(s.working);p.newParticipants[0].name='Other tab';await other.edit('dinner',p);
  s.edit(p=>{p.newParticipants[0].name='This tab raw';});await s.queue;assert.equal(s.dirty,true);assert.equal(s.working.newParticipants[0].name,'This tab raw');await s.reloadSaved();assert.equal(s.working.newParticipants[0].name,'Other tab');
});
