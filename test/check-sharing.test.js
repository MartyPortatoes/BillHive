'use strict';
const {test,before,beforeEach,after} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const {SyncStore} = require('../sync-store');
const {CheckShareSync} = require('../check-share-store');
let dir,base,child,db;
let client = 0;
// Each scenario represents a different client behind the fixture's loopback
// proxy. Keep the production public rate limit intact.
beforeEach(() => { client++; });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const key = () => crypto.randomBytes(32).toString('hex');
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(),'selfhive-check-sharing-'));
  const socket = net.createServer(); await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port = socket.address().port; await new Promise(resolve=>socket.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,
    HOST:'127.0.0.1',PORT:String(port),DB_PATH:path.join(dir,'test.db'),TRUST_PROXY:'loopback',
    TRUSTED_AUTH_HEADERS:'remote-user',SYNC_REQUIRE_PRECONDITIONS:'1'},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject) => {
    const timer = setTimeout(()=>reject(new Error('Check-sharing fixture did not start')),10000);
    child.stdout.on('data',chunk=>{if(String(chunk).includes('running on')) {clearTimeout(timer);resolve();}});
    child.on('exit',code=>{clearTimeout(timer);reject(new Error('Check-sharing fixture exited '+code));});
  });
  db = new Database(path.join(dir,'test.db'));
});
after(async () => {
  db?.close();
  if(child?.exitCode == null) {child.kill();await new Promise(resolve=>child.once('exit',resolve));}
  if(dir) fs.rmSync(dir,{recursive:true,force:true});
});
async function request(url,{method='GET',body,headers={}}={}) {
  return fetch(base+url,{method,headers:{'X-Forwarded-For':`192.0.2.${client}`,...(body===undefined?{}:{'content-type':'application/json'}),...headers},
    body:body===undefined?undefined:JSON.stringify(body)});
}
async function good(response,status=200) { assert.equal(response.status,status,await response.clone().text());return response.json(); }
async function error(response,status,code) { const body=await good(response,status);assert.equal(body.code,code); }
const ownerCommand = (snapshot,kind) => ({serverInstanceId:snapshot.serverInstanceId,householdId:snapshot.householdId,
  checkId:snapshot.checkId,baseRevision:snapshot.revision,baseShareRevision:snapshot.shareRevision,mutationId:crypto.randomUUID(),kind});
const claimCommand = (snapshot,token,credential,claim={claimerName:'Alex',itemIds:['soup']}) => ({
  serverInstanceId:snapshot.serverInstanceId,householdId:snapshot.householdId,checkId:snapshot.checkId,shareId:snapshot.shareId,
  claimantId:hash('check-claimant\0'+token+'\0'+credential),baseRevision:snapshot.revision,baseShareRevision:snapshot.shareRevision,
  mutationId:crypto.randomUUID(),claim});
function checkValue() { return {id:'dinner',name:'Dinner',dateISO:'2026-09-27',notes:'private notes',isCompleted:false,
  items:[{id:'soup',name:'Soup',price:12,participantIds:['host'],privateItem:'private'}, {id:'bread',name:'Bread',price:3}],
  participants:[{id:'host',name:'Host',linkedPersonId:'private-person',email:'private@example.invalid'}],
  paidParticipantIds:['host'],paymentRequestDates:{host:'2026-09-27'},futurePrivateField:{secret:true},
  taxAmount:1,discountAmount:2,compAmount:1,serviceFeeAmount:3,tipAmount:4}; }
