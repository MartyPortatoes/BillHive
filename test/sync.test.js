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
const {GuestTripSync} = require('../guest-sync-store');
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

async function guestFixture() {
  const headers = {'remote-user':'guest-owner-' + crypto.randomUUID()};
  const first = await snapshot(headers);
  const expense = {id:'expense',name:'Train',amount:20,paidByAmounts:{host:20},splitBetweenIds:['host','guest'],
    attachments:[{id:'receipt',filename:'private.jpg'}],importFingerprint:'private-import',futureHostOnly:{keep:true}};
  const trip = {id:'guest-trip',name:'Shared weekend',currency:'USD',members:[{id:'host',name:'Host',linkedPersonId:'private-person'},{id:'guest',name:'Guest'}],
    expenses:[expense],settlements:[],checklistItems:[],futureTripField:'keep'};
  assert.equal((await commit(commitBody(first.data,{state:{settings:{myEmail:'private@example.invalid'},trips:{trips:[trip]}}}),headers)).status,200);
  const invite = await (await request('/api/trips/guest-trip/invite',{method:'POST',headers,body:{memberId:'guest'}})).json();
  const prefix = `/public/trip/invite/${invite.token}`;
  assert.equal((await request(prefix+'/join',{method:'POST',headers:{}})).status,200);
  const read = async () => {
    const response = await request(prefix+'/sync/snapshot',{headers:{}});
    assert.equal(response.status,200);return response.json();
  };
  const send = body => request(prefix+'/sync/commit',{method:'POST',headers:{'X-BillHive-Require-Protection':'1'},body});
  return {headers,invite,prefix,read,send};
}
function guestBody(snapshot, operation, mutationId=crypto.randomUUID()) {
  return {serverInstanceId:snapshot.serverInstanceId,householdId:snapshot.householdId,
    invitationId:snapshot.invitationId,
    tripId:snapshot.tripId,memberId:snapshot.memberId,baseRevision:snapshot.revision,mutationId,operation};
}
const guestExpense = {id:'expense',name:'Guest renamed train',amount:24,paidByAmounts:{host:24},splitBetweenIds:['host','guest']};

