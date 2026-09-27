'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Session=require('../public/check-owner-session');
const copy=structuredClone;
async function fixture(options={}) {
  const state={owner:{userId:'owner',serverInstanceId:'server',householdId:'house',revision:1},snapshot:{checkId:'dinner',revision:1,shareRevision:1,share:{token:'current'},revisionPreconditionsRequired:true},
    rows:new Map(),prepared:[],sent:[],before:0,confirmations:[],openError:null,listError:null};
  const factory=({owner,checkId})=>({owner:copy(owner),row:null,
    async open(){if(state.openError)throw Error(state.openError);const id=owner.userId+':'+checkId;this.row=state.rows.get(id)||{snapshot:copy(state.snapshot),pending:null};state.rows.set(id,this.row);},
    async list(){if(state.listError)throw Error(state.listError);return [...state.rows].filter(([id])=>id.startsWith(owner.userId+':')).map(([id,row])=>({checkId:id.split(':')[1],pendingKind:row.pending?'rotate':null}));},
    async refresh(){this.row.snapshot=copy(state.snapshot);},
    async prepare(kind,reviewed,loaded){state.prepared.push({kind,reviewed:copy(reviewed),loaded:copy(loaded)});this.row.pending={payload:'original bytes',rejection:null};},
    async submit(){if(!this.row.pending)throw Error('No pending action');state.sent.push(this.row.pending.payload);if(options.sendError)throw Error(options.sendError);this.row.pending=null;},
    async dismissRejected(){assert.ok(this.row.pending.rejection);this.row.pending=null;},
    recovery(){return JSON.stringify({pending:this.row.pending});}
  });
  const session=new Session({owner:()=>state.owner,clientFactory:factory,store:{},beforeAction:async()=>{state.before++;if(options.beforeError)throw Error(options.beforeError);},
    confirm:async(kind,snapshot)=>{state.confirmations.push({kind,snapshot});return options.confirm?options.confirm(state,session):true;}});
  await session.hydrate(state.owner);return {session,state};
}
test('canceling owner replacement settles the operation without preparing or sending',async()=>{
  const {session,state}=await fixture({confirm:()=>false});await session.change('dinner','rotate');assert.equal(session.busy,null);assert.equal(state.prepared.length,0);assert.equal(state.sent.length,0);assert.equal(state.confirmations.length,1);
});
test('new guest declarations during confirmation require another review and send nothing',async()=>{
  const {session,state}=await fixture({confirm:s=>{s.snapshot.shareRevision++;return true;}});assert.equal(await session.change('dinner','rotate'),false);
  assert.equal(state.prepared.length,0);assert.match(session.view('dinner').message,/changed during confirmation/);assert.equal(session.view('dinner').row.snapshot.shareRevision,2);
});
test('a changed public address at equal revisions also invalidates confirmation',async()=>{
  const {session,state}=await fixture({confirm:s=>{s.snapshot.shareUrl='https://new-address';return true;}});await session.change('dinner','revoke');assert.equal(state.sent.length,0);assert.match(session.view('dinner').message,/confirm again/);
});
test('owner identity change while confirming clears visible context and prevents transmission',async()=>{
  const {session,state}=await fixture({confirm:async(s,ui)=>{s.owner={...s.owner,userId:'another'};await ui.hydrate(s.owner);return true;}});await session.change('dinner','revoke');assert.equal(state.prepared.length,0);assert.equal(session.clients.size,0);assert.equal(session.messages.size,0);assert.equal(session.busy,null);
});
test('household-save failure blocks new link actions but never blocks retry of stored intent',async()=>{
  const {session,state}=await fixture({beforeError:'Unsaved household'});await session.change('dinner','create');assert.equal(state.sent.length,0);assert.match(session.view('dinner').message,/Unsaved/);
  session.view('dinner').row.pending={payload:'original bytes',rejection:null};assert.equal(await session.retry('dinner'),true);assert.deepEqual(state.sent,['original bytes']);assert.equal(state.before,1);
});
test('only one confirmation can be active; cancellation releases the next action',async()=>{
  let resolve,reached;const opened=new Promise(r=>reached=r);
  const {session,state}=await fixture({confirm:()=>{reached();return new Promise(r=>resolve=r);}});const first=session.change('dinner','rotate');await opened;
  assert.equal(await session.change('another','create'),false);resolve(false);await first;assert.equal(session.busy,null);assert.equal(state.prepared.length,0);
  await session.change('another','create');assert.equal(state.prepared.length,1);
});
test('unknown outcomes keep pending intent and remain exportable through the session',async()=>{
  const {session}=await fixture({sendError:'Lost response'});assert.equal(await session.change('dinner','create'),false);assert.equal(session.view('dinner').row.pending.payload,'original bytes');let exported;
  await session.export('dinner',value=>{exported=JSON.parse(value);});assert.equal(exported.pending.payload,'original bytes');assert.equal(session.listing[0].pendingKind,'rotate');
});
test('rejected action dismissal requires explicit confirmation; uncertain actions cannot be cleared',async()=>{
  const {session,state}=await fixture();await session.open('dinner');const row=session.view('dinner').row;row.pending={payload:'original',rejection:null};await session.dismiss('dinner');assert.ok(row.pending);assert.equal(state.confirmations.length,0);
  row.pending.rejection='SHARE_CONFLICT';await session.dismiss('dinner');assert.equal(row.pending,null);assert.equal(state.confirmations[0].kind,'dismiss');assert.equal(state.sent.length,0);
});
test('unreadable saved records and failed recovery listing do not trigger new actions',async()=>{
  const {session,state}=await fixture();state.openError='Retained unreadable record';state.listError='Storage unavailable';await session.change('dinner','create');assert.match(session.view('dinner').message,/Retained/);assert.equal(session.listError,'Storage unavailable');assert.equal(state.prepared.length,0);assert.equal(session.busy,null);
});
