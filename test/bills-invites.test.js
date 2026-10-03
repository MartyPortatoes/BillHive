'use strict';
const {test,before,after} = require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const crypto=require('node:crypto');
const Database=require('better-sqlite3');
const {SyncStore}=require('../sync-store');
const {BillsInviteSync}=require('../bills-invite-store');
let dir,child,base,db;
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
before(async()=>{
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'selfhive-bills-invites-'));
  const socket=net.createServer(); await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=socket.address().port; await new Promise(resolve=>socket.close(resolve)); base=`http://127.0.0.1:${port}`;
  child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,HOST:'127.0.0.1',PORT:String(port),
    DB_PATH:path.join(dir,'test.db'),TRUST_PROXY:'0',TRUSTED_AUTH_HEADERS:'remote-user',SYNC_REQUIRE_PRECONDITIONS:'1',
    PUBLIC_BASE_URL:'https://bills.example.test/hive'},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Bills fixture did not start')),10000);
    child.stdout.on('data',chunk=>{if(String(chunk).includes('running on')){clearTimeout(timer);resolve();}});
    child.once('exit',code=>{clearTimeout(timer);reject(Error('Bills fixture exited '+code));});
  }); db=new Database(path.join(dir,'test.db'));
});
after(async()=>{db?.close();if(child?.exitCode==null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}if(dir)fs.rmSync(dir,{recursive:true,force:true});});
async function request(url,{method='GET',body,headers={}}={}) {
  return fetch(base+url,{method,headers:{...headers,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
}
async function good(response,status=200) {assert.equal(response.status,status,await response.clone().text());return response.json();}
async function error(response,status,code) {assert.equal((await good(response,status)).code,code);}
const command=(s,extra)=>({serverInstanceId:s.serverInstanceId,householdId:s.householdId,personId:s.personId,
  baseRevision:s.revision,baseInviteRevision:s.inviteRevision,mutationId:crypto.randomUUID(),...extra});
async function fixture(currency='USD',amount=20) {
  const user='bills-owner-'+crypto.randomUUID(),headers={'remote-user':user};
  const household=()=>request('/api/sync/snapshot',{headers}).then(good);
  const read=()=>request('/api/bills/invite/guest/sync/snapshot',{headers}).then(good);
  const send=body=>request('/api/bills/invite/guest/sync/commit',{method:'POST',headers,body});
  const write=async(state,monthly={})=>{
    const s=await household();return good(await request('/api/sync/commit',{method:'POST',headers:{...headers,'X-BillHive-Decimal-JSON':'1'},
      body:{serverInstanceId:s.serverInstanceId,householdId:s.householdId,baseRevision:s.revision,mutationId:crypto.randomUUID(),decimalJSONProtocol:1,state,monthly}}));
  };
  const monthKey=new Date().toISOString().slice(0,7);
  const people=[{id:'me',name:'Host',payMethod:'paypal',payId:'HostHandle',email:'private-owner@example.invalid'},
    {id:'guest',name:'Alex',payMethod:'venmo',payId:'PrivateGuestHandle',email:'private-guest@example.invalid'}];
  await write({people,bills:[{id:'rent',name:'Rent',splitType:'fixed',paidById:'me',remainderLineId:'host-line',
    lines:[{id:'host-line',personId:'me'},{id:'guest-line',personId:'guest'}]}],settings:{currencyCode:currency},
    checklist:{[monthKey]:{received_guest:true}},requestDates:{[monthKey]:{guest:'2026-10-03T12:00:00Z'}},checks:{checks:[]},
    futurePrivate:{secret:'private-owner-secret'}},{[monthKey]:{totals:{rent:amount},amounts:{rent:{'guest-line':amount}}}});
  return {user,headers,people,household,read,send,write,monthKey};
}
async function shared(currency,amount) {
  const f=await fixture(currency,amount),created=await good(await f.send(command(await f.read(),{kind:'create'})));
  const token=created.resultToken,prefix=`/public/bills/invite/${token}`;
  return {...f,created,token,prefix,publicRead:()=>request(prefix+'/sync/snapshot').then(good),
    accept:body=>request(prefix+'/sync/accept',{method:'POST',body})};
}
const acceptCommand=s=>command(s,{shareId:s.shareId,monthKey:s.monthKey});

test('capability, currency, collection status and host payment project without guest profiles or private household fields',async()=>{
  assert.equal((await good(await request('/api/health'))).capabilities.billsInviteProtocol,1);
  const f=await shared('KWD',1.2345),s=await f.publicRead();
  assert.equal(s.currencyCode,'KWD');assert.equal(s.totalOwed,1.235);assert.equal(s.bills[0].amount,1.235);
  assert.equal(s.ownerPayment.id,'HostHandle');assert.equal(s.ownerPayment.method,'paypal');assert.equal(s.received,true);
  assert.equal(s.requestedAt,'2026-10-03T12:00:00Z');assert.equal(s.joinedAt,null);assert.equal(s.shareId,hash(f.token));
  assert.equal(JSON.stringify(s).includes('private'),false);assert.equal(s.userId,undefined);assert.equal(s.token,undefined);
  assert.equal(f.created.snapshot.inviteUrl,`https://bills.example.test/hive/public/bills/invite/${f.token}`);
  assert.equal((await request(f.prefix+'/sync/snapshot')).headers.get('cache-control'),'no-store');
  assert.equal((await good(await request('/api/bills/invite/guest/sync/snapshot',{headers:{'remote-user':'another-owner'}}))).invite,null);
});
test('exact frozen create replay after rotation returns historical outcome and current active invitation separately',async()=>{
  const f=await fixture(),before=await f.read(),body=command(before,{kind:'create'});
  const first=await good(await f.send(body)),same=await good(await f.send(command(first.snapshot,{kind:'create'})));
  assert.equal(same.resultToken,first.resultToken);assert.equal(same.committedInviteRevision,first.committedInviteRevision);
  const rotated=await good(await f.send(command(same.snapshot,{kind:'rotate'})));
  const replay=await good(await f.send(body));assert.equal(replay.replayed,true);assert.equal(replay.resultToken,first.resultToken);
  assert.equal(replay.snapshot.invite.token,rotated.resultToken);assert.equal(replay.snapshot.revision,before.revision);
  await error(await request(`/public/bills/invite/${first.resultToken}/sync/snapshot`),410,'INVITE_REVOKED');
  await error(await f.send({...body,kind:'revoke'}),409,'MUTATION_ID_REUSED');
  await error(await f.send(command(before,{kind:'rotate'})),409,'BILLS_INVITE_CONFLICT');
  await error(await f.send({...command(rotated.snapshot,{kind:'revoke'}),householdId:'different'}),409,'HOUSEHOLD_CHANGED');
});
test('lost acceptance response replays after SQLite reopen and later revocation without granting access or changing finances',async()=>{
  const f=await shared(),before=await f.publicRead(),owner=await f.household(),body=acceptCommand(before);
  const first=await good(await f.accept(body));assert.equal(first.replayed,false);assert.equal(first.snapshot.joinedAt,first.joinedAt);
  assert.ok(first.committedInviteRevision>before.inviteRevision);assert.deepEqual(await f.household(),owner);
  await good(await f.send(command(await f.read(),{kind:'revoke'})));
  const reopened=new Database(path.join(dir,'test.db'));
  try {
    const restarted=new BillsInviteSync(reopened,new SyncStore(reopened,{requirePreconditions:true}),()=>{throw Error('Revoked replay must not project bills');});
    const replay=restarted.accept(f.token,body);assert.equal(replay.replayed,true);assert.equal(replay.access,'revoked');assert.equal(replay.snapshot,null);
    assert.equal(replay.joinedAt,first.joinedAt);assert.equal(replay.committedInviteRevision,first.committedInviteRevision);
  } finally {reopened.close();}
  await error(await f.accept({...body,monthKey:'2020-01'}),409,'MUTATION_ID_REUSED');
  await error(await f.accept({...body,mutationId:crypto.randomUUID()}),410,'INVITE_REVOKED');
  assert.deepEqual(await f.household(),owner);
});
test('acceptance pins the reviewed household, invitation, and month; already accepted links accept fresh commands idempotently',async()=>{
  const f=await shared(),before=await f.publicRead();
  await f.write({settings:{currencyCode:'EUR'}});
  await error(await f.accept(acceptCommand(before)),409,'BILLS_INVITE_CONFLICT');
  const fresh=await f.publicRead();await error(await f.accept({...acceptCommand(fresh),monthKey:'2020-01'}),409,'BILLS_INVITE_CONFLICT');
  const joined=await good(await f.accept(acceptCommand(fresh)));
  const again=await good(await f.accept(acceptCommand(joined.snapshot)));assert.equal(again.joinedAt,joined.joinedAt);
  assert.equal(again.committedInviteRevision,joined.committedInviteRevision);
  await error(await f.send(command(before,{kind:'rotate'})),409,'BILLS_INVITE_CONFLICT');
});
test('legacy writes obey preconditions and update native invitation revisions while compatibility mode still permits old clients',async()=>{
  const f=await fixture();await error(await request('/api/bills/invite',{method:'POST',headers:f.headers,body:{personId:'guest'}}),428,'PRECONDITION_REQUIRED');
  const r=await request('/api/bills/invite/guest/sync/snapshot',{headers:f.headers});
  const created=await good(await request('/api/bills/invite',{method:'POST',headers:{...f.headers,'If-Match':r.headers.get('etag')},body:{personId:'guest'}}));
  const prefix=`/public/bills/invite/${created.token}`;
  await error(await request(prefix+'/join',{method:'POST'}),428,'PRECONDITION_REQUIRED');
  const preview=await request(prefix);await good(await request(prefix+'/join',{method:'POST',headers:{'If-Match':preview.headers.get('etag')}}));
  assert.ok((await f.read()).invite.joinedAt);const snapshot=await request('/api/bills/invite/guest/sync/snapshot',{headers:f.headers});
  await good(await request('/api/bills/invite/guest',{method:'DELETE',headers:{...f.headers,'If-Match':snapshot.headers.get('etag')}}));
  assert.equal((await f.read()).invite,null);
  const compat=new BillsInviteSync(db,new SyncStore(db,{requirePreconditions:false}),()=>({monthKey:'2026-10',bills:[],totalOwed:0}));
  const link=compat.ownerLegacy(f.user,'guest','create');assert.ok(compat.acceptLegacy(link.invite.token).joinedAt);
  assert.throws(()=>compat.ownerCommit(f.user,'guest',command(compat.ownerSnapshot(f.user,'guest'),{kind:'rotate'})),e=>e.code==='PROTECTION_DISABLED');
});
test('person deletion revokes the link atomically and restoring the same person ID cannot resurrect it',async()=>{
  const f=await shared(),snapshot=await f.publicRead();
  await f.write({people:f.people.filter(p=>p.id!=='guest')});assert.equal((await f.read()).invite,null);
  await f.write({people:f.people});await error(await request(f.prefix+'/sync/snapshot'),410,'INVITE_REVOKED');
  await error(await request(f.prefix+'/data'),410,'INVITE_REVOKED');
  await error(await f.accept(acceptCommand(snapshot)),410,'INVITE_REVOKED');
  assert.throws(()=>db.prepare('UPDATE bills_invites SET revoked_at=NULL WHERE token=?').run(f.token),/permanent/);
});
test('legacy joins and another SQLite connection advance the separate invitation revision and cannot clear acceptance',async()=>{
  const f=await shared(),before=await f.read();
  const other=new Database(path.join(dir,'test.db'));
  try {other.prepare('UPDATE bills_invites SET joined_at=unixepoch() WHERE token=?').run(f.token);
    assert.ok((await f.read()).inviteRevision>before.inviteRevision);
    assert.throws(()=>other.prepare('UPDATE bills_invites SET joined_at=NULL WHERE token=?').run(f.token),/permanent/);
  } finally {other.close();}
  await error(await f.send(command(before,{kind:'rotate'})),409,'BILLS_INVITE_CONFLICT');
});
test('large exact signed totals, fractional currencies, zero balances and malformed commands retain their meaning',async()=>{
  const f=await shared('CLF',0),month=f.monthKey;
  db.prepare('UPDATE monthly_data SET data=? WHERE user_id=? AND month_key=?').run(
    '{"totals":{"rent":999999999999.0003},"amounts":{"rent":{"guest-line":999999999999.0003}}}',f.user,month);
  const response=await request(f.prefix+'/sync/snapshot'),raw=await response.text();assert.ok(raw.includes('999999999999.0003'));
  await f.write({bills:[{id:'rent',name:'Rent',splitType:'pct',paidById:'guest',lines:[{id:'host-line',personId:'me',value:100}]}]},
    {[month]:{totals:{rent:3.1234}}});assert.equal((await f.publicRead()).totalOwed,-3.1234);
  for(const body of [{...command(await f.read(),{kind:'create'}),extra:'no'},command(await f.read(),{kind:'unknown'}),
    {...command(await f.read(),{kind:'create'}),baseInviteRevision:-1}]) await error(await f.send(body),400,'INVALID_BILLS_COMMAND');
  await error(await request('/api/bills/invite/me/sync/snapshot',{headers:f.headers}),400,'INVALID_BILLS_PERSON');
});

test('receipt persistence and invitation mutation share one transaction for owner and guest failures',async()=>{
  const f=await shared(),before=await f.read(),publicBefore=await f.publicRead();
  db.exec("CREATE TRIGGER fail_bills_owner_receipt BEFORE INSERT ON bills_invite_owner_receipts BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END;");
  try {assert.equal((await f.send(command(before,{kind:'rotate'}))).status,500);assert.deepEqual(await f.read(),before);}
  finally {db.exec('DROP TRIGGER fail_bills_owner_receipt');}
  db.exec("CREATE TRIGGER fail_bills_join_receipt BEFORE INSERT ON bills_invite_join_receipts BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END;");
  try {assert.equal((await f.accept(acceptCommand(publicBefore))).status,500);assert.deepEqual(await f.publicRead(),publicBefore);}
  finally {db.exec('DROP TRIGGER fail_bills_join_receipt');}
});
test('revision overflow rolls back rotation without revoking or replacing the active token',async()=>{
  const f=await shared();db.prepare('UPDATE bills_invite_revisions SET revision=? WHERE user_id=? AND person_id=?').run(9007199254740991,f.user,'guest');
  const before=await f.read();assert.equal((await f.send(command(before,{kind:'rotate'}))).status,500);
  assert.deepEqual(await f.read(),before);assert.equal((await f.publicRead()).shareId,hash(f.token));
});
test('upgrade of existing invitation rows seeds revisions and permanently closes orphan links without replacing receipts',async()=>{
  const legacy=new Database(':memory:');
  try {
    legacy.exec(`CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE user_state(user_id TEXT,key TEXT,value TEXT,updated_at INTEGER DEFAULT 0,PRIMARY KEY(user_id,key));
      CREATE TABLE monthly_data(user_id TEXT,month_key TEXT,data TEXT,updated_at INTEGER DEFAULT 0,PRIMARY KEY(user_id,month_key));`);
    const sync=new SyncStore(legacy,{requirePreconditions:true});
    legacy.exec(`CREATE TABLE bills_invites(token TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,person_id TEXT NOT NULL,
      joined_at INTEGER,created_at INTEGER NOT NULL DEFAULT(unixepoch()),revoked_at INTEGER);`);
    const metadata=sync.snapshot('legacy-owner');
    sync.commit('legacy-owner',{serverInstanceId:metadata.serverInstanceId,householdId:metadata.householdId,baseRevision:metadata.revision,
      mutationId:crypto.randomUUID(),state:{people:[{id:'me',name:'Host'},{id:'guest',name:'Alex'}]},monthly:{}});
    legacy.prepare('INSERT INTO bills_invites(token,owner_user_id,person_id) VALUES(?,?,?)').run('legacy-token-1234567890','legacy-owner','guest');
    legacy.prepare('INSERT INTO bills_invites(token,owner_user_id,person_id) VALUES(?,?,?)').run('orphan-token-1234567890','legacy-owner','removed');
    const first=new BillsInviteSync(legacy,sync,()=>({}));assert.equal(first.ownerSnapshot('legacy-owner','guest').inviteRevision,1);
    assert.equal(first.context('orphan-token-1234567890').access,'revoked');
    const body=command(first.ownerSnapshot('legacy-owner','guest'),{kind:'create'});const receipt=first.ownerCommit('legacy-owner','guest',body);
    const second=new BillsInviteSync(legacy,new SyncStore(legacy,{requirePreconditions:false}),()=>({}));
    assert.equal(second.ownerCommit('legacy-owner','guest',body).resultToken,receipt.resultToken);
    assert.equal(second.ownerCommit('legacy-owner','guest',body).replayed,true);
  } finally {legacy.close();}
});