async function fixture() {
  const user='check-owner-'+crypto.randomUUID(); const headers={'remote-user':user};
  const ownerPath='/api/share/check/dinner';
  const household = () => request('/api/sync/snapshot',{headers}).then(good);
  const read = () => request(ownerPath+'/sync/snapshot',{headers}).then(good);
  const send = body => request(ownerPath+'/sync/commit',{method:'POST',headers:{...headers,'X-BillHive-Require-Protection':'1'},body});
  const write = async state => {
    const s=await household();
    return good(await request('/api/sync/commit',{method:'POST',headers,body:{serverInstanceId:s.serverInstanceId,householdId:s.householdId,
      baseRevision:s.revision,mutationId:crypto.randomUUID(),state,monthly:{}}}));
  };
  await write({checks:{checks:[checkValue()]},settings:{currencyCode:'EUR',myEmail:'private@example.invalid'}});
  return {user,headers,ownerPath,read,send,write,household};
}
async function shared() {
  const f=await fixture();const created=await good(await f.send(ownerCommand(await f.read(),'create')));
  const token=created.resultToken;const prefix='/public/share/check/'+token;
  return {...f,created,token,prefix,
    publicRead:()=>request(prefix+'/sync/snapshot').then(good),
    claim:(body,credential)=>request(prefix+'/sync/claim',{method:'POST',body,headers:{'X-BillHive-Claimant-Key':credential,'X-BillHive-Require-Protection':'1'}})};
}

test('check sharing advertises capability and projects only public metadata, including correct currency',async()=>{
  assert.equal((await good(await request('/api/health'))).capabilities.checkShareProtocol,1);
  const f=await shared();const pub=await f.publicRead();const legacy=await good(await request(f.prefix));
  assert.equal(pub.currencyCode,'EUR');assert.equal(pub.check.isCompleted,false);assert.equal(pub.check.serviceFeeAmount,3);
  for(const value of [pub,legacy]) {
    assert.equal(JSON.stringify(value).includes('private'),false);assert.equal(value.userId,undefined);
    assert.equal(value.check.items[0].participantIds,undefined);assert.equal(value.check.paidParticipantIds,undefined);
  }
  assert.equal(pub.shareId,hash(f.token));assert.equal(pub.revisionPreconditionsRequired,true);
  assert.equal((await request(f.prefix)).headers.get('cache-control'),'no-store');
  const other=await request(f.ownerPath+'/sync/snapshot',{headers:{'remote-user':'other-owner'}});
  assert.equal((await good(other)).share,null);
  await error(await f.send({...ownerCommand(await f.read(),'rotate'),householdId:'other-household'}),409,'HOUSEHOLD_CHANGED');
});

test('exact owner replay survives newer rotation without reactivating the original bearer link',async()=>{
  const f=await fixture();const before=await f.read();const body=ownerCommand(before,'create');
  const first=await good(await f.send(body));const ownerRevision=first.snapshot.revision;
  const reused=await good(await f.send(ownerCommand(first.snapshot,'create')));
  assert.equal(reused.resultToken,first.resultToken);assert.equal(reused.committedShareRevision,first.committedShareRevision);
  const rotation=ownerCommand(reused.snapshot,'rotate');
  const rotated=await good(await f.send(rotation));assert.notEqual(rotated.resultToken,first.resultToken);
  assert.equal(rotated.snapshot.revision,ownerRevision);
  const replay=await good(await f.send(body));assert.equal(replay.replayed,true);
  assert.equal(replay.resultToken,first.resultToken);assert.equal(replay.snapshot.share.token,rotated.resultToken);
  assert.equal(replay.committedShareRevision,first.committedShareRevision);
  await error(await request('/public/share/check/'+first.resultToken),410,'SHARE_REVOKED');
  await error(await f.send({...body,kind:'rotate'}),409,'MUTATION_ID_REUSED');
  await error(await f.send(ownerCommand(before,'rotate')),409,'SHARE_CONFLICT');
  assert.equal(db.prepare('SELECT count(*) AS n FROM share_checks WHERE user_id=? AND revoked_at IS NULL').get(f.user).n,1);
});

