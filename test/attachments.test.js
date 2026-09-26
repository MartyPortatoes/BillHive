'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const net=require('node:net');const crypto=require('node:crypto');
let child,base,dir;
before(async()=>{
 dir=fs.mkdtempSync(path.join(os.tmpdir(),'selfhive-attachments-'));
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));base=`http://127.0.0.1:${port}`;
 child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DB_PATH:path.join(dir,'test.db'),TRUST_PROXY:'0',TRUSTED_AUTH_HEADERS:'remote-user',SYNC_REQUIRE_PRECONDITIONS:'1'},stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Attachment fixture did not start')),10000);child.stdout.on('data',s=>{if(String(s).includes('running on')){clearTimeout(timer);resolve();}});child.on('exit',code=>{clearTimeout(timer);reject(new Error(`Fixture exit ${code}`));});});
});
after(async()=>{if(child?.exitCode==null){child.kill();await new Promise(r=>child.once('exit',r));}fs.rmSync(dir,{recursive:true,force:true});});
async function fixture(){
 const user='files-'+crypto.randomUUID();const headers={'remote-user':user};
 const read=async()=>{const r=await fetch(base+'/api/sync/snapshot',{headers});assert.equal(r.status,200);return r.json();};
 const commit=async(s,state)=>fetch(base+'/api/sync/commit',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({serverInstanceId:s.serverInstanceId,householdId:s.householdId,baseRevision:s.revision,mutationId:crypto.randomUUID(),state,monthly:{}})});
 const seeded=await commit(await read(),{trips:{trips:[{id:'trip',name:'Files',currency:'USD',members:[],expenses:[{id:'expense',name:'Receipt',amount:0,paidByAmounts:{}}],itinerary:[{id:'event',title:'Tickets'}]}]}});assert.equal(seeded.status,200);
 const snapshot=await read();const identity={'X-BillHive-User':user,'X-BillHive-Server':snapshot.serverInstanceId,'X-BillHive-Household':snapshot.householdId};
 const bytes=Buffer.from('%PDF-1.4\nSynthetic test file\n%%EOF');const digest=crypto.createHash('sha256').update(bytes).digest('hex');
 const descriptor={id:'ticket',filename:'ticket.pdf',mimeType:'application/pdf',storageVersion:1,sha256:digest,sizeBytes:bytes.length,createdAtISO:'2026-09-26T00:00:00Z',displayName:'Ticket'};
 const url='/api/sync/attachments/itinerary/trip/event/ticket.pdf';
 const upload=(body=bytes,extra={},target=url)=>fetch(base+target,{method:'PUT',headers:{...headers,...identity,'content-type':'application/octet-stream','X-Attachment-Id':descriptor.id,'X-Attachment-Type':descriptor.mimeType,'X-Attachment-SHA256':crypto.createHash('sha256').update(body).digest('hex'),...extra},body});
 const download=(extra={},target=url)=>fetch(base+target,{headers:{...headers,...identity,...extra}});
 const attach=async(value=descriptor)=>{const s=await read();s.state.trips.trips[0].itinerary[0].attachments=[value];return commit(s,s.state);};
 return {user,headers,read,commit,snapshot,identity,bytes,descriptor,url,upload,download,attach};
}
test('staged bytes are immutable, retryable and hidden until an atomic reference commit',async()=>{
 const f=await fixture();assert.equal((await f.download()).status,404);
 const uploaded=await f.upload();assert.equal(uploaded.status,200);assert.equal((await uploaded.json()).replayed,false);
 assert.equal((await f.read()).revision,f.snapshot.revision,'staging bytes does not claim a household edit');assert.equal((await f.download()).status,404);
 const replay=await f.upload();assert.equal((await replay.json()).replayed,true);
 assert.equal((await f.upload(Buffer.from('different'))).status,409);
 assert.equal((await f.upload(f.bytes,{'X-Attachment-Id':'different-id'})).status,409);
 assert.equal((await f.attach()).status,200);
 const file=await f.download();assert.equal(file.status,200);assert.equal(file.headers.get('x-attachment-sha256'),f.descriptor.sha256);assert.deepEqual(Buffer.from(await file.arrayBuffer()),f.bytes);
 assert.match(file.headers.get('content-security-policy'),/sandbox/);assert.match(file.headers.get('content-type'),/application\/octet-stream/);
 const newer=await f.read();newer.state.settings={currencyCode:'USD'};assert.equal((await f.commit(newer,newer.state)).status,200);
 assert.equal((await (await f.upload()).json()).replayed,true,'replay after another owner edit');
});
test('unready or altered references reject and roll back the complete owner or legacy JSON write',async()=>{
 const f=await fixture();const before=await f.read();assert.equal((await f.attach()).status,409);assert.deepEqual(await f.read(),before);
 assert.equal((await f.upload()).status,200);
 assert.equal((await f.attach({...f.descriptor,sha256:'0'.repeat(64)})).status,409);
 assert.equal((await f.attach({...f.descriptor,sizeBytes:1})).status,409);
 assert.equal((await f.attach({...f.descriptor,id:'wrong'})).status,409);
 assert.deepEqual(await f.read(),before);
 const bad=structuredClone(before.state);bad.trips.trips[0].itinerary[0].attachments=[{...f.descriptor,mimeType:'text/html'}];
 const legacy=await fetch(base+'/api/state',{method:'PUT',headers:{...f.headers,'content-type':'application/json','if-match':`"bh1:${before.serverInstanceId}:${before.householdId}:${before.revision}"`},body:JSON.stringify(bad)});
 assert.equal(legacy.status,409);assert.deepEqual(await f.read(),before);
});
test('pinned identity, parent lifecycle, content digest and namespace are enforced',async()=>{
 const f=await fixture();assert.equal((await f.upload(f.bytes,{'X-BillHive-Household':'wrong'})).status,409);
 assert.equal((await f.upload(f.bytes,{'X-Attachment-SHA256':'0'.repeat(64)})).status,400);
 assert.equal((await f.upload(f.bytes,{},f.url.replace('/event/','/missing/'))).status,404);
 assert.equal((await f.upload(f.bytes,{},f.url.replace('ticket.pdf','bad%2Fname.pdf'))).status,400);
 const state=await f.read();state.state.trips.trips[0].isArchived=true;assert.equal((await f.commit(state,state.state)).status,200);assert.equal((await f.upload()).status,409);
 state.state.trips.trips[0].isArchived=false;assert.equal((await f.commit(await f.read(),state.state)).status,200);
 assert.equal((await f.upload()).status,200);assert.equal((await f.attach()).status,200);
 assert.equal((await f.download({'remote-user':'other'})).status,409);
 assert.equal((await f.download({},f.url.replace('/trip/','/other-trip/'))).status,404);
});
test('Apple download routes read managed files but cannot overwrite or delete their bytes',async()=>{
 const f=await fixture();await f.upload();await f.attach();const legacy='/api/trips/trip/itinerary/event/attachments';
 const got=await fetch(base+legacy+'/ticket.pdf',{headers:f.headers});assert.equal(got.status,200);assert.deepEqual(Buffer.from(await got.arrayBuffer()),f.bytes);
 assert.equal((await fetch(base+legacy,{method:'POST',headers:{...f.headers,'content-type':'application/pdf','x-attachment-id':'ticket','x-filename':'ticket.pdf'},body:f.bytes})).status,409);
 assert.equal((await fetch(base+legacy+'/ticket.pdf',{method:'DELETE',headers:f.headers})).status,409);
 const apple={...f.descriptor};delete apple.storageVersion;delete apple.sha256;delete apple.sizeBytes;assert.equal((await f.attach(apple)).status,200,'known Apple fields remain compatible');
 assert.equal((await f.download()).status,200);
 const latest=await f.read();latest.state.trips.trips[0].itinerary[0].attachments=[];assert.equal((await f.commit(latest,latest.state)).status,200);
 assert.equal((await f.download()).status,404);assert.equal((await fetch(base+legacy+'/ticket.pdf',{headers:f.headers})).status,404);
 assert.equal((await (await f.upload()).json()).replayed,true,'retained immutable staging receipt does not reattach deleted metadata');
});
test('receipt JPEG policy and upload bounds reject invalid bytes',async()=>{
 const f=await fixture();const url='/api/sync/attachments/expenses/trip/expense/receipt.jpg';
 assert.equal((await f.upload(Buffer.from('not jpeg'),{'X-Attachment-Id':'receipt','X-Attachment-Type':'image/jpeg'},url)).status,400);
 const jpeg=Buffer.from([255,216,255,224,0,16,255,217]);
 const saved=await f.upload(jpeg,{'X-Attachment-Id':'receipt','X-Attachment-Type':'image/jpeg'},url);assert.equal(saved.status,200);
 assert.equal((await f.upload(Buffer.alloc(2*1024*1024+1),{'X-Attachment-Id':'big','X-Attachment-Type':'image/jpeg'},url.replace('receipt.jpg','big.jpg'))).status,400);
 assert.equal((await f.upload(Buffer.alloc(10*1024*1024+1),{},f.url.replace('ticket.pdf','large.pdf'))).status,413);
});
test('SQLite reopen retains byte identity and an aborted reference transaction retains staged content',async()=>{
 const Database=require('better-sqlite3');const {SyncStore}=require('../sync-store');const {AttachmentStore}=require('../attachment-store');
 const f=await fixture();await f.upload();await f.attach();
 const db=new Database(path.join(dir,'test.db'));const sync=new SyncStore(db,{requirePreconditions:true});const files=new AttachmentStore(db,sync);sync.validateReferences=u=>files.validateReferences(u);
 const scope=files.scope('itinerary','trip','event','ticket.pdf');
 assert.deepEqual(files.download(f.user,scope).bytes,f.bytes);
 const before=sync.snapshot(f.user);
 assert.throws(()=>sync.write(f.user,sync.etag(before),()=>{const state=structuredClone(before.state);state.trips.trips[0].itinerary[0].attachments=[{...f.descriptor,sha256:'0'.repeat(64)}];sync.setState.run(f.user,'trips',JSON.stringify(state.trips));}));
 assert.deepEqual(sync.snapshot(f.user),before);assert.deepEqual(files.download(f.user,scope).bytes,f.bytes);db.close();
});
test('unmanaged legacy and opaque future descriptors survive unrelated owner saves',async()=>{
 const f=await fixture();const snapshot=await f.read();
 snapshot.state.trips.trips[0].itinerary[0].attachments=[{id:'legacy',filename:'legacy.pdf',futureFlag:true},'opaque-future-reference'];
 assert.equal((await f.commit(snapshot,snapshot.state)).status,200);
 assert.deepEqual((await f.read()).state.trips.trips[0].itinerary[0].attachments,snapshot.state.trips.trips[0].itinerary[0].attachments);
 assert.equal((await f.upload()).status,200);
 const latest=await f.read();latest.state.trips.trips[0].itinerary[0].attachments.push(f.descriptor);
 assert.equal((await f.commit(latest,latest.state)).status,200);assert.equal((await f.download()).status,200);
});

