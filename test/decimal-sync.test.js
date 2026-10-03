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
const Decimal = require('../decimal-json');
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
test('exact owner HTTP commits retain amounts, rates, weights and unknown fields without mutation aliasing', async () => {
  const headers = {'remote-user':'decimal-owner-' + crypto.randomUUID(), 'X-BillHive-Decimal-JSON':'1'};
  const first = await snapshot(headers);
  const monthly = Decimal.parse('{"2026-10":{"totals":{"rent":999999999999.0003},"amounts":{"rent":{"line":999999999999.0003}},"futureRate":1.333333333333333333333333333333}}');
  const state = Decimal.parse('{"settings":{"currencyCode":"CLF"},"future":{"weight":9007199254740993,"rate":0.123456789012345678901}}');
  const body = commitBody(first.data,{state,monthly});
  const response = await commit(body,headers); assert.equal(response.status,200);
  const result = Decimal.parse(await response.text());
  assert.equal(result.decimalJSONProtocol,1);
  assert.equal(result.requiresDecimalClient,true);
  assert.equal(String(result.monthly['2026-10'].totals.rent),'999999999999.0003');
  const read = Decimal.parse(await (await request('/api/sync/snapshot',{headers})).text());
  assert.equal(Decimal.canonical(read.state),Decimal.canonical(state));
  assert.equal(Decimal.canonical(read.monthly),Decimal.canonical(monthly));
  const alias = {...body,monthly:Decimal.parse(JSON.stringify(monthly).replaceAll('999999999999.0003','999999999999.0002'))};
  const rejected = await commit(alias,headers); assert.equal(rejected.status,409); assert.equal((await rejected.json()).code,'MUTATION_ID_REUSED');
  const another = await commit(commitBody(read,{state:{futureNote:'later'}}),headers); assert.equal(another.status,200);
  const replay = await commit(body,headers); assert.equal(replay.status,200);
  const replayed = Decimal.parse(await replay.text()); assert.equal(replayed.replayed,true); assert.equal(replayed.state.futureNote,'later');
  assert.equal(replayed.committedRevision,result.committedRevision);
  assert.equal(String(replayed.monthly['2026-10'].totals.rent),'999999999999.0003');
  const exported = Decimal.parse(await (await request('/api/export',{headers})).text());
  assert.equal(Decimal.canonical(exported.monthly),Decimal.canonical(monthly));
  const preflight = await request('/api/sync/restore/validate',{method:'POST',headers,body:commitBody(replayed,{state:replayed.state,monthly:replayed.monthly})});
  assert.equal(preflight.status,200);
  const legacyHeaders = {'remote-user':headers['remote-user']};
  const staleClient = await commit(commitBody(replayed,{state:{futureNote:'rounded browser replacement'}}),legacyHeaders);
  assert.equal(staleClient.status,428); assert.equal((await staleClient.json()).code,'DECIMAL_CLIENT_REQUIRED');
  const legacy = await request('/api/months/2026-10',{method:'PUT',headers:{...legacyHeaders,'If-Match':(await snapshot(headers)).etag},body:JSON.parse(JSON.stringify(monthly['2026-10']))});
  assert.equal(legacy.status,428); assert.equal((await legacy.json()).code,'DECIMAL_CLIENT_REQUIRED');
  const final = Decimal.parse(await (await request('/api/sync/snapshot',{headers})).text());
  assert.equal(String(final.monthly['2026-10'].totals.rent),'999999999999.0003');
});

test('browser revision client refuses a precise snapshot before accepting a rounded editable baseline', () => {
  const RevisionClient = require('../public/revision-client');
  const client = new RevisionClient(async () => { throw new Error('No write should be attempted'); });
  const snapshot = {protocolVersion:1,decimalJSONProtocol:1,requiresDecimalClient:true,revision:1,serverInstanceId:'server',householdId:'household',userId:'owner',state:{},monthly:{}};
  assert.throws(() => client.load(snapshot),error => error.code === 'DECIMAL_CLIENT_REQUIRED');
  assert.equal(client.baseline,null); assert.equal(client.attempt,null);
  client.load({...snapshot,requiresDecimalClient:false}); assert.equal(client.baseline.revision,1);
});

