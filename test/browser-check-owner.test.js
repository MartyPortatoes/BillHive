'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {Client,Transport,validateSnapshot,publicURL}=require('../public/check-owner-client');
const clone=structuredClone;
const owner={userId:'Owner@example.test',serverInstanceId:'server-1',householdId:'household-1',revision:1};
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const fail=code=>Object.assign(new Error(code),{code});
class Store {
  constructor(){this.rows=new Map();this.queue=Promise.resolve();this.fail=false;}
  transact(id,change){const next=this.queue.then(()=>{const value=change(clone(this.rows.get(id)));if(this.fail)throw new Error('Storage failure');this.rows.set(id,clone(value));return clone(value);});this.queue=next.catch(()=>{});return next;}
  async summaries(scope,select){return [...this.rows].filter(([id])=>id.startsWith(scope+':')).map(([id,value])=>{try{return select(id.slice(scope.length+1),clone(value));}catch{return {checkId:id.slice(scope.length+1),error:'Saved record unavailable'};}});}
}
function server(){
  return {snapshot:{...owner,checkId:'dinner',protocolVersion:1,shareRevision:0,checkExists:true,isCompleted:false,revisionPreconditionsRequired:true,share:null,shareUrl:null},
    receipts:new Map(),calls:[],lose:false,
    async load(){return clone(this.snapshot);},
    async send(payload){this.calls.push(payload);const r=JSON.parse(payload),s=this.snapshot;
      if(this.receipts.has(r.mutationId))return {...clone(this.receipts.get(r.mutationId)),replayed:true,snapshot:clone(s)};
      if(r.baseRevision!==s.revision||r.baseShareRevision!==s.shareRevision)throw fail('SHARE_CONFLICT');
      if(!s.revisionPreconditionsRequired)throw fail('PROTECTION_DISABLED');
      if(r.kind!=='revoke'&&!s.checkExists)throw fail('CHECK_NOT_FOUND');
      if(r.kind!=='revoke'&&s.isCompleted)throw fail('CHECK_COMPLETED');
      if(r.kind==='revoke'){if(s.share)s.shareRevision++;s.share=null;s.shareUrl=null;}
      else if(r.kind==='rotate'||!s.share){const token=crypto.randomBytes(24).toString('base64url');s.share={token,shareId:hash(token),createdAt:123,claims:[]};s.shareUrl='https://public.example/hive/share/'+token;s.shareRevision++;}
      const receipt={...owner,checkId:'dinner',protocolVersion:1,mutationId:r.mutationId,replayed:false,committedShareRevision:s.shareRevision,resultToken:s.share?.token||null,snapshot:clone(s)};
      this.receipts.set(r.mutationId,clone(receipt));if(this.lose)throw new Error('Lost response');return receipt;
    }};
}
async function ready(options={}){const store=options.store||new Store(),transport=options.transport||server();const client=new Client({owner,checkId:'dinner',store,transport,...options});await client.open();await client.refresh(owner);return {client,store,transport};}
async function prepare(client,kind='create',current=owner){await client.prepare(kind,clone(client.row.snapshot),current);return client.row.pending.payload;}

test('owner records are partitioned by signed-in account, server, household and API prefix',async()=>{
  const {client,store,transport}=await ready();await prepare(client);
  for(const changes of [{owner:{...owner,userId:'Other'}},{owner:{...owner,serverInstanceId:'server-2'}},{owner:{...owner,householdId:'household-2'}},{apiBase:'/proxy/api'}]){
    const other=new Client({owner,checkId:'dinner',store,transport,...changes});await other.open();assert.notEqual(other.id,client.id);assert.equal(other.row.pending,null);assert.equal((await other.list()).length,1);
  }
  const reopened=new Client({owner,checkId:'dinner',store,transport});await reopened.open();assert.deepEqual(reopened.row,client.row);
});