test('different guests with the same display name remain distinct; update and withdrawal preserve the other guest',async()=>{
  const f=await shared();const a=key(),b=key();const initial=await f.publicRead();
  const ownerBefore=await f.household();const firstBody=claimCommand(initial,f.token,a);
  const first=await good(await f.claim(firstBody,a));
  assert.equal(first.snapshot.revision,initial.revision);assert.ok(first.snapshot.shareRevision>initial.shareRevision);
  await error(await f.claim(claimCommand(initial,f.token,b),b),409,'SHARE_CONFLICT');
  const second=await good(await f.claim(claimCommand(first.snapshot,f.token,b),b));
  assert.equal(second.snapshot.claims.length,2);assert.notEqual(second.snapshot.claims[0].claimantId,second.snapshot.claims[1].claimantId);
  const withdrawn=await good(await f.claim(claimCommand(second.snapshot,f.token,a,{claimerName:'Alex renamed',itemIds:[]}),a));
  assert.equal(withdrawn.snapshot.claims.length,2);assert.deepEqual(withdrawn.snapshot.claims[0].itemIds,[]);
  assert.deepEqual(withdrawn.snapshot.claims[1].itemIds,['soup']);
  const replay=await good(await f.claim(firstBody,a));assert.equal(replay.replayed,true);
  assert.equal(replay.committedShareRevision,first.committedShareRevision);assert.deepEqual(replay.snapshot,withdrawn.snapshot);
  assert.deepEqual(await f.household(),ownerBefore,'guest declarations must not change financial assignments');
  await error(await f.claim(firstBody,b),409,'CLAIMANT_CHANGED');
  await error(await f.claim({...firstBody,claim:{claimerName:'changed',itemIds:[]}},a),409,'MUTATION_ID_REUSED');
  assert.equal(JSON.stringify(replay).includes(a),false);
});

test('simultaneous guests cannot overwrite each other; loser refreshes and retains both declarations',async()=>{
  const f=await shared();const snapshot=await f.publicRead();const keys=[key(),key()];
  const requests=keys.map(k=>claimCommand(snapshot,f.token,k));
  const replies=await Promise.all(requests.map((body,i)=>f.claim(body,keys[i])));
  assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);
  const winner=replies.findIndex(r=>r.status===200),loser=1-winner;
  const saved=await good(replies[winner]);await error(replies[loser],409,'SHARE_CONFLICT');
  const next=await good(await f.claim(claimCommand(saved.snapshot,f.token,keys[loser]),keys[loser]));
  assert.equal(next.snapshot.claims.length,2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM check_claim_receipts WHERE share_id=?').get(snapshot.shareId).n,2);
});

test('household edits invalidate guest and owner commands; completed checks remain readable but reject writes',async()=>{
  const f=await shared();const s=await f.publicRead();const owner=await f.read();const credential=key();
  await f.write({checks:{checks:[{...checkValue(),items:[{id:'bread',name:'Bread',price:4}]}]}});
  await error(await f.claim(claimCommand(s,f.token,credential),credential),409,'SHARE_CONFLICT');
  await error(await f.send(ownerCommand(owner,'rotate')),409,'SHARE_CONFLICT');
  await error(await f.claim(claimCommand(await f.publicRead(),f.token,credential),credential),409,'ITEM_REMOVED');
  await f.write({checks:{checks:[{...checkValue(),isCompleted:true}]}});
  assert.equal((await f.publicRead()).check.isCompleted,true);
  await error(await f.claim(claimCommand(await f.publicRead(),f.token,credential),credential),409,'CHECK_COMPLETED');
  await error(await f.send(ownerCommand(await f.read(),'rotate')),409,'CHECK_COMPLETED');
  assert.equal((await f.read()).share.token,f.token);
  await f.write({checks:{checks:[checkValue()]}});
  assert.equal((await good(await f.claim(claimCommand(await f.publicRead(),f.token,credential),credential))).snapshot.claims.length,1);
});

