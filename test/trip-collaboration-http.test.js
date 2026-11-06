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

test('one guest document commit saves the complete proposal and replay acknowledges history without overwriting newer work',async()=>{
  const f=await guestFixture(), first=await f.read();
  const proposed=structuredClone(first.trip);
  proposed.notes='Bring water';
  proposed.expenses[0].name='Express train';
  proposed.expenses.push({...guestExpense,id:'lunch',name:'Lunch'});
  proposed.checklistItems=[{id:'water',label:'Pack water',isDone:false,createdAtISO:''}];
  const body={...guestBody(first,{kind:'updateTrip',base:first.trip,trip:proposed,confirmedSettlementIds:[]}),decimalJSONProtocol:1};
  const response=await f.send(body);
  assert.equal(response.status,200,await response.clone().text());
  const accepted=await response.json();
  assert.equal(accepted.snapshot.guestDocumentProtocol,1);
  assert.equal(accepted.snapshot.trip.notes,'Bring water');
  assert.equal(accepted.snapshot.trip.expenses.length,2);
  assert.equal(accepted.snapshot.trip.checklistItems[0].label,'Pack water');
  const owner=await snapshot(f.headers),trip=owner.data.state.trips.trips[0];
  assert.deepEqual(trip.expenses.find(e=>e.id==='expense').attachments,[{id:'receipt',filename:'private.jpg'}]);
  assert.equal(trip.futureTripField,'keep');
  trip.notes='Owner packed water';
  assert.equal((await commit(commitBody(owner.data,{state:{trips:owner.data.state.trips}}),f.headers)).status,200);
  const replay=await f.send(body);
  assert.equal(replay.status,200);
  const receipt=await replay.json();
  assert.equal(receipt.replayed,true);
  assert.equal(receipt.committedRevision,accepted.committedRevision);
  assert.ok(receipt.snapshot.revision>receipt.committedRevision);
  assert.equal(receipt.snapshot.trip.notes,'Owner packed water');
});

test('full trip collaboration uses the owner revision, refuses stale writes and protects private records',async()=>{
  const f=await guestFixture();const owner=await snapshot(f.headers);
  const read=await request(f.prefix+'/trip',{headers:{}});const baseline=await read.json();
  const edited=structuredClone(baseline.trip);edited.notes='Bring water';
  const write=(body,etag)=>request(f.prefix+'/trip',{method:'PUT',headers:etag?{'If-Match':etag}:{},body});
  assert.equal((await write({base:baseline.trip,trip:edited})).status,428);
  const saved=await write({base:baseline.trip,trip:edited},read.headers.get('etag'));assert.equal(saved.status,200);
  assert.equal((await write({base:baseline.trip,trip:edited},read.headers.get('etag'))).status,409);
  const current=await snapshot(f.headers);const trip=current.data.state.trips.trips[0];
  assert.equal(trip.notes,'Bring water');assert.deepEqual(trip.expenses[0].attachments,[{id:'receipt',filename:'private.jpg'}]);
  assert.equal((await commit(commitBody(owner.data,{state:{trips:owner.data.state.trips}}),f.headers)).status,409);
  const latest=await request(f.prefix+'/trip',{headers:{}});const bad=structuredClone(edited);
  bad.settlements=[{id:'bad',fromMemberId:'guest',toMemberId:'host',amount:'20'}];
  assert.equal((await write({base:baseline.trip,trip:bad},latest.headers.get('etag'))).status,400);
  assert.deepEqual((await snapshot(f.headers)).data,current.data);
});

test('a document edit can fill projected defaults without dropping private expense data',async()=>{
  const f=await guestFixture(), first=await f.read(), proposed=structuredClone(first.trip);
  proposed.expenses[0].notes='Window seat';
  proposed.expenses[0].category='transport';
  const response=await f.send({...guestBody(first,{kind:'updateTrip',base:first.trip,trip:proposed,confirmedSettlementIds:[]}),decimalJSONProtocol:1});
  assert.equal(response.status,200,await response.clone().text());
  const saved=(await response.json()).snapshot.trip.expenses[0];
  assert.equal(saved.notes,'Window seat');
  assert.equal(saved.category,'transport');
  const expense=(await snapshot(f.headers)).data.state.trips.trips[0].expenses[0];
  assert.equal(expense.importFingerprint,'private-import');
  assert.deepEqual(expense.futureHostOnly,{keep:true});
});

test('an invalid complete proposal applies nothing, and correction uses the same unconsumed mutation',async()=>{
  const f=await guestFixture(), first=await f.read(), proposed=structuredClone(first.trip);
  proposed.expenses[0].amount=24; proposed.expenses[0].paidByAmounts={host:24};
  proposed.checklistItems=[{id:'pack',label:42,isDone:false,createdAtISO:''}];
  const body={...guestBody(first,{kind:'updateTrip',base:first.trip,trip:proposed,confirmedSettlementIds:[]}),decimalJSONProtocol:1};
  assert.equal((await f.send(body)).status,400);
  assert.deepEqual(await f.read(),first);
  proposed.checklistItems[0].label='Pack';
  assert.equal((await f.send(body)).status,200);
});