test('link create, no-op create, rotate and revoke validate receipts and leave household revision unchanged',async()=>{
  const {client,transport}=await ready();await prepare(client);await client.submit();const first=client.row.snapshot.share.token;
  await prepare(client);await client.submit();assert.equal(client.row.snapshot.share.token,first);assert.equal(client.row.snapshot.shareRevision,1);
  await prepare(client,'rotate');await client.submit();assert.notEqual(client.row.snapshot.share.token,first);assert.equal(client.row.snapshot.shareRevision,2);
  await prepare(client,'revoke');await client.submit();assert.equal(client.row.snapshot.share,null);
  await prepare(client,'revoke');await client.submit();assert.equal(client.row.snapshot.shareRevision,3);assert.equal(transport.snapshot.revision,1);
});

test('lost-response replay after newer rotation exposes only the current snapshot link',async()=>{
  const {client,store,transport}=await ready();const payload=await prepare(client);transport.lose=true;await assert.rejects(client.submit(),/Lost/);
  const original=transport.snapshot.share.token;
  const another=(await ready({transport})).client;transport.lose=false;await prepare(another,'rotate');await another.submit();
  const reopened=new Client({owner,checkId:'dinner',store,transport});await reopened.open();const receipt=await reopened.submit();
  assert.equal(receipt.resultToken,original);assert.notEqual(reopened.row.snapshot.share.token,original);
  assert.equal(reopened.row.snapshot.shareUrl,transport.snapshot.shareUrl);assert.equal(reopened.row.pending,null);
  assert.equal(transport.calls.at(-1),payload);assert.equal(transport.receipts.size,2);
});

test('completed and removed checks allow revocation but cannot create or replace links',async()=>{
  for(const exists of [true,false]){const transport=server();transport.snapshot.checkExists=exists;transport.snapshot.isCompleted=exists;const {client}=await ready({transport});
    await assert.rejects(prepare(client,'create'),/Reopen/);await assert.rejects(prepare(client,'rotate'),/Reopen/);await prepare(client,'revoke');await client.submit();}
});

test('new actions require exact reviewed snapshot, current household revision and protected writes',async()=>{
  const {client,transport}=await ready();const before=clone(client.row.snapshot);transport.snapshot.shareUrl=null;transport.snapshot.revisionPreconditionsRequired=false;
  await client.refresh(owner);await assert.rejects(client.prepare('create',before,owner),/Review/);await assert.rejects(prepare(client),/protected/);
  transport.snapshot.revisionPreconditionsRequired=true;await client.refresh(owner);await assert.rejects(prepare(client,'create',{...owner,revision:2}),/household changed/);
  await assert.rejects(prepare(client,'create',{...owner,userId:'other'}),/household changed/);assert.equal(transport.calls.length,0);
});

test('definite rejection retains request until explicit dismissal; uncertainty cannot be dismissed',async()=>{
  const {client,transport}=await ready();const payload=await prepare(client);await assert.rejects(client.dismissRejected(),/uncertain/);
  transport.snapshot.revision++;await assert.rejects(client.submit(),/SHARE_CONFLICT/);assert.equal(client.row.pending.payload,payload);
  assert.equal(client.row.pending.rejection,'SHARE_CONFLICT');await assert.rejects(client.submit(),/no uncertain/);
  await client.refresh({...owner,revision:2});await client.dismissRejected();await prepare(client,'create',{...owner,revision:2});assert.notEqual(client.row.pending.payload,payload);await client.submit();
});

test('corrupt rows are preserved; a list retains an unavailable recovery entry',async()=>{
  for(const change of [r=>r.generation=-1,r=>r.pending.payload='bad JSON',r=>r.pending.rejection='INVALID_CODE',r=>r.snapshot.householdId='other']){
    const {client,store,transport}=await ready();await prepare(client);const row=store.rows.get(client.id);change(row);const before=clone(row);
    const reopened=new Client({owner,checkId:'dinner',store,transport});await assert.rejects(reopened.open());assert.deepEqual(store.rows.get(client.id),before);
    assert.equal((await client.list())[0].checkId,'dinner');assert.ok((await client.list())[0].error);assert.equal(transport.calls.length,0);
  }
});

