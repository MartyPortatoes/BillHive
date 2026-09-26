'use strict';
const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const {SyncStore} = require('../sync-store');
let dir, base, child;
const proxy = {'remote-user':'sync-owner'};
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(),'selfhive-sync-'));
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0,'127.0.0.1',resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath,['server.js'], {cwd:path.join(__dirname,'..'),env:{...process.env,
    HOST:'127.0.0.1',PORT:String(port),DB_PATH:path.join(dir,'test.db'),TRUST_PROXY:'0',TRUSTED_AUTH_HEADERS:'remote-user',SYNC_REQUIRE_PRECONDITIONS:'1'},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject) => {
    const timer = setTimeout(()=>reject(new Error('Sync fixture did not start')),10000);
    child.stdout.on('data',chunk=>{if(String(chunk).includes('running on')) {clearTimeout(timer);resolve();}});
    child.on('exit',code=>{clearTimeout(timer);reject(new Error('Sync fixture exited '+code));});
  });
});
after(async () => { if(child?.exitCode == null) {child.kill();await new Promise(resolve=>child.once('exit',resolve));} fs.rmSync(dir,{recursive:true,force:true}); });
async function request(url,{method='GET',body,headers=proxy}={}) {
  return fetch(base+url,{method,headers:{...(body===undefined?{}:{'content-type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
}
async function snapshot(headers=proxy) { const response=await request('/api/sync/snapshot',{headers}); assert.equal(response.status,200);return {data:await response.json(),etag:response.headers.get('etag')}; }
function commitBody(snapshot,patch={}) { return {serverInstanceId:snapshot.serverInstanceId,householdId:snapshot.householdId,baseRevision:snapshot.revision,mutationId:crypto.randomUUID(),state:{},monthly:{},...patch}; }
async function commit(body,headers=proxy) { return request('/api/sync/commit',{method:'POST',headers,body}); }

// Each test reads a fresh baseline; distinct household IDs are also covered explicitly below.
test('atomic snapshot and commit preserve unknown keys, write state/months together and reject stale snapshots',async()=>{
  const health=await (await request('/api/health')).json(); assert.equal(health.capabilities.syncProtocol,1);assert.equal(health.capabilities.revisionPreconditionsRequired,true);
  const first=await snapshot();
  const mutation=commitBody(first.data,{state:{settings:{currencyCode:'USD'},futureData:{nested:'keep'},people:[{id:'me',name:'Me'}]},monthly:{'2026-09':{totals:{rent:1200},amounts:{}}}});
  const response=await commit(mutation);assert.equal(response.status,200);
  const result=await response.json();assert.ok(result.revision>first.data.revision);assert.equal(result.committedRevision,result.revision);assert.equal(result.replayed,false);
  assert.equal(result.state.futureData.nested,'keep');assert.equal(result.monthly['2026-09'].totals.rent,1200);
  assert.equal(response.headers.get('etag'),(await snapshot()).etag);
  const stale=await commit(commitBody(first.data,{state:{people:[]}}));assert.equal(stale.status,409);assert.equal((await stale.json()).code,'REVISION_CONFLICT');
  assert.deepEqual((await snapshot()).data,resultWithoutReceipt(result));
});
function resultWithoutReceipt(result) { const {mutationId,committedRevision,replayed,...snapshot}=result;return snapshot; }

test('lost-response retry is idempotent even after another commit; mutation-ID reuse cannot change data',async()=>{
  const original=await snapshot();const body=commitBody(original.data,{state:{settings:{currencyCode:'EUR'}}});
  const first=await (await commit(body)).json();
  const next=commitBody(first,{state:{webPreferences:{themePref:'dark'}}});assert.equal((await commit(next)).status,200);
  const beforeRetry=await snapshot();
  const replay=await (await commit(body)).json();assert.equal(replay.replayed,true);assert.equal(replay.committedRevision,first.committedRevision);assert.equal(replay.revision,beforeRetry.data.revision);
  assert.equal(replay.state.webPreferences.themePref,'dark');assert.equal((await snapshot()).etag,beforeRetry.etag);
  const reused=await commit({...body,state:{settings:{currencyCode:'JPY'}}});assert.equal(reused.status,409);assert.equal((await reused.json()).code,'MUTATION_ID_REUSED');
});

test('only one of two writers with the same baseline can commit',async()=>{
  const base=await snapshot();
  const responses=await Promise.all([commit(commitBody(base.data,{state:{winner:{value:1}}})),commit(commitBody(base.data,{state:{winner:{value:2}}}))]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
});

test('validation and explicit deletion are atomic; omitted state/months are retained',async()=>{
  const before=await snapshot();
  for(const patch of [{monthly:{'2026-13':{}}},{state:{people:'bad'}},{deleteStateKeys:['__proto__']},{deleteMonths:['2026-09'],monthly:{'2026-09':{}}},{unexpected:true}]) {
    assert.equal((await commit(commitBody(before.data,patch))).status,400);
    assert.equal((await snapshot()).etag,before.etag);
  }
  const result=await (await commit(commitBody(before.data,{deleteStateKeys:['winner'],deleteMonths:['2026-09']}))).json();
  assert.equal(result.state.winner,undefined);assert.equal(result.monthly['2026-09'],undefined);assert.equal(result.state.futureData.nested,'keep');
});

test('household identity and receipts are isolated by authenticated user',async()=>{
  const alice=await snapshot();const bobHeaders={'remote-user':'other-owner'};const bob=await snapshot(bobHeaders);
  assert.notEqual(alice.data.householdId,bob.data.householdId);
  const wrong=await commit(commitBody(alice.data,{state:{people:[]}}),bobHeaders);assert.equal(wrong.status,409);assert.equal((await wrong.json()).code,'HOUSEHOLD_CHANGED');
  const sharedId=crypto.randomUUID();assert.equal((await commit(commitBody(alice.data,{mutationId:sharedId,state:{ownerOnly:{value:'alice'}}}))).status,200);
  assert.equal((await commit(commitBody(bob.data,{mutationId:sharedId,state:{ownerOnly:{value:'bob'}}}),bobHeaders)).status,200);
  assert.equal((await snapshot()).data.state.ownerOnly.value,'alice');assert.equal((await snapshot(bobHeaders)).data.state.ownerOnly.value,'bob');
  const replaced=await commit({...commitBody((await snapshot()).data),serverInstanceId:crypto.randomUUID()});assert.equal(replaced.status,409);
});

test('every legacy JSON mutation requires a precondition in strict mode and advances the stream',async()=>{
  const operations=[
    ['/api/state','PUT',{people:[{id:'me',name:'Owner'}],bills:[]}],
    ['/api/state/requestDates','PATCH',{'2026-09':{me:'2026-09-26'}}],
    ['/api/months/2026-09','PUT',{totals:{rent:900},amounts:{}}],
    ['/api/months/2026-09','DELETE',undefined],
    ['/api/import','POST',{state:{settings:{currencyCode:'USD'}},monthly:{'2026-09':{totals:{rent:1000}}}}],
    ['/api/reset-setup','POST',undefined],
  ];
  for (const [url,method,body] of operations) {
    const before=await snapshot();
    assert.equal((await request(url,{method,body})).status,428,url);
    assert.equal((await request(url,{method,body,headers:{...proxy,'if-match':'"wrong"'}})).status,409,url);
    assert.equal((await snapshot()).etag,before.etag);
    const response=await request(url,{method,body,headers:{...proxy,'if-match':before.etag}});assert.equal(response.status,200,url);
    assert.ok((await snapshot()).data.revision>before.data.revision,url);
    assert.equal(response.headers.get('etag'),(await snapshot()).etag,url);
  }
});

test('guest expense/delete/settlement writes share the owner revision and stale owner saves cannot erase them',async()=>{
  const base=await snapshot();
  const trip={id:'trip',name:'Weekend',members:[{id:'member',name:'Guest'}],expenses:[],settlements:[]};
  assert.equal((await commit(commitBody(base.data,{state:{trips:{trips:[trip]}}}))).status,200);
  const invite=await (await request('/api/trips/trip/invite',{method:'POST',body:{memberId:'member'}})).json();
  assert.equal((await request(`/public/trip/invite/${invite.token}/join`,{method:'POST',headers:{}})).status,200);
  const prefix=`/public/trip/invite/${invite.token}`;
  let before=await snapshot();
  const publicRead=await request(prefix+'/trip',{headers:{}});assert.equal(publicRead.headers.get('etag'),before.etag);
  const expense={id:'expense',name:'Lunch',amount:10,paidByAmounts:{member:10},splitBetweenIds:['member']};
  assert.equal((await request(prefix+'/expense',{method:'POST',headers:{},body:expense})).status,428);
  assert.equal((await request(prefix+'/expense',{method:'POST',headers:{'if-match':before.etag},body:expense})).status,200);
  assert.equal((await commit(commitBody(before.data,{state:{trips:{trips:[trip]}}}))).status,409);
  const settlement={id:'settlement',fromMemberId:'member',toMemberId:'member',amount:1};
  before=await snapshot();assert.equal((await request(prefix+'/settlement',{method:'POST',headers:{'if-match':before.etag},body:settlement})).status,200);
  before=await snapshot();assert.equal((await request(prefix+'/expense/expense',{method:'DELETE',headers:{'if-match':before.etag}})).status,200);
  const final=(await snapshot()).data.state.trips.trips[0];assert.equal(final.expenses.length,0);assert.equal(final.settlements.length,1);
});

test('persisted corrupt snapshots are never replaced by a commit',async()=>{
  const headers={'remote-user':'corrupt-sync'};const before=await snapshot(headers);
  const db=new Database(path.join(dir,'test.db'));
  try {
    db.prepare('INSERT INTO user_state(user_id,key,value) VALUES (?,?,?)').run('corrupt-sync','settings','broken-json');
    const metadata=db.prepare('SELECT revision FROM sync_revisions WHERE user_id=?').get('corrupt-sync');
    const result=await commit({...commitBody(before.data,{state:{settings:{}}}),baseRevision:metadata.revision},headers);
    assert.equal(result.status,500);assert.equal(db.prepare('SELECT value FROM user_state WHERE user_id=?').get('corrupt-sync').value,'broken-json');
    assert.equal((await request('/api/sync/snapshot',{headers})).status,500);
  } finally {db.close();}
});

test('revisions and receipts survive reopen, detect writes from other connections and roll back at safe integer overflow',()=>{
  const db=new Database(path.join(dir,'test.db'));const sync=new SyncStore(db);
  try {
    const before=sync.snapshot('reopen');const body=commitBody(before,{state:{settings:{currencyCode:'USD'}}});
    const committed=sync.commit('reopen',body);
    const second=new Database(path.join(dir,'test.db'));
    try {
      const reopened=new SyncStore(second);assert.equal(reopened.instanceId,sync.instanceId);assert.equal(reopened.commit('reopen',body).replayed,true);
      second.prepare('INSERT OR REPLACE INTO monthly_data(user_id,month_key,data) VALUES (?,?,?)').run('reopen','2026-09','{}');
      assert.ok(sync.snapshot('reopen').revision>committed.revision);
      assert.throws(()=>sync.commit('reopen',commitBody(committed,{state:{people:[]}})),error=>error.code==='REVISION_CONFLICT');
      second.prepare('UPDATE sync_revisions SET revision=? WHERE user_id=?').run(Number.MAX_SAFE_INTEGER,'reopen');
      const last=sync.snapshot('reopen');
      assert.throws(()=>sync.commit('reopen',commitBody(last,{state:{settings:{currencyCode:'EUR'}}})));
      assert.deepEqual(sync.snapshot('reopen'),last);
    } finally {second.close();}
  } finally {db.close();}
});

const RevisionClient = require('../public/revision-client');
test('web revision client retries the exact lost-response request before sending a newer immutable snapshot',async()=>{
  const headers={'remote-user':'web-retry'};
  const initial=(await snapshot(headers)).data;let loseResponse=true;const sent=[];
  const client=new RevisionClient(async body=>{
    sent.push(structuredClone(body));const response=await commit(body,headers);assert.equal(response.status,200);
    const result=await response.json();if(loseResponse){loseResponse=false;throw new Error('Simulated response loss');}return result;
  });
  client.load(initial);
  const first={state:{settings:{currencyCode:'USD'}},monthly:{'2026-09':{totals:{rent:100},amounts:{}}}};
  await assert.rejects(client.sendSnapshot(first));
  first.monthly['2026-09'].totals.rent=200;
  await client.sendSnapshot(first);
  assert.equal(sent.length,3);assert.deepEqual(sent[0],sent[1]);assert.notEqual(sent[1].mutationId,sent[2].mutationId);
  assert.equal(sent[0].monthly['2026-09'].totals.rent,100);assert.equal(sent[2].monthly['2026-09'].totals.rent,200);
  assert.equal((await snapshot(headers)).data.monthly['2026-09'].totals.rent,200);
});

test('web replay after an intervening edit blocks newer stale writes without erasing the other device',async()=>{
  const headers={'remote-user':'web-concurrent'};const initial=(await snapshot(headers)).data;let loseResponse=true;let count=0;
  const client=new RevisionClient(async body=>{
    count++;const response=await commit(body,headers);assert.equal(response.status,200);const result=await response.json();
    if(loseResponse){loseResponse=false;throw new Error('Simulated lost response');}return result;
  });
  client.load(initial);const local={state:{people:[{id:'me',name:'First edit'}]},monthly:{}};
  await assert.rejects(client.sendSnapshot(local));
  const other=(await snapshot(headers)).data;assert.equal((await commit(commitBody(other,{state:{people:[{id:'me',name:'Other device'}]}}),headers)).status,200);
  local.state.people[0].name='Newer local draft';
  await assert.rejects(client.sendSnapshot(local),error=>error.code==='REVIEW_REQUIRED');
  await assert.rejects(client.sendSnapshot(local),error=>error.code==='REVIEW_REQUIRED');
  assert.equal(count,2);assert.equal(local.state.people[0].name,'Newer local draft');assert.equal((await snapshot(headers)).data.state.people[0].name,'Other device');
});

test('web client validates receipts and only loads a new baseline when no outcome is uncertain',async()=>{
  const headers={'remote-user':'web-receipt'};const initial=(await snapshot(headers)).data;
  const client=new RevisionClient(async body=>({...initial,mutationId:body.mutationId,committedRevision:initial.revision,householdId:'wrong-household'}));
  client.load(initial);
  await assert.rejects(client.sendSnapshot({state:{},monthly:{}}),error=>error.code==='INVALID_RECEIPT');
  assert.throws(()=>client.load(initial),error=>error.code==='PENDING_COMMIT');
});
