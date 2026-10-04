'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const net=require('node:net');const crypto=require('node:crypto');
const Database=require('better-sqlite3');
const {SyncStore}=require('../sync-store');const {AttachmentStore}=require('../attachment-store');
const {HouseholdResetStore}=require('../household-reset-store');
let child,base,dir,port;
async function start(){
 child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DB_PATH:path.join(dir,'test.db'),TRUST_PROXY:'0',TRUSTED_AUTH_HEADERS:'remote-user',SYNC_REQUIRE_PRECONDITIONS:'1'},stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Reset fixture did not start')),10000);child.stdout.on('data',s=>{if(String(s).includes('running on')){clearTimeout(timer);resolve();}});child.on('exit',code=>{clearTimeout(timer);reject(new Error(`Fixture exit ${code}`));});});
}
async function stop(){if(child?.exitCode==null){child.kill();await new Promise(r=>child.once('exit',r));}}
before(async()=>{
 dir=fs.mkdtempSync(path.join(os.tmpdir(),'selfhive-reset-'));
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));port=socket.address().port;await new Promise(r=>socket.close(r));base=`http://127.0.0.1:${port}`;await start();
});
after(async()=>{await stop();fs.rmSync(dir,{recursive:true,force:true});});
function withDB(action){const db=new Database(path.join(dir,'test.db'));try{return action(db);}finally{db.close();}}
function stores(db){const sync=new SyncStore(db,{requirePreconditions:true});const files=new AttachmentStore(db,sync);sync.validateReferences=u=>files.validateReferences(u);const reset=new HouseholdResetStore(db,sync,files,dir);return {sync,files,reset};}
const etag=s=>`"bh1:${s.serverInstanceId}:${s.householdId}:${s.revision}"`;
async function expect(response,status,code){assert.equal(response.status,status,await response.clone().text());const body=await response.json();if(code)assert.equal(body.code,code);return body;}
async function fixture(){
 const user='reset-'+crypto.randomUUID(), headers={'remote-user':user};
 const get=url=>fetch(base+url,{headers});
 const read=async()=>expect(await get('/api/sync/snapshot'),200);
 const post=(url,body,extra={})=>fetch(base+url,{method:'POST',headers:{...headers,'content-type':'application/json',...extra},body:JSON.stringify(body)});
 const ordinary=(s,state=s.state,monthly=s.monthly)=>post('/api/sync/commit',{serverInstanceId:s.serverInstanceId,householdId:s.householdId,baseRevision:s.revision,mutationId:crypto.randomUUID(),state,monthly});
 const state={people:[{id:'me',name:'Owner'},{id:'person',name:'Invited'}],settings:{currencyCode:'USD'},future:{unknown:'must clear'},
  checks:{checks:[{id:'check',name:'Dinner',items:[]}]},trips:{trips:[{id:'trip',name:'Vacation',currency:'USD',members:[{id:'member',name:'Guest'}],
   expenses:[{id:'expense',name:'Receipt',amount:0,paidByAmounts:{}}],itinerary:[{id:'event',title:'Tickets',attachments:[{id:'legacy',filename:'legacy.pdf',mimeType:'application/pdf'}]}]}]}};
 await expect(await ordinary(await read(),state,{'2026-09':{totals:{},futureHistory:'must clear'}}),200);
 const snapshot=await read();
 const identity={'X-BillHive-User':user,'X-BillHive-Server':snapshot.serverInstanceId,'X-BillHive-Household':snapshot.householdId};
 const managedBytes=Buffer.from('%PDF-1.4\nManaged content\n%%EOF');
 const descriptor={id:'managed',filename:'managed.pdf',mimeType:'application/pdf',storageVersion:1,sha256:crypto.createHash('sha256').update(managedBytes).digest('hex'),sizeBytes:managedBytes.length};
 const managedURL='/api/sync/attachments/itinerary/trip/event/managed.pdf';
 const upload=(extra={},body=managedBytes,url=managedURL)=>fetch(base+url,{method:'PUT',headers:{...headers,...identity,'content-type':'application/octet-stream','X-Attachment-Id':descriptor.id,'X-Attachment-Type':descriptor.mimeType,'X-Attachment-SHA256':crypto.createHash('sha256').update(body).digest('hex'),...extra},body});
 await expect(await upload(),200); // deliberately staged, not yet published
 const legacyURL='/api/trips/trip/itinerary/event/attachments';
 const legacyUpload=(body='legacy original',extra={})=>fetch(base+legacyURL,{method:'POST',headers:{...headers,'content-type':'application/pdf','x-attachment-id':'legacy','x-filename':'legacy.pdf',...extra},body});
 await expect(await legacyUpload(),200);
 const receiptURL='/api/trips/trip/expenses/expense/attachments';
 await expect(await fetch(base+receiptURL,{method:'POST',headers:{...headers,'content-type':'image/jpeg','x-attachment-id':'receipt'},body:Buffer.from([255,216,255,217])}),200);
 const tokens={check:crypto.randomBytes(32).toString('hex'),trip:crypto.randomBytes(32).toString('hex'),bills:crypto.randomBytes(32).toString('hex')};
 withDB(db=>{
  db.prepare('INSERT INTO share_checks(token,user_id,check_id,claims) VALUES (?,?,?,?)').run(tokens.check,user,'check','[]');
  db.prepare('INSERT INTO trip_invites(token,owner_user_id,trip_id,member_id) VALUES (?,?,?,?)').run(tokens.trip,user,'trip','member');
  db.prepare('INSERT INTO bills_invites(token,owner_user_id,person_id) VALUES (?,?,?)').run(tokens.bills,user,'person');
  db.prepare('INSERT INTO email_config(user_id,config) VALUES (?,?)').run(user,'{"provider":"fixture"}');
 });
 const preview=async()=>expect(await get('/api/sync/reset/preview'),200);
 const request=p=>({serverInstanceId:p.serverInstanceId,householdId:p.householdId,baseRevision:p.revision,mutationId:crypto.randomUUID(),decimalJSONProtocol:1,
  state:{},monthly:{},deleteStateKeys:Object.keys(p.state),deleteMonths:Object.keys(p.monthly),householdReset:{protocolVersion:1,guard:p.householdReset.guard,summary:p.householdReset.summary}});
 const commit=body=>post('/api/sync/commit',body);
 const cleanup=body=>post(`/api/sync/reset/${body.mutationId}/cleanup`,{},identity);
 const legacyFile=path.join(dir,'trip-itinerary-attachments',user,'event','legacy.pdf');
 const receiptFile=path.join(dir,'trip-receipts',user,'expense','receipt.jpg');
 return {user,headers,identity,read,post,ordinary,state,get,preview,request,commit,cleanup,tokens,managedBytes,descriptor,managedURL,upload,legacyUpload,legacyURL,legacyFile,receiptFile};
}
test('protected reset atomically clears every key/month, revokes all link kinds and purges staged bytes in one owner scope',async()=>{
 const f=await fixture(), peer=await fixture();const peerBefore=await peer.read();
 assert.equal((await expect(await f.get('/api/health'),200)).capabilities.householdResetProtocol,1);
 const p=await f.preview();assert.equal(p.householdReset.summary.stateKeys,5);assert.equal(p.householdReset.summary.months,1);
 assert.deepEqual([p.householdReset.summary.checkLinks,p.householdReset.summary.tripLinks,p.householdReset.summary.billsLinks],[1,1,1]);
 assert.equal(p.householdReset.summary.managedFiles,1);assert.equal(p.householdReset.summary.legacyFiles,2);
 const input=f.request(p);const result=await expect(await f.commit(input),200);
 assert.deepEqual(result.state,{});assert.deepEqual(result.monthly,{});assert.ok(result.committedRevision>p.revision);assert.equal(result.replayed,false);
 assert.deepEqual(result.householdReset.cleanup,{pending:2,removed:0,retained:0,failed:0});
 assert.equal(fs.readFileSync(f.legacyFile,'utf8'),'legacy original','disk cleanup waits for an explicit receipt-bound action');
 await expect(await fetch(base+'/public/share/check/'+f.tokens.check+'/sync/snapshot'),410,'SHARE_REVOKED');
 await expect(await fetch(base+'/public/trip/invite/'+f.tokens.trip+'/sync/snapshot'),410,'INVITE_REVOKED');
 await expect(await fetch(base+'/public/bills/invite/'+f.tokens.bills+'/sync/snapshot'),410,'INVITE_REVOKED');
 await expect(await fetch(base+f.managedURL,{headers:{...f.headers,...f.identity}}),410,'ATTACHMENT_PURGED');
 await expect(await f.get(f.legacyURL+'/legacy.pdf'),404,'ATTACHMENT_PARENT_REMOVED');
 withDB(db=>{
  const row=db.prepare('SELECT * FROM trip_attachment_blobs WHERE user_id=?').get(f.user);assert.equal(row.bytes.length,0);assert.ok(row.purged_at);
  assert.equal(db.prepare('SELECT config FROM email_config WHERE user_id=?').get(f.user).config,'{"provider":"fixture"}');
 });
 const cleaned=await expect(await f.cleanup(input),200);assert.deepEqual(cleaned.householdReset.cleanup,{pending:0,removed:2,retained:0,failed:0});
 assert.ok(!fs.existsSync(f.legacyFile));assert.ok(!fs.existsSync(f.receiptFile));assert.deepEqual(await peer.read(),peerBefore);
 assert.equal(fs.readFileSync(peer.legacyFile,'utf8'),'legacy original');
});
test('new reset requires protection even without the client protection header; its exact receipt remains usable later',async()=>{
 const f=await fixture();const p=await f.preview(),input=f.request(p);
 withDB(db=>{const {sync,reset}=stores(db);sync.requirePreconditions=false;assert.throws(()=>reset.preview(f.user),e=>e.code==='PROTECTION_DISABLED');assert.throws(()=>sync.commit(f.user,input),e=>e.code==='PROTECTION_DISABLED');});
 const result=await expect(await f.commit(input),200);
 withDB(db=>{const {sync}=stores(db);sync.requirePreconditions=false;const replay=sync.commit(f.user,input);assert.equal(replay.replayed,true);assert.equal(replay.committedRevision,result.committedRevision);});
});
test('an abort after purge rolls records, link revocations, bytes, cleanup tasks and receipts back together',async()=>{
 const f=await fixture(),p=await f.preview(),input=f.request(p);const before=await f.read();
 withDB(db=>db.exec(`CREATE TRIGGER reset_abort BEFORE INSERT ON household_reset_receipts BEGIN SELECT RAISE(ABORT,'reset fixture abort'); END`));
 try {await expect(await f.commit(input),500);}
 finally {withDB(db=>db.exec('DROP TRIGGER reset_abort'));}
 assert.deepEqual(await f.read(),before);assert.equal(fs.readFileSync(f.legacyFile,'utf8'),'legacy original');
 withDB(db=>{for(const [table,column] of [['share_checks','user_id'],['trip_invites','owner_user_id'],['bills_invites','owner_user_id']]) assert.equal(db.prepare(`SELECT revoked_at FROM ${table} WHERE ${column}=?`).get(f.user).revoked_at,null);
  assert.deepEqual(db.prepare('SELECT bytes FROM trip_attachment_blobs WHERE user_id=?').get(f.user).bytes,f.managedBytes);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM household_reset_files WHERE user_id=?').get(f.user).n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_receipts WHERE user_id=? AND mutation_id=?').get(f.user,input.mutationId).n,0);
 });
 await expect(await f.commit(input),200);
});
test('claims, invitation acceptance and new staged bytes invalidate review without changing the household revision',async()=>{
 const f=await fixture();let p=await f.preview();const originalRevision=p.revision;
 withDB(db=>db.prepare('UPDATE share_checks SET claims=? WHERE token=?').run('[{"claimerName":"Guest","itemIds":[],"claimedAt":"2026-10-04"}]',f.tokens.check));
 await expect(await f.commit(f.request(p)),409,'RESET_REVIEW_CHANGED');assert.equal((await f.read()).revision,originalRevision);
 p=await f.preview();withDB(db=>db.prepare('UPDATE trip_invites SET joined_at=unixepoch() WHERE token=?').run(f.tokens.trip));
 await expect(await f.commit(f.request(p)),409,'RESET_REVIEW_CHANGED');
 p=await f.preview();withDB(db=>db.prepare('UPDATE bills_invites SET joined_at=unixepoch() WHERE token=?').run(f.tokens.bills));
 await expect(await f.commit(f.request(p)),409,'RESET_REVIEW_CHANGED');
 p=await f.preview();await expect(await f.upload({'X-Attachment-Id':'new'},Buffer.from('new'),f.managedURL.replace('managed.pdf','new.pdf')),200);
 await expect(await f.commit(f.request(p)),409,'RESET_REVIEW_CHANGED');assert.equal((await f.read()).revision,originalRevision);
});
test('changed disk bytes or owner JSON invalidate review and leave the saved household intact',async()=>{
 const f=await fixture();let p=await f.preview();fs.writeFileSync(f.legacyFile,'replacement');
 await expect(await f.commit(f.request(p)),409,'RESET_REVIEW_CHANGED');assert.equal(fs.readFileSync(f.legacyFile,'utf8'),'replacement');
 p=await f.preview();const changed=await f.read();changed.state.future.unknown='newer';await expect(await f.ordinary(changed),200);
 await expect(await f.commit(f.request(p)),409,'REVISION_CONFLICT');assert.equal((await f.read()).state.future.unknown,'newer');
});
test('malformed markers, partial deletion lists, nonempty replacement and wrong owner identity fail before mutation',async()=>{
 const f=await fixture(),p=await f.preview(),input=f.request(p),before=await f.read();
 for (const patch of [{householdReset:{protocolVersion:2,guard:input.householdReset.guard}}, {householdReset:{...input.householdReset,unknown:true}},
  {householdReset:{protocolVersion:1,guard:'bad'}},{state:{future:{}}},{monthly:{'2026-10':{}}},{deleteStateKeys:[]},{deleteMonths:[]},
  {checkSharePreconditions:[{checkId:'check',shareId:null,shareRevision:0}]}]) await expect(await f.commit({...input,...patch}),400,'INVALID_RESET');
 await expect(await f.commit({...input,householdId:'other'}),409,'HOUSEHOLD_CHANGED');
 await expect(await f.post('/api/sync/restore/validate',input),400,'INVALID_RESTORE');assert.deepEqual(await f.read(),before);
});
test('a changed request cannot reuse a reset mutation ID and cleanup pins the authenticated household',async()=>{
 const f=await fixture(),peer=await fixture(),input=f.request(await f.preview());await expect(await f.commit(input),200);
 await expect(await f.commit({...input,householdReset:{...input.householdReset,guard:'0'.repeat(64)}}),409,'MUTATION_ID_REUSED');
 await expect(await f.post(`/api/sync/reset/${input.mutationId}/cleanup`,{}, {...f.identity,'X-BillHive-Household':'other'}),409,'HOUSEHOLD_CHANGED');
 await expect(await peer.post(`/api/sync/reset/${input.mutationId}/cleanup`,{},peer.identity),404,'RESET_RECEIPT_NOT_FOUND');
 assert.ok(fs.existsSync(f.legacyFile));
});
test('cleanup retries after rollback tolerate an already missing file and preserve changed files',async()=>{
 const f=await fixture(),input=f.request(await f.preview());await expect(await f.commit(input),200);fs.writeFileSync(f.legacyFile,'new copy');
 withDB(db=>db.exec(`CREATE TRIGGER cleanup_abort BEFORE UPDATE ON household_reset_files WHEN NEW.status='removed' BEGIN SELECT RAISE(ABORT,'cleanup fixture abort'); END`));
 try {await expect(await f.cleanup(input),500);}finally{withDB(db=>db.exec('DROP TRIGGER cleanup_abort'));}
 assert.ok(!fs.existsSync(f.receiptFile),'unlink completed before the simulated SQLite task rollback');
 const cleaned=await expect(await f.cleanup(input),200);assert.deepEqual(cleaned.householdReset.cleanup,{pending:0,removed:1,retained:1,failed:0});
 assert.equal(fs.readFileSync(f.legacyFile,'utf8'),'new copy');
});
test('cleanup retains even the original bytes when a newer restored reference owns the file',async()=>{
 const f=await fixture(),input=f.request(await f.preview());await expect(await f.commit(input),200);
 await expect(await f.ordinary(await f.read(),{trips:f.state.trips}),200);
 const cleaned=await expect(await f.cleanup(input),200);assert.equal(cleaned.householdReset.cleanup.retained,1);assert.equal(fs.readFileSync(f.legacyFile,'utf8'),'legacy original');
 const file=await f.get(f.legacyURL+'/legacy.pdf');assert.equal(file.status,200);assert.equal(await file.text(),'legacy original');
});
test('symlink directories and files cannot cross an owner scope; unsafe cleanup remains retryable',async()=>{
 const f=await fixture();const outside=path.join(dir,'outside-'+crypto.randomUUID());fs.writeFileSync(outside,'outside untouched');
 fs.unlinkSync(f.legacyFile);fs.symlinkSync(outside,f.legacyFile);await expect(await f.get('/api/sync/reset/preview'),409,'UNSAFE_ATTACHMENT_FILE');
 fs.unlinkSync(f.legacyFile);fs.writeFileSync(f.legacyFile,'original again');const input=f.request(await f.preview());await expect(await f.commit(input),200);
 fs.unlinkSync(f.legacyFile);fs.symlinkSync(outside,f.legacyFile);const first=await expect(await f.cleanup(input),200);assert.equal(first.householdReset.cleanup.failed,1);
 assert.equal(fs.readFileSync(outside,'utf8'),'outside untouched');fs.unlinkSync(f.legacyFile);fs.writeFileSync(f.legacyFile,'new safely owned copy');
 const retry=await expect(await f.cleanup(input),200);assert.equal(retry.householdReset.cleanup.failed,0);assert.equal(retry.householdReset.cleanup.retained,1);
 const peer=await fixture(),recordDir=path.dirname(peer.legacyFile);fs.rmSync(recordDir,{recursive:true});fs.symlinkSync(dir,recordDir);
 await expect(await peer.get('/api/sync/reset/preview'),409,'UNSAFE_ATTACHMENT_PATH');assert.equal(fs.readFileSync(outside,'utf8'),'outside untouched');
});
test('old uploads cannot refill a reset household; exact managed bytes restore only at the fresh revision',async()=>{
 const f=await fixture(),p=await f.preview(),input=f.request(p);await expect(await f.commit(input),200);
 await expect(await f.upload(),428,'PRECONDITION_REQUIRED');
 await expect(await f.upload({'X-BillHive-Revision':String(p.revision)}),409,'REVISION_CONFLICT');
 await expect(await f.upload({'X-BillHive-Revision':String((await f.read()).revision)}),404,'ATTACHMENT_PARENT_REMOVED');
 await expect(await f.legacyUpload(),428,'PRECONDITION_REQUIRED');await expect(await f.legacyUpload('late',{'If-Match':etag(p)}),409,'REVISION_CONFLICT');
 const current=await f.read();await expect(await f.legacyUpload('late',{'If-Match':etag(current)}),404,'ATTACHMENT_PARENT_REMOVED');
 const restoreURL=f.managedURL.replace('/attachments/','/restore/attachments/');
 await expect(await f.upload({'X-BillHive-Revision':String(p.revision)},f.managedBytes,restoreURL),409,'REVISION_CONFLICT');
 await expect(await f.upload({'X-BillHive-Revision':String(current.revision)},Buffer.from('different'),restoreURL),409,'ATTACHMENT_ID_REUSED');
 const restored=structuredClone(f.state);restored.trips.trips[0].itinerary[0].attachments=[f.descriptor];
 const restore={serverInstanceId:current.serverInstanceId,householdId:current.householdId,baseRevision:current.revision,mutationId:crypto.randomUUID(),state:restored,monthly:{}};
 const plan=await expect(await f.post('/api/sync/restore/validate',restore),200);assert.equal(plan.missing.length,1);
 await expect(await f.upload({'X-BillHive-Revision':String(current.revision)},f.managedBytes,restoreURL),200);
 await expect(await f.commit(restore),200);assert.deepEqual(Buffer.from(await (await fetch(base+f.managedURL,{headers:{...f.headers,...f.identity}})).arrayBuffer()),f.managedBytes);
 const replay=await expect(await f.commit(input),200);assert.equal(replay.replayed,true);assert.deepEqual(replay.state,restored,'old reset receipt cannot reset later restored records');
 assert.deepEqual(Buffer.from(await (await fetch(base+f.managedURL,{headers:{...f.headers,...f.identity}})).arrayBuffer()),f.managedBytes,'old receipt cannot purge rehydrated bytes');
});
test('reset purged legacy managed descriptors fail restore preflight honestly and free active quota',async()=>{
 const f=await fixture();const withFile=await f.read();withFile.state.trips.trips[0].itinerary[0].attachments=[f.descriptor];await expect(await f.ordinary(withFile),200);
 const input=f.request(await f.preview());await expect(await f.commit(input),200);const current=await f.read();const apple={...f.descriptor};delete apple.storageVersion;delete apple.sha256;delete apple.sizeBytes;
 const proposed=structuredClone(f.state);proposed.trips.trips[0].itinerary[0].attachments=[apple];
 await expect(await f.post('/api/sync/restore/validate',{serverInstanceId:current.serverInstanceId,householdId:current.householdId,baseRevision:current.revision,mutationId:crypto.randomUUID(),state:proposed,monthly:{}}),409,'ATTACHMENT_NOT_READY');
 withDB(db=>assert.equal(stores(db).files.usage.get(f.user).bytes,0));
});
test('an empty household still advances reset revision and a corrupt persisted household is kept',async()=>{
 const f=await fixture();await expect(await f.commit(f.request(await f.preview())),200);const p=await f.preview();const result=await expect(await f.commit(f.request(p)),200);assert.ok(result.revision>p.revision);
 const broken=await fixture();withDB(db=>db.prepare("UPDATE user_state SET value='{' WHERE user_id=? AND key='future'").run(broken.user));
 await expect(await broken.get('/api/sync/reset/preview'),500);withDB(db=>assert.equal(db.prepare("SELECT value FROM user_state WHERE user_id=? AND key='future'").get(broken.user).value,'{'));
});
test('database/process reopen replays the original receipt without revoking newer links or deleting newly created files',async()=>{
 const f=await fixture(),input=f.request(await f.preview());const committed=await expect(await f.commit(input),200);
 await expect(await f.ordinary(await f.read(),f.state),200);const current=await f.read();
 await expect(await f.legacyUpload('fresh post-reset copy',{'If-Match':etag(current)}),200);
 const newerToken=crypto.randomBytes(32).toString('hex');withDB(db=>db.prepare('INSERT INTO trip_invites(token,owner_user_id,trip_id,member_id,joined_at) VALUES (?,?,?,?,unixepoch())').run(newerToken,f.user,'trip','member'));
 await stop();await start();
 const replay=await expect(await f.commit(input),200);assert.equal(replay.replayed,true);assert.equal(replay.committedRevision,committed.committedRevision);assert.deepEqual(replay.state,f.state);
 const cleaned=await expect(await f.cleanup(input),200);assert.equal(cleaned.householdReset.cleanup.retained,1);assert.equal(fs.readFileSync(f.legacyFile,'utf8'),'fresh post-reset copy');
 await expect(await fetch(base+'/public/trip/invite/'+newerToken+'/sync/snapshot'),200);
});