test('revoke acknowledges an already committed guest request without exposing current data',async()=>{
  const f=await shared();const credential=key();const body=claimCommand(await f.publicRead(),f.token,credential);
  const first=await good(await f.claim(body,credential));
  const revoked=await good(await f.send(ownerCommand(await f.read(),'revoke')));assert.equal(revoked.snapshot.share,null);
  const replay=await good(await f.claim(body,credential));assert.equal(replay.replayed,true);assert.equal(replay.access,'revoked');
  assert.equal(replay.snapshot,null);assert.equal(replay.committedShareRevision,first.committedShareRevision);
  await error(await f.claim({...body,mutationId:crypto.randomUUID()},credential),410,'SHARE_REVOKED');
  await error(await request(f.prefix+'/sync/snapshot'),410,'SHARE_REVOKED');
  await error(await f.claim({...body,claim:{claimerName:'Changed',itemIds:[]}},credential),409,'MUTATION_ID_REUSED');
});

test('check deletion atomically revokes links; restoring the same check ID cannot resurrect them',async()=>{
  const f=await shared();const before=await f.read();
  await f.write({checks:{checks:[]}});
  const removed=await f.read();assert.equal(removed.checkExists,false);assert.equal(removed.share,null);assert.ok(removed.shareRevision>before.shareRevision);
  await f.write({checks:{checks:[checkValue()]}});
  await error(await request(f.prefix),410,'SHARE_REVOKED');
  const renewed=await good(await f.send(ownerCommand(await f.read(),'create')));assert.notEqual(renewed.resultToken,f.token);
  db.prepare('DELETE FROM user_state WHERE user_id=? AND key=?').run(f.user,'checks');
  await error(await request('/public/share/check/'+renewed.resultToken),410,'SHARE_REVOKED');
  assert.throws(()=>db.prepare('UPDATE share_checks SET revoked_at=NULL WHERE token=?').run(f.token),/permanent/);
});

test('legacy writers require matching resource ETags in strict mode and participate in the same revision stream',async()=>{
  const f=await fixture();const initial=await request(f.ownerPath+'/sync/snapshot',{headers:f.headers});
  await error(await request(f.ownerPath,{method:'POST',headers:f.headers}),428,'PRECONDITION_REQUIRED');
  const legacy=await request(f.ownerPath,{method:'POST',headers:{...f.headers,'If-Match':initial.headers.get('etag')}});
  const share=await good(legacy);assert.ok(share.url.endsWith('/share/'+share.token));
  const prefix='/public/share/check/'+share.token;const publicRead=await request(prefix);const claim={claimerName:'Legacy',itemIds:['bread']};
  await error(await request(prefix+'/claim',{method:'POST',body:claim}),428,'PRECONDITION_REQUIRED');
  assert.equal((await request(prefix+'/claim',{method:'POST',body:claim,headers:{'If-Match':publicRead.headers.get('etag')}})).status,200);
  await error(await request(prefix+'/claim',{method:'POST',body:claim,headers:{'If-Match':publicRead.headers.get('etag')}}),409,'SHARE_CONFLICT');
  await error(await request(f.ownerPath,{method:'DELETE',headers:{...f.headers,'If-Match':legacy.headers.get('etag')}}),409,'SHARE_CONFLICT');
  const current=await request(f.ownerPath,{headers:f.headers});assert.equal((await good(current)).claims[0].claimerName,'Legacy');
  assert.equal((await request(f.ownerPath,{method:'DELETE',headers:{...f.headers,'If-Match':current.headers.get('etag')}})).status,200);
});

test('malformed requests, unsafe identifiers and mismatched route identities are rejected without writes',async()=>{
  const f=await shared();const credential=key();const baseline=await f.publicRead();const body=claimCommand(baseline,f.token,credential);
  for(const claim of [{claimerName:' ',itemIds:[]},{claimerName:'X',itemIds:['soup','soup']},
    {claimerName:'X',itemIds:['__proto__']},{claimerName:'X',itemIds:[],claimantId:'injected'},
    {claimerName:'X'.repeat(81),itemIds:[]}]) await error(await f.claim({...body,claim},credential),400,'INVALID_CLAIM');
  for(const change of [{baseRevision:-1},{baseShareRevision:9007199254740992},{mutationId:'short'},{unexpected:true}])
    await error(await f.claim({...body,...change},credential),400,'INVALID_SHARE_COMMAND');
  await error(await f.claim(body,'bad'),400,'INVALID_CLAIMANT');
  await error(await f.send({...ownerCommand(await f.read(),'revoke'),checkId:'different'}),400,'INVALID_SHARE_COMMAND');
  assert.deepEqual(await f.publicRead(),baseline);
});