test('exact guest HTTP edits preserve private decimals and format large CLF activity without rounding through Number', async () => {
  const fixture = await guestFixture();
  const owner = await snapshot(fixture.headers);
  const trip = owner.data.state.trips.trips[0]; trip.currency='CLF';
  trip.expenses[0].futureHostOnly = Decimal.parse('{"rate":1.333333333333333333333333333333}');
  assert.equal((await commit(commitBody(owner.data,{state:{trips:{trips:[trip]}}}),{...fixture.headers,'X-BillHive-Decimal-JSON':'1'})).status,200);
  const baseline = await fixture.read();
  const expense = Decimal.parse('{"id":"expense","name":"Exact train","amount":999999999999.0003,"paidByAmounts":{"host":999999999999.0003},"splitBetweenIds":["host","guest"],"sourceAmount":1.234567890123456789,"exchangeRate":1.333333333333333333333333333333}');
  const body = guestBody(baseline,{kind:'upsertExpense',expense});
  const send = body => request(fixture.prefix+'/sync/commit',{method:'POST',headers:{'X-BillHive-Require-Protection':'1','X-BillHive-Decimal-JSON':'1'},body});
  const response = await send(body); assert.equal(response.status,200);
  const saved = Decimal.parse(await response.text());
  assert.equal(saved.decimalJSONProtocol,1); assert.equal(saved.snapshot.decimalJSONProtocol,1);
  assert.equal(String(saved.snapshot.trip.expenses[0].amount),'999999999999.0003');
  assert.equal(String(saved.snapshot.trip.expenses[0].exchangeRate),'1.333333333333333333333333333333');
  assert.equal(saved.snapshot.trip.expenses[0].futureHostOnly,undefined);
  const exactOwner = Decimal.parse(await (await request('/api/sync/snapshot',{headers:fixture.headers})).text());
  const confirmedTrip = exactOwner.state.trips.trips[0];
  assert.equal(String(confirmedTrip.expenses[0].futureHostOnly.rate),'1.333333333333333333333333333333');
  assert.equal(confirmedTrip.activity[0].amountText,'CLF 999999999999.0003');
  const alias = {...body,operation:{kind:'upsertExpense',expense:Decimal.parse(JSON.stringify(expense).replaceAll('999999999999.0003','999999999999.0002'))}};
  const rejected = await send(alias); assert.equal(rejected.status,409); assert.equal((await rejected.json()).code,'MUTATION_ID_REUSED');
  const old = await fixture.send(guestBody(saved.snapshot,{kind:'upsertExpense',expense:{...JSON.parse(JSON.stringify(expense)),notes:'old client'}}));
  assert.equal(old.status,428); assert.equal((await old.json()).code,'DECIMAL_CLIENT_REQUIRED');
  const replay = await send(body); assert.equal(replay.status,200); assert.equal((await replay.json()).replayed,true);
});