test('guest commits preserve host-only fields, return only public trip data and block stale owners',async()=>{
  const fixture = await guestFixture(); const baseline = await fixture.read(); const owner = await snapshot(fixture.headers);
  assert.equal(baseline.protocolVersion,1);assert.equal(baseline.revisionPreconditionsRequired,true);
  assert.equal(baseline.userId,undefined);assert.equal(baseline.state,undefined);assert.equal(baseline.monthly,undefined);
  assert.equal(baseline.trip.members[0].linkedPersonId,undefined);
  assert.equal(baseline.trip.expenses[0].attachments,undefined);
  const response = await fixture.send(guestBody(baseline,{kind:'upsertExpense',expense:guestExpense}));
  assert.equal(response.status,200); const saved = await response.json();
  assert.equal(saved.replayed,false);assert.equal(saved.snapshot.trip.expenses[0].amount,24);
  assert.equal(saved.committedRevision,saved.snapshot.revision);assert.ok(saved.committedRevision>baseline.revision);
  assert.equal(JSON.stringify(saved).includes('private'),false);
  const canonical = (await snapshot(fixture.headers)).data.state.trips.trips[0];
  assert.equal(canonical.futureTripField,'keep');assert.equal(canonical.expenses[0].importFingerprint,'private-import');
  assert.deepEqual(canonical.expenses[0].attachments,[{id:'receipt',filename:'private.jpg'}]);
  assert.deepEqual(canonical.expenses[0].futureHostOnly,{keep:true});
  assert.equal(canonical.activity.length,1);assert.equal(canonical.activity[0].kind,'expenseUpdated');
  assert.equal(canonical.activity[0].actorName,'Guest');assert.equal(canonical.activity[0].actorMemberId,'guest');
  assert.match(canonical.activity[0].createdAtISO,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(canonical.activity[0].amountText,'USD 24.00');assert.equal(saved.snapshot.trip.activity,undefined);
  assert.equal((await commit(commitBody(owner.data,{state:{trips:owner.data.state.trips}}),fixture.headers)).status,409);
  const settled = await fixture.send(guestBody(saved.snapshot,{kind:'recordSettlement',settlement:{id:'payment',fromMemberId:'guest',toMemberId:'host',amount:12}}));
  assert.equal(settled.status,200);
  const next = (await settled.json()).snapshot;
  const deleted = await fixture.send(guestBody(next,{kind:'deleteExpense',expenseId:'expense'}));assert.equal(deleted.status,200);
  const final = (await deleted.json()).snapshot;assert.equal(final.trip.expenses.length,0);assert.equal(final.trip.settlements.length,1);
  assert.equal(final.trip.activity,undefined);
  assert.deepEqual((await snapshot(fixture.headers)).data.state.trips.trips[0].activity.map(event=>event.kind),
    ['expenseDeleted','settlementRecorded','expenseUpdated']);
  assert.equal((await snapshot(fixture.headers)).data.state.trips.trips[0].activity[1].detail,'Guest → Host · USD 12.00');
});

test('guest lost-response replay survives intervening edits and database reopen without repeating a mutation',async()=>{
  const fixture = await guestFixture(); const baseline = await fixture.read();
  const body = guestBody(baseline,{kind:'upsertExpense',expense:guestExpense});
  const first = await (await fixture.send(body)).json();
  const owner = await snapshot(fixture.headers);
  assert.equal((await commit(commitBody(owner.data,{state:{settings:{myEmail:'new-private@example.invalid'}}}),fixture.headers)).status,200);
  const before = await snapshot(fixture.headers);
  const replay = await (await fixture.send(body)).json();
  assert.equal(replay.replayed,true);assert.equal(replay.committedRevision,first.committedRevision);
  assert.equal(replay.snapshot.revision,before.data.revision);assert.equal((await snapshot(fixture.headers)).etag,before.etag);
  assert.equal(before.data.state.trips.trips[0].activity.length,1);
  assert.deepEqual((await snapshot(fixture.headers)).data.state.trips.trips[0].activity,before.data.state.trips.trips[0].activity);
  const reused = await fixture.send({...body,operation:{kind:'deleteExpense',expenseId:'expense'}});
  assert.equal(reused.status,409);assert.equal((await reused.json()).code,'MUTATION_ID_REUSED');
  const stale = await fixture.send(guestBody(baseline,{kind:'deleteExpense',expenseId:'expense'}));
  assert.equal(stale.status,409);assert.equal((await stale.json()).code,'REVISION_CONFLICT');
  const db = new Database(path.join(dir,'test.db'));
  try {
    const store = new GuestTripSync(db,new SyncStore(db),trip=>({id:trip.id}));
    const reopened = store.commit(fixture.invite.token,body,{requireProtection:true}).response;
    assert.equal(reopened.replayed,true);assert.equal(reopened.committedRevision,first.committedRevision);
    assert.throws(()=>store.commit(fixture.invite.token,{...body,mutationId:crypto.randomUUID()},{requireProtection:true}),error=>error.code==='PROTECTION_DISABLED');
    assert.equal(db.prepare('SELECT count(*) AS n FROM sync_guest_receipts WHERE mutation_id=?').get(body.mutationId).n,1);
  } finally {db.close();}
});

test('revocation can acknowledge a prior guest request without revealing current trip data or permitting new writes',async()=>{
  const fixture = await guestFixture();const body = guestBody(await fixture.read(),{kind:'deleteExpense',expenseId:'expense'});
  const saved = await (await fixture.send(body)).json();
  assert.equal((await request('/api/trips/guest-trip/invite/guest',{method:'DELETE',headers:fixture.headers})).status,200);
  assert.equal((await request(fixture.prefix+'/sync/snapshot',{headers:{}})).status,410);
  const before = await snapshot(fixture.headers);const response = await fixture.send(body);assert.equal(response.status,200);
  const replay = await response.json();assert.equal(replay.replayed,true);assert.equal(replay.access,'revoked');assert.equal(replay.snapshot,null);
  assert.equal(replay.committedRevision,saved.committedRevision);assert.equal(replay.userId,undefined);
  assert.notEqual(response.headers.get('etag'),before.etag);assert.equal(replay.revision,undefined);
  assert.equal((await snapshot(fixture.headers)).etag,before.etag);
  assert.equal((await fixture.send({...body,mutationId:crypto.randomUUID()})).status,410);
});

test('guest identity, token receipts, archive and membership authorization cannot cross invitations',async()=>{
  const fixture = await guestFixture();const baseline = await fixture.read();const body = guestBody(baseline,{kind:'upsertExpense',expense:guestExpense});
  for (const identity of [{memberId:'host'},{tripId:'other'},{householdId:'other'},{serverInstanceId:'other'},{invitationId:'other'}]) {
    const rejected = await fixture.send({...body,...identity});assert.equal(rejected.status,409);assert.equal((await rejected.json()).code,'HOUSEHOLD_CHANGED');
  }
  const other = await (await request('/api/trips/guest-trip/invite',{method:'POST',headers:fixture.headers,body:{memberId:'host'}})).json();
  const otherPrefix = `/public/trip/invite/${other.token}`;
  assert.equal((await request(otherPrefix+'/sync/snapshot',{headers:{}})).status,403);
  await request(otherPrefix+'/join',{method:'POST',headers:{}});
  assert.equal((await fixture.send(body)).status,200);
  const otherSnapshot = await (await request(otherPrefix+'/sync/snapshot',{headers:{}})).json();
  const independent = await request(otherPrefix+'/sync/commit',{method:'POST',headers:{},body:guestBody(otherSnapshot,{kind:'deleteExpense',expenseId:'expense'},body.mutationId)});
  assert.equal(independent.status,200);assert.equal((await independent.json()).replayed,false);
  let owner = await snapshot(fixture.headers);owner.data.state.trips.trips[0].isArchived = true;
  await commit(commitBody(owner.data,{state:{trips:owner.data.state.trips}}),fixture.headers);
  const archived = await fixture.send(guestBody(await fixture.read(),{kind:'upsertExpense',expense:guestExpense}));
  assert.equal(archived.status,409);assert.equal((await archived.json()).code,'TRIP_ARCHIVED');
  owner = await snapshot(fixture.headers);owner.data.state.trips.trips[0].members = [{id:'host',name:'Host'}];
  await commit(commitBody(owner.data,{state:{trips:owner.data.state.trips}}),fixture.headers);
  assert.equal((await request(fixture.prefix+'/sync/snapshot',{headers:{}})).status,410);
  const replay = await (await fixture.send(body)).json();assert.equal(replay.access,'memberRemoved');assert.equal(replay.snapshot,null);
});

test('invalid guest changes cannot replace attachments, add foreign members, or corrupt trip records',async()=>{
  const fixture = await guestFixture();const baseline = await fixture.read();const before = await snapshot(fixture.headers);
  const invalid = [
    {kind:'upsertExpense',expense:{...guestExpense,attachments:[]}},
    {kind:'upsertExpense',expense:{...guestExpense,amount:-1}},
    {kind:'upsertExpense',expense:{...guestExpense,paidByAmounts:{outsider:24}}},
    {kind:'upsertExpense',expense:{...guestExpense,splitBetweenIds:['guest','guest']}},
    {kind:'upsertExpense',expense:{...guestExpense,exchangeRate:0}},
    {kind:'recordSettlement',settlement:{id:'bad',fromMemberId:'guest',toMemberId:'guest',amount:10}},
    {kind:'recordSettlement',settlement:{id:'bad',fromMemberId:'guest',toMemberId:'unknown',amount:10}},
    {kind:'deleteExpense',expenseId:'../private'},
    {kind:'replaceTrip',trip:{}},
  ];
  for (const operation of invalid) assert.equal((await fixture.send(guestBody(baseline,operation))).status,400);
  assert.equal((await snapshot(fixture.headers)).etag,before.etag);
  const settlements = guestBody(baseline,{kind:'recordSettlement',settlement:{id:'payment',fromMemberId:'guest',toMemberId:'host',amount:3}});
  assert.equal((await fixture.send(settlements)).status,200);
  const duplicate = await fixture.send(guestBody(await fixture.read(),{kind:'recordSettlement',settlement:{...settlements.operation.settlement,amount:4}}));
  assert.equal(duplicate.status,409);assert.equal((await duplicate.json()).code,'SETTLEMENT_ID_REUSED');
});

test('guest data and receipt commit together, rolling both back if receipt persistence fails',async()=>{
  const fixture = await guestFixture();const baseline = await fixture.read();const before = await snapshot(fixture.headers);
  const body = guestBody(baseline,{kind:'upsertExpense',expense:guestExpense},'fail-receipt-1234567890');
  const db = new Database(path.join(dir,'test.db'));
  try {
    db.exec("CREATE TRIGGER reject_guest_receipt BEFORE INSERT ON sync_guest_receipts WHEN NEW.mutation_id='fail-receipt-1234567890' BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END");
    assert.equal((await fixture.send(body)).status,500);
    assert.equal((await snapshot(fixture.headers)).etag,before.etag);
    assert.equal(db.prepare('SELECT count(*) AS n FROM sync_guest_receipts WHERE mutation_id=?').get(body.mutationId).n,0);
    db.exec('DROP TRIGGER reject_guest_receipt');
    assert.equal((await fixture.send(body)).status,200);
  } finally {db.exec('DROP TRIGGER IF EXISTS reject_guest_receipt');db.close();}
});

test('guest activity retains recent history, ignores no-op commands and cannot accept a forged actor',async()=>{
  const fixture=await guestFixture(); const owner=await snapshot(fixture.headers);
  const trip=owner.data.state.trips.trips[0];
  trip.activity=Array.from({length:100},(_,index)=>({id:'history-'+index,kind:'futureKind',actorName:'Earlier owner',
    createdAtISO:index===0?'2100-01-01T00:00:00Z':'2020-01-01T00:00:00Z',futureMetadata:{keep:index}}));
  assert.equal((await commit(commitBody(owner.data,{state:{trips:owner.data.state.trips}}),fixture.headers)).status,200);
  const db=new Database(path.join(dir,'test.db'));
  try {
    const store=new GuestTripSync(db,new SyncStore(db,{requirePreconditions:true}),trip=>({id:trip.id}));
    const send=operation=>store.commit(fixture.invite.token,guestBody(store.snapshot(fixture.invite.token),operation),{requireProtection:true});
    send({kind:'upsertExpense',expense:guestExpense});
    const recorded=(await snapshot(fixture.headers)).data.state.trips.trips[0].activity;
    assert.equal(recorded.length,100);assert.equal(recorded[0].actorName,'Guest');
    assert.deepEqual(recorded[1].futureMetadata,{keep:0});
    send({kind:'upsertExpense',expense:guestExpense});
    send({kind:'deleteExpense',expenseId:'already-missing'});
    assert.deepEqual((await snapshot(fixture.headers)).data.state.trips.trips[0].activity,recorded);
    const forged=guestBody(store.snapshot(fixture.invite.token),{kind:'upsertExpense',expense:guestExpense});
    forged.actorName='Owner';
    assert.throws(()=>store.commit(fixture.invite.token,forged),error=>error.code==='INVALID_GUEST_COMMIT');
    const settlement={id:'same-payment',fromMemberId:'guest',toMemberId:'host',amount:3};
    send({kind:'recordSettlement',settlement});
    const first=(await snapshot(fixture.headers)).data.state.trips.trips[0].activity;
    send({kind:'recordSettlement',settlement});
    assert.deepEqual((await snapshot(fixture.headers)).data.state.trips.trips[0].activity,first);
  } finally {db.close();}
});

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
test('owner HTTP receipt replay survives a protection-policy change while new protected writes stay blocked',async()=>{
  const headers={'remote-user':'protection-replay','X-BillHive-Require-Protection':'1'};
  const first=(await snapshot(headers)).data;
  const body=commitBody(first,{state:{settings:{currencyCode:'USD'}}});
  const saved=await (await commit(body,headers)).json();
  const newer=await (await commit(commitBody(saved,{state:{people:[{id:'later',name:'Later edit'}]}}),headers)).json();
  const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const unprotected=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,
    HOST:'127.0.0.1',PORT:String(port),DB_PATH:path.join(dir,'test.db'),TRUST_PROXY:'0',TRUSTED_AUTH_HEADERS:'remote-user',SYNC_REQUIRE_PRECONDITIONS:'0'},stdio:['ignore','pipe','pipe']});
  try{
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Policy-change fixture did not start')),10000);
      unprotected.stdout.on('data',chunk=>{if(String(chunk).includes('running on')){clearTimeout(timer);resolve();}});
      unprotected.once('exit',code=>{clearTimeout(timer);reject(new Error('Policy-change fixture exited '+code));});});
    const send=(payload,identity=headers)=>fetch(`http://127.0.0.1:${port}/api/sync/commit`,{method:'POST',headers:{'content-type':'application/json',...identity},body:JSON.stringify(payload)});
    const replay=await send(body);assert.equal(replay.status,200);const receipt=await replay.json();
    assert.equal(receipt.replayed,true);assert.equal(receipt.committedRevision,saved.committedRevision);
    assert.equal(receipt.revision,newer.revision);assert.deepEqual(receipt.state.people,newer.state.people);
    const reused=await send({...body,state:{settings:{currencyCode:'JPY'}}});
    assert.equal(reused.status,409);assert.equal((await reused.json()).code,'MUTATION_ID_REUSED');
    const other=await send(body,{...headers,'remote-user':'another-policy-account'});
    assert.equal(other.status,409);assert.equal((await other.json()).code,'HOUSEHOLD_CHANGED');
    const fresh=await send(commitBody(newer,{state:{settings:{currencyCode:'EUR'}}}));
    assert.equal(fresh.status,428);assert.equal((await fresh.json()).code,'PROTECTION_DISABLED');
    assert.deepEqual((await snapshot(headers)).data,resultWithoutReceipt(newer));
  }finally{if(unprotected.exitCode===null&&unprotected.signalCode===null){const done=new Promise(resolve=>unprotected.once('exit',resolve));unprotected.kill();await done;}}
});
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