test('receipt failure rolls back claim bytes, rotation and all resource revisions together',async()=>{
  const f=await shared();const baseline=await f.publicRead();const owner=await f.read();const credential=key();
  db.exec("CREATE TRIGGER test_claim_receipt_failure BEFORE INSERT ON check_claim_receipts BEGIN SELECT RAISE(ABORT,'injected'); END");
  try {assert.equal((await f.claim(claimCommand(baseline,f.token,credential),credential)).status,500);assert.deepEqual(await f.publicRead(),baseline);}
  finally {db.exec('DROP TRIGGER test_claim_receipt_failure');}
  db.exec("CREATE TRIGGER test_share_receipt_failure BEFORE INSERT ON check_share_owner_receipts BEGIN SELECT RAISE(ABORT,'injected'); END");
  try {assert.equal((await f.send(ownerCommand(owner,'rotate'))).status,500);assert.deepEqual(await f.read(),owner);assert.deepEqual(await f.publicRead(),baseline);}
  finally {db.exec('DROP TRIGGER test_share_receipt_failure');}
});

test('stored legacy claims and unknown fields survive updates; corrupt state and capacity fail without data loss',async()=>{
  const f=await shared();const credential=key();let snapshot=await f.publicRead();
  snapshot=(await good(await f.claim(claimCommand(snapshot,f.token,credential),credential))).snapshot;
  const legacy={claimerName:'Old guest',itemIds:['bread'],claimedAt:'2026-09-01T12:00:00.000Z',privateLegacy:'private'};
  const claims=[{...snapshot.claims[0],futureMetadata:{keep:true}},legacy];
  const save=value=>db.prepare('UPDATE share_checks SET claims=? WHERE token=?').run(value,f.token);
  save(JSON.stringify(claims));
  const next=await good(await f.claim(claimCommand(await f.publicRead(),f.token,credential,{claimerName:'New',itemIds:['bread']}),credential));
  assert.equal(JSON.stringify(next).includes('private'),false);
  assert.deepEqual(JSON.parse(db.prepare('SELECT claims FROM share_checks WHERE token=?').get(f.token).claims),
    [{...next.snapshot.claims[0],futureMetadata:{keep:true}},legacy]);
  const full=Array.from({length:500},(_,i)=>({...legacy,claimerName:'Guest '+i}));save(JSON.stringify(full));
  await error(await f.claim(claimCommand(await f.publicRead(),f.token,key()),key()),409,'CLAIMANT_CHANGED');
  const fresh=key();await error(await f.claim(claimCommand(await f.publicRead(),f.token,fresh),fresh),429,'CLAIM_LIMIT');
  assert.equal(JSON.parse(db.prepare('SELECT claims FROM share_checks WHERE token=?').get(f.token).claims).length,500);
  save(JSON.stringify({malformed:true}));
  await error(await request(f.prefix),409,'INVALID_STORED_CLAIMS');
  assert.equal(db.prepare('SELECT claims FROM share_checks WHERE token=?').get(f.token).claims,'{"malformed":true}');
});