test('concurrent tabs reject stale preparation and stale retry after rejected action dismissal',async()=>{
  const {client,store,transport}=await ready();const tab=new Client({owner,checkId:'dinner',store,transport});await tab.open();await prepare(client);
  await assert.rejects(prepare(tab),/another tab/);await tab.open();transport.snapshot.revision++;await assert.rejects(tab.submit());await tab.dismissRejected();
  const count=transport.calls.length;await assert.rejects(client.submit(),/changed/);assert.equal(transport.calls.length,count);
});

test('storage failure prevents sending, or retains exact request if acknowledgement cannot commit',async()=>{
  const {client,store,transport}=await ready();const before=clone(client.row);store.fail=true;await assert.rejects(prepare(client),/Storage/);assert.deepEqual(client.row,before);
  store.fail=false;const payload=await prepare(client);store.fail=true;await assert.rejects(client.submit(),/Storage/);assert.equal(transport.calls.length,0);
  store.fail=false;const send=transport.send.bind(transport);transport.send=async(...args)=>{const receipt=await send(...args);store.fail=true;return receipt;};
  await assert.rejects(client.submit(),/Storage/);assert.equal(client.row.pending.payload,payload);assert.equal(transport.receipts.size,1);
  store.fail=false;transport.send=send;await client.submit();assert.equal(client.row.pending,null);assert.equal(transport.receipts.size,1);
});

test('receipt corruption never consumes a pending link action',async()=>{
  for(const damage of [r=>r.userId='other',r=>r.mutationId='other',r=>r.resultToken=null,r=>r.snapshot.share.token='different-link-token',r=>r.committedShareRevision=-1,r=>r.snapshot.revision++]){
    const {client,transport}=await ready();const payload=await prepare(client);const send=transport.send.bind(transport);transport.send=async(...args)=>{const receipt=await send(...args);damage(receipt);return receipt;};
    await assert.rejects(client.submit());assert.equal(client.row.pending.payload,payload);assert.equal(client.row.snapshot.share,null);
  }
});

test('fresh snapshots reject rollback and same-revision link or check changes',async()=>{
  for(const damage of [s=>s.serverInstanceId='other',s=>s.revision=0,s=>s.checkExists=false,s=>s.share.claims.push({claimerName:'Later',itemIds:[],claimedAt:'now'})]){
    const {client,transport}=await ready();await prepare(client);await client.submit();const before=clone(client.row);damage(transport.snapshot);
    await assert.rejects(client.refresh(owner));assert.deepEqual(client.row,before);
  }
});

test('late replay cannot undo a fresher cached URL or protection policy at equal revisions',async()=>{
  const {client,store,transport}=await ready();transport.lose=true;await prepare(client);await assert.rejects(client.submit());transport.lose=false;
  const send=transport.send.bind(transport);let release,started;const reached=new Promise(r=>started=r);
  transport.send=async(...args)=>{const receipt=await send(...args);started();await new Promise(r=>release=r);return receipt;};
  const submitting=client.submit();await reached;const tab=new Client({owner,checkId:'dinner',store,transport});await tab.open();
  transport.snapshot.shareUrl='https://changed.example/share/'+transport.snapshot.share.token;transport.snapshot.revisionPreconditionsRequired=false;await tab.refresh(owner);
  release();await submitting;assert.equal(client.row.snapshot.shareUrl,transport.snapshot.shareUrl);assert.equal(client.row.snapshot.revisionPreconditionsRequired,false);assert.equal(client.row.pending,null);
});