async function restoreFixture() {
 const f=await fixture();
 const state={settings:{currencyCode:'EUR',futureSetting:'retained'},trips:{trips:[{id:'imported-trip',name:'Archived vacation',isArchived:true,
  members:[],expenses:[],itinerary:[{id:'imported-event',title:'Reservation',attachments:[f.descriptor]}]}]}};
 const request={serverInstanceId:f.snapshot.serverInstanceId,householdId:f.snapshot.householdId,baseRevision:f.snapshot.revision,
  mutationId:crypto.randomUUID(),state,monthly:{'2024-02':{totals:{},futureMonth:'retained'}},
  deleteStateKeys:Object.keys(f.snapshot.state).filter(k=>!(k in state)),deleteMonths:Object.keys(f.snapshot.monthly)};
 const post=(url,body=request,extra={})=>fetch(base+url,{method:'POST',headers:{...f.headers,'X-BillHive-User':f.user,'content-type':'application/json',...extra},body:JSON.stringify(body)});
 const fileUrl='/api/sync/attachments/itinerary/imported-trip/imported-event/ticket.pdf';
 const upload=(extra={})=>f.upload(f.bytes,{'X-BillHive-Revision':String(request.baseRevision),...extra},fileUrl.replace('/attachments/','/restore/attachments/'));
 return {...f,request,post,fileUrl,restoreUpload:upload,preflight:()=>post('/api/sync/restore/validate'),restoreCommit:()=>post('/api/sync/commit')};
}
test('restore stages into an absent archived parent then atomically replaces records and history',async()=>{
 const f=await restoreFixture();const original=await f.read();
 assert.equal((await f.upload(f.bytes,{},f.fileUrl)).status,404,'ordinary uploads still require a current parent');
 const response=await f.preflight();assert.equal(response.status,200);const plan=await response.json();
 assert.equal(plan.baseRevision,original.revision);assert.equal(plan.mutationId,f.request.mutationId);assert.equal(plan.userId,f.user);
 assert.equal(plan.missing.length,1);assert.equal(plan.missing[0].sha256,f.descriptor.sha256);
 assert.deepEqual(await f.read(),original,'preflight publishes nothing');
 assert.equal((await f.restoreCommit()).status,409);assert.deepEqual(await f.read(),original,'missing file rolls back records');
 assert.equal((await f.restoreUpload()).status,200);assert.deepEqual(await f.read(),original);
 assert.equal((await f.download({},f.fileUrl)).status,404,'staged bytes stay hidden');
 assert.deepEqual((await (await f.preflight()).json()).missing,[]);
 const committed=await f.restoreCommit();assert.equal(committed.status,200);const receipt=await committed.json();
 assert.deepEqual(receipt.state,f.request.state);assert.deepEqual(receipt.monthly,f.request.monthly);
 assert.deepEqual(Buffer.from(await (await f.download({},f.fileUrl)).arrayBuffer()),f.bytes);
 const newer=await f.read();newer.state.settings.futureSetting='newer edit';assert.equal((await f.commit(newer,newer.state)).status,200);
 const replay=await (await f.restoreCommit()).json();assert.equal(replay.replayed,true);assert.equal(replay.committedRevision,receipt.committedRevision);
 assert.equal(replay.state.settings.futureSetting,'newer edit','lost receipt recovery cannot roll back subsequent edits');
 assert.equal((await (await f.restoreUpload()).json()).replayed,true,'exact bytes replay even after later revisions');
});
test('restore preflight and staging pin the household and require an unchanged review',async()=>{
 const f=await restoreFixture();
 assert.equal((await f.post('/api/sync/restore/validate',{...f.request,householdId:'another'})).status,409);
 assert.equal((await f.post('/api/sync/restore/validate',f.request,{'X-BillHive-User':'another'})).status,409);
 assert.equal((await f.restoreUpload({'X-BillHive-User':'another'})).status,409);
 for(const invalid of ['', '-1','1.5','9007199254740992']) assert.equal((await f.restoreUpload({'X-BillHive-Revision':invalid})).status,400);
 const newer=await f.read();newer.state.settings={currencyCode:'GBP'};assert.equal((await f.commit(newer,newer.state)).status,200);
 assert.equal((await f.preflight()).status,409);assert.equal((await f.restoreUpload()).status,409);assert.equal((await f.restoreCommit()).status,409);
 assert.equal((await f.download({},f.fileUrl)).status,404);
});
test('restore preflight rejects malformed references and immutable collisions before publication',async()=>{
 const f=await restoreFixture();const before=await f.read();
 for(const change of [{sha256:'bad'},{sizeBytes:0},{sizeBytes:11*1024*1024},{storageVersion:2},{filename:'../bad'}]) {
  const bad=structuredClone(f.request);bad.state.trips.trips[0].itinerary[0].attachments=[{...f.descriptor,...change}];
  assert.equal((await f.post('/api/sync/restore/validate',bad)).status,400);
 }
 const duplicate=structuredClone(f.request);duplicate.state.trips.trips[0].itinerary[0].attachments.push(f.descriptor);
 assert.equal((await f.post('/api/sync/restore/validate',duplicate)).status,400);
 assert.equal((await f.restoreUpload()).status,200);
 const collision=structuredClone(f.request);collision.state.trips.trips[0].itinerary[0].attachments[0].sha256='0'.repeat(64);
 assert.equal((await f.post('/api/sync/restore/validate',collision)).status,409);
 assert.equal((await f.upload(Buffer.from('different'),{'X-BillHive-Revision':String(before.revision)},f.fileUrl.replace('/attachments/','/restore/attachments/'))).status,409);
 assert.deepEqual(await f.read(),before);
});
test('restore requires explicit removed keys and months and accepts records larger than the legacy 2 MiB limit',async()=>{
 const f=await restoreFixture();const original=await f.read();
 original.state.obsolete={old:true};const seeded=await f.commit(original,original.state);assert.equal(seeded.status,200);
 const latest=await f.read();f.request.baseRevision=latest.revision;
 assert.equal((await f.preflight()).status,400,'cannot leave an omitted existing key behind');
 f.request.deleteStateKeys.push('obsolete');f.request.state.trips.trips[0].itinerary[0].attachments=[];
 f.request.state.unknownLargeField='x'.repeat(3*1024*1024);
 assert.equal((await f.preflight()).status,200);assert.equal((await f.restoreCommit()).status,200);
 const restored=await f.read();assert.equal(restored.state.obsolete,undefined);assert.equal(restored.state.unknownLargeField.length,3*1024*1024);
 const incomplete={...f.request,baseRevision:restored.revision,mutationId:crypto.randomUUID(),monthly:{},deleteMonths:[]};
 assert.equal((await f.post('/api/sync/restore/validate',incomplete)).status,400);
});
test('records-only restore can reuse retained managed bytes and preserves honest legacy references',async()=>{
 const f=await restoreFixture();await f.restoreUpload();await f.restoreCommit();
 const s=await f.read();s.state.trips.trips=[];assert.equal((await f.commit(s,s.state)).status,200);
 f.request.baseRevision=(await f.read()).revision;f.request.mutationId=crypto.randomUUID();
 f.request.state.trips.trips[0].itinerary[0].attachments.push({id:'old',filename:'old.pdf',mimeType:'application/pdf'});
 const preflight=await f.preflight();assert.equal(preflight.status,200);assert.deepEqual((await preflight.json()).missing,[]);
 assert.equal((await f.restoreCommit()).status,200);assert.equal((await f.download({},f.fileUrl)).status,200);
});
test('restore enforces protection and accounts for retained storage before and during staging',async()=>{
 const Database=require('better-sqlite3');const {SyncStore}=require('../sync-store');const {AttachmentStore}=require('../attachment-store');
 const f=await restoreFixture();const db=new Database(path.join(dir,'test.db'));
 try {
  const compatible=new SyncStore(db,{requirePreconditions:false});const compatibleFiles=new AttachmentStore(db,compatible);
  assert.throws(()=>compatible.validateRestore(f.user,f.request,state=>compatibleFiles.missingForRestore(f.user,state)),e=>e.code==='PROTECTION_DISABLED');
  const scope=compatibleFiles.scope('itinerary','imported-trip','imported-event','ticket.pdf');
  const identity={userId:f.user,serverInstanceId:f.snapshot.serverInstanceId,householdId:f.snapshot.householdId};
  assert.throws(()=>compatibleFiles.upload(f.user,scope,identity,f.descriptor,f.bytes,f.snapshot.revision),e=>e.code==='PROTECTION_DISABLED');
  // Synthetic accounting row avoids allocating a 256 MiB payload in a quota test.
  db.prepare('INSERT INTO trip_attachment_blobs(user_id,kind,trip_id,record_id,filename,attachment_id,mime_type,sha256,size_bytes,bytes) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(f.user,'itinerary','retained','old','old.txt','old','text/plain','0'.repeat(64),256*1024*1024,Buffer.from('quota fixture'));
  assert.equal((await f.preflight()).status,413);assert.equal((await f.restoreUpload()).status,413);
  assert.deepEqual(await f.read(),f.snapshot);
 } finally {db.close();}
});