test('receipts and revisions survive database reopen; legacy non-strict writes advance native snapshots',async()=>{
  const f=await shared();const credential=key();const body=claimCommand(await f.publicRead(),f.token,credential);
  const ownerRequest=ownerCommand(await f.read(),'create');const ownerResult=await good(await f.send(ownerRequest));
  const first=await good(await f.claim(body,credential));
  const second=new Database(path.join(dir,'test.db'));
  try {
    const sync=new SyncStore(second);const store=new CheckShareSync(second,sync,c=>({id:c.id,items:c.items.map(i=>({id:i.id,name:i.name,price:i.price}))}));
    const replay=store.claimCommit(f.token,credential,body).response;
    assert.equal(replay.replayed,true);assert.equal(replay.committedShareRevision,first.committedShareRevision);
    const ownerReplay=store.ownerCommit(f.user,'dinner',ownerRequest);
    assert.equal(ownerReplay.replayed,true);assert.equal(ownerReplay.resultToken,ownerResult.resultToken);
    assert.equal(ownerReplay.committedShareRevision,ownerResult.committedShareRevision);
    const before=store.publicSnapshot(f.token);
    assert.throws(()=>store.claimCommit(f.token,credential,claimCommand(before,f.token,credential),{requireProtection:true}),e=>e.code==='PROTECTION_DISABLED');
    store.claimLegacy(f.token,{claimerName:'Old client',itemIds:['bread']});
    const after=await f.publicRead();assert.ok(after.shareRevision>before.shareRevision);assert.equal(after.claims.length,2);
    await error(await f.claim(claimCommand(before,f.token,credential),credential),409,'SHARE_CONFLICT');
    const owner=store.ownerSnapshot(f.user,'dinner');
    store.ownerLegacy(f.user,'dinner','rotate');
    await error(await f.send(ownerCommand(owner,'revoke')),409,'SHARE_CONFLICT');
  } finally {second.close();}
});

test('simultaneous rotations issue one new active token and revision exhaustion rolls back all changes',async()=>{
  const f=await shared();const baseline=await f.read();
  const responses=await Promise.all([f.send(ownerCommand(baseline,'rotate')),f.send(ownerCommand(baseline,'rotate'))]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  const saved=await good(responses.find(r=>r.status===200));
  await error(responses.find(r=>r.status===409),409,'SHARE_CONFLICT');
  db.prepare('UPDATE check_share_revisions SET revision=? WHERE user_id=? AND check_id=?').run(9007199254740991,f.user,'dinner');
  const maximum=await f.read();
  assert.equal((await f.send(ownerCommand(maximum,'rotate'))).status,500);
  assert.deepEqual(await f.read(),maximum);assert.equal(maximum.share.token,saved.resultToken);
  assert.equal(db.prepare('SELECT count(*) AS n FROM share_checks WHERE user_id=? AND revoked_at IS NULL').get(f.user).n,1);
});

test('upgrade revokes orphaned legacy tokens and preserves active legacy claims',async()=>{
  const local=new Database(':memory:');
  try {
    local.exec(`CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE user_state(user_id TEXT,key TEXT,value TEXT,updated_at INTEGER,PRIMARY KEY(user_id,key));
      CREATE TABLE monthly_data(user_id TEXT,month_key TEXT,data TEXT,updated_at INTEGER,PRIMARY KEY(user_id,month_key));
      CREATE TABLE share_checks(token TEXT PRIMARY KEY,user_id TEXT,check_id TEXT,claims TEXT,created_at INTEGER DEFAULT 1,revoked_at INTEGER);`);
    local.prepare('INSERT INTO user_state(user_id,key,value) VALUES (?,?,?)').run('owner','checks',JSON.stringify({checks:[checkValue()]}));
    const legacy='[{"claimerName":"Legacy","itemIds":[],"claimedAt":"2026-09-27T12:00:00Z"}]';
    const insert=local.prepare('INSERT INTO share_checks(token,user_id,check_id,claims) VALUES (?,?,?,?)');
    insert.run('active','owner','dinner',legacy);insert.run('orphan','owner','removed',legacy);insert.run('absent','missing','dinner',legacy);
    const sync=new SyncStore(local);const store=new CheckShareSync(local,sync,c=>({id:c.id}));
    assert.equal(store.publicSnapshot('active').claims[0].claimerName,'Legacy');
    assert.throws(()=>store.publicSnapshot('orphan'),e=>e.code==='SHARE_REVOKED');
    assert.throws(()=>store.publicSnapshot('absent'),e=>e.code==='SHARE_REVOKED');
    assert.throws(()=>local.prepare('UPDATE share_checks SET check_id=? WHERE token=?').run('other','active'),/permanent/);
  } finally {local.close();}
});