test('receipt migration replays safe old requests and refuses decimal aliases from old rounded hashes', async () => {
  const headers = {'remote-user':'decimal-migration-' + crypto.randomUUID(),'X-BillHive-Decimal-JSON':'1'};
  const first = await snapshot(headers);
  const safe = commitBody(first.data,{state:{future:{value:1.23}}});
  const response = await commit(safe,headers); assert.equal(response.status,200);
  const saved = await response.json();
  const db = new Database(path.join(dir,'test.db'));
  try {
    const hash = input => crypto.createHash('sha256').update(Decimal.legacyCanonical({...input,deleteStateKeys:[],deleteMonths:[]})).digest('hex');
    db.prepare('UPDATE sync_receipts SET hash_version=1,request_hash=? WHERE user_id=? AND mutation_id=?').run(hash(safe),headers['remote-user'],safe.mutationId);
    const replay = await commit(safe,headers); assert.equal(replay.status,200); assert.equal((await replay.json()).replayed,true);
    const ambiguous = commitBody(saved,{monthly:Decimal.parse('{"2026-10":{"totals":{"rent":999999999999.0003},"amounts":{}}}')});
    db.prepare('INSERT INTO sync_receipts(user_id,mutation_id,request_hash,revision,hash_version) VALUES (?,?,?,?,1)').run(headers['remote-user'],ambiguous.mutationId,hash(ambiguous),saved.revision);
    for (const body of [ambiguous,{...ambiguous,monthly:Decimal.parse(JSON.stringify(ambiguous.monthly).replace('.0003','.0002'))}]) {
      const retry = await commit(body,headers); assert.equal(retry.status,409); assert.equal((await retry.json()).code,'LEGACY_DECIMAL_RECEIPT_AMBIGUOUS');
    }
    assert.deepEqual((await snapshot(headers)).data.monthly,{});
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_receipts WHERE user_id=?').get(headers['remote-user']).n,2);
  } finally { db.close(); }
});

test('public Bills and Check sharing projections retain large four-digit money after owner writes', async () => {
  const headers = {'remote-user':'decimal-public-' + crypto.randomUUID(),'X-BillHive-Decimal-JSON':'1'};
  const first = await snapshot(headers), month = new Date().toISOString().slice(0,7);
  const state = Decimal.parse('{"settings":{"currencyCode":"CLF"},"people":[{"id":"me","name":"Host"},{"id":"guest","name":"Guest"}],"bills":[{"id":"rent","name":"Rent","splitType":"fixed","paidById":"me","remainderLineId":"host-line","lines":[{"id":"host-line","personId":"me"},{"id":"guest-line","personId":"guest"}]}],"checks":{"checks":[{"id":"dinner","name":"Dinner","items":[{"id":"item","name":"Dinner","price":999999999999.0003}],"participants":[]}]}}');
  const monthly = {[month]:Decimal.parse('{"totals":{"rent":999999999999.0003},"amounts":{"rent":{"guest-line":999999999999.0003}}}')};
  assert.equal((await commit(commitBody(first.data,{state,monthly}),headers)).status,200);
  const inviteBaseline = await request('/api/bills/invite/guest/sync/snapshot',{headers});
  const inviteResponse = await request('/api/bills/invite',{method:'POST',headers:{...headers,'If-Match':inviteBaseline.headers.get('etag')},body:{personId:'guest'}}); assert.equal(inviteResponse.status,200);
  const invite = await inviteResponse.json();
  const preview = await request(`/public/bills/invite/${invite.token}`,{headers:{}});
  assert.equal((await request(`/public/bills/invite/${invite.token}/join`,{method:'POST',headers:{'If-Match':preview.headers.get('etag')}})).status,200);
  const billsResponse = await request(`/public/bills/invite/${invite.token}/data`,{headers:{}}); assert.equal(billsResponse.status,200);
  const bills = Decimal.parse(await billsResponse.text());
  assert.equal(bills.currencyCode,'CLF');
  assert.equal(String(bills.totalOwed),'999999999999.0003'); assert.equal(String(bills.bills[0].amount),'999999999999.0003');
  const ownerShare = await request('/api/share/check/dinner/sync/snapshot',{headers}); assert.equal(ownerShare.status,200);
  const created = await request('/api/share/check/dinner',{method:'POST',headers:{...headers,'If-Match':ownerShare.headers.get('etag')},body:{}}); assert.equal(created.status,200);
  const share = await created.json();
  const publicResponse = await request(`/public/share/check/${share.token}/sync/snapshot`,{headers:{}}); assert.equal(publicResponse.status,200);
  const check = Decimal.parse(await publicResponse.text());
  assert.equal(String(check.check.items[0].price),'999999999999.0003');
  assert.equal(check.userId,undefined); assert.equal(check.state,undefined);
});