test('late receipts preserve newer sharing revisions and cannot resurrect a revoked link',async()=>{
  const {client,store,transport}=await ready();await prepare(client);const send=transport.send.bind(transport);let release,started;const reached=new Promise(r=>started=r);
  transport.send=async(...args)=>{const receipt=await send(...args);started();await new Promise(r=>release=r);return receipt;};
  const pending=client.submit();await reached;transport.snapshot.share=null;transport.snapshot.shareUrl=null;transport.snapshot.shareRevision++;
  const tab=new Client({owner,checkId:'dinner',store,transport});await tab.open();await tab.refresh(owner);release();await pending;
  assert.equal(client.row.snapshot.share,null);assert.equal(client.row.snapshot.shareRevision,2);assert.equal(client.row.pending,null);
});

test('public URLs must bind the current token; private link data never enters recovery exports',async()=>{
  const {client}=await ready();await prepare(client);await client.submit();const token=client.row.snapshot.share.token;
  for(const value of ['javascript:alert(1)','https://u:p@host/share/'+token,'https://host/share/'+token+'?x=1','https://host/share/other','https://host/%2e/share/'+token,'https://host/double//share/'+token])assert.throws(()=>publicURL(value,token));
  await prepare(client,'rotate');const output=client.recovery();assert.equal(output.includes(token),false);assert.equal(output.includes('https://public'),false);assert.equal(output.includes(owner.userId),false);
  assert.equal(JSON.parse(output).pendingRequest.kind,'rotate');assert.equal(publicURL('http://192.0.2.1/proxy/share/'+token,token),'http://192.0.2.1/proxy/share/'+token);
});

test('owner transport binds the expected proxy account, keeps cookie auth and refuses redirects',async()=>{
  const calls=[];let response=new Response('{}');const transport=new Transport({binding:{...owner,checkId:'dinner'},apiBase:'/hive/api',fetcher:async(...args)=>{calls.push(args);return response;}});
  await transport.load();assert.equal(calls[0][0],'/hive/api/share/check/dinner/sync/snapshot');assert.equal(calls[0][1].credentials,'same-origin');assert.equal(calls[0][1].redirect,'error');assert.equal(calls[0][1].headers['X-BillHive-User'],owner.userId);
  response=new Response('{}');await transport.send('original request');assert.equal(calls[1][1].body,'original request');assert.equal(calls[1][1].headers['X-BillHive-Require-Protection'],'1');
  response=new Response('{"code":"SHARE_CONFLICT"}',{status:409});await assert.rejects(transport.load(),e=>e.code==='SHARE_CONFLICT');
  response=new Response('{"code":"SHARE_CONFLICT"}',{status:500});await assert.rejects(transport.load(),e=>e.code===undefined);
  response=new Response('{}',{status:401});await assert.rejects(transport.load(),/same account/);
});

test('owner transport bounds responses and rejects invalid API paths and unreadable bodies',async()=>{
  for(const apiBase of ['https://remote/api','//remote/api','/../api','/api/'])assert.throws(()=>new Transport({binding:{...owner,checkId:'dinner'},apiBase}));
  for(const response of [new Response('not JSON'),new Response(null,{status:204}),new Response(new Uint8Array([255]))])await assert.rejects(new Transport({binding:{...owner,checkId:'dinner'},fetcher:async()=>response}).load());
  let cancelled=false;const response=new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(9000));},cancel(){cancelled=true;}}),{status:500});
  await assert.rejects(new Transport({binding:{...owner,checkId:'dinner'},fetcher:async()=>response}).load(),/too large/);assert.equal(cancelled,true);
});

test('snapshot shape preserves independent same-name legacy declarations and rejects duplicate native IDs',()=>{
  const s=server().snapshot,token='abcdefghijklmnopqrstuvwxyz';s.shareRevision=1;s.share={token,shareId:hash(token),createdAt:123,claims:[1,2].map(()=>({claimerName:'Alex',itemIds:['removed','removed'],claimedAt:'legacy'}))};
  assert.equal(validateSnapshot(s).share.claims.length,2);s.share.claims.forEach(c=>c.claimantId='a'.repeat(64));assert.throws(()=>validateSnapshot(s),/Repeated/);
});