test('a complete proposal cannot resurrect an expense removed through the owner writer',async()=>{
  const f=await guestFixture(), first=await f.read(), owner=await snapshot(f.headers);
  owner.data.state.trips.trips[0].expenses=[];
  assert.equal((await commit(commitBody(owner.data,{state:{trips:owner.data.state.trips}}),f.headers)).status,200);
  const latest=await f.read(), proposed=structuredClone(latest.trip);
  proposed.expenses=first.trip.expenses;
  const response=await f.send({...guestBody(latest,{kind:'updateTrip',base:latest.trip,trip:proposed,confirmedSettlementIds:[]}),decimalJSONProtocol:1});
  assert.equal(response.status,409);
  assert.deepEqual((await f.read()).trip.expenses,[]);
});

test('document financial edits require exact currency precision and balanced payers',async()=>{
  const f=await guestFixture(), first=await f.read();
  for (const [amount,paid] of [[1.001,1.001],[24,23]]) {
    const proposed=structuredClone(first.trip);
    proposed.expenses[0].amount=amount; proposed.expenses[0].paidByAmounts={host:paid};
    assert.equal((await f.send({...guestBody(first,{kind:'updateTrip',base:first.trip,trip:proposed,confirmedSettlementIds:[]}),decimalJSONProtocol:1})).status,400);
    assert.deepEqual(await f.read(),first);
  }
});

test('a document conversion must explain the edited amount',async()=>{
  const f=await guestFixture(), first=await f.read(), proposed=structuredClone(first.trip);
  Object.assign(proposed.expenses[0],{sourceAmount:10,sourceCurrency:'EUR',exchangeRate:3,exchangeRateTargetCurrency:'USD'});
  const body={...guestBody(first,{kind:'updateTrip',base:first.trip,trip:proposed,confirmedSettlementIds:[]}),decimalJSONProtocol:1};
  assert.equal((await f.send(body)).status,400);
  assert.deepEqual(await f.read(),first);
  proposed.expenses[0].exchangeRate=2;
  assert.equal((await f.send(body)).status,200);
});

test('changing document currency validates the precision of existing settlements',async()=>{
  const f=await guestFixture(), owner=await snapshot(f.headers);
  owner.data.state.trips.trips[0].settlements=[{id:'already-paid',fromMemberId:'guest',toMemberId:'host',amount:0.25,settledAtISO:'',notes:''}];
  assert.equal((await commit(commitBody(owner.data,{state:{trips:owner.data.state.trips}}),f.headers)).status,200);
  const first=await f.read(), proposed=structuredClone(first.trip);
  proposed.currency='JPY';
  const response=await f.send({...guestBody(first,{kind:'updateTrip',base:first.trip,trip:proposed,confirmedSettlementIds:[]}),decimalJSONProtocol:1});
  assert.equal(response.status,400,'A quarter yen cannot become a valid settlement by changing only the currency');
  assert.deepEqual(await f.read(),first);
});

test('distinct-transfer confirmation cannot reuse one settlement action identity',async()=>{
  const f=await guestFixture(), first=await f.read(), proposed=structuredClone(first.trip);
  const payment={id:'payment-one',fromMemberId:'guest',toMemberId:'host',amount:5,settledAtISO:'',notes:'',sourceActionId:'one-action'};
  proposed.settlements=[payment,{...payment,id:'payment-two'}];
  const body={...guestBody(first,{kind:'updateTrip',base:first.trip,trip:proposed,confirmedSettlementIds:['payment-one','payment-two']}),decimalJSONProtocol:1};
  assert.equal((await f.send(body)).status,409);
  assert.deepEqual(await f.read(),first);
  proposed.settlements[1].sourceActionId='second-action';
  body.operation.confirmedSettlementIds=[];
  assert.equal((await f.send(body)).status,409);
  body.operation.confirmedSettlementIds=['payment-one','payment-two'];
  assert.equal((await f.send(body)).status,200);
});

test('a lost-response retry cannot recreate a settlement deleted by another participant',async()=>{
  const f=await guestFixture();
  const read=async()=>{const r=await request(f.prefix+'/trip',{headers:{}});return {trip:(await r.json()).trip,etag:r.headers.get('etag')};};
  const write=async(base,trip)=>{const latest=await read();const r=await request(f.prefix+'/trip',{method:'PUT',headers:{'If-Match':latest.etag},body:{base,trip}});assert.equal(r.status,200);return (await r.json()).trip;};
  const first=await read();const added=structuredClone(first.trip);added.settlements=[{id:'new-settlement',fromMemberId:'guest',toMemberId:'host',amount:5}];
  const accepted=await write(first.trip,added);
  const removed=structuredClone(accepted);removed.settlements=[];await write(accepted,removed);
  const replayed=await write(first.trip,added);assert.deepEqual(replayed.settlements,[]);
});


test('invited writers cannot remove or replace the creator or delete their own participant',async()=>{
  const f=await guestFixture();
  const r=await request(f.prefix+'/trip',{headers:{}}),base=(await r.json()).trip,etag=r.headers.get('etag');
  assert.equal(base.creatorMemberId,'host');
  const send=trip=>request(f.prefix+'/trip',{method:'PUT',headers:{'If-Match':etag},body:{base,trip}});
  for(const target of ['host','guest']) {
    const edited=structuredClone(base);edited.members=edited.members.filter(m=>m.id!==target);edited.expenses=[];
    assert.equal((await send(edited)).status,403);
  }
  assert.equal((await send({...base,creatorMemberId:'guest'})).status,403);
  const current=(await (await request(f.prefix+'/trip',{headers:{}})).json()).trip;
  assert.deepEqual(current,base);
});
