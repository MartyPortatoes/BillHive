const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const Data = require('../public/data-contract');
const SnapshotWriter = require('../public/persistence');
let child, base, dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(),'selfhive-security-'));
  const server = net.createServer(); await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath,['server.js'], {cwd:path.join(__dirname,'..'),env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DB_PATH:path.join(dir,'test.db'),TRUST_PROXY:'0',TRUSTED_AUTH_HEADERS:'remote-user',AUTH_ADMIN_USERS:'alice,local'},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject) => {
    const timeout = setTimeout(()=>reject(new Error('Server did not start')),10000);
    child.stdout.on('data', chunk => {if (String(chunk).includes('running on')) {clearTimeout(timeout);resolve();}});
    child.on('exit',code=>{clearTimeout(timeout);reject(new Error('Server exited '+code));});
  });
});
after(async () => { if(child) { child.kill(); await new Promise(resolve=>child.once('exit',resolve)); } fs.rmSync(dir,{recursive:true,force:true}); });
async function request(url, {method='GET',body,headers={}}={}) {
  return fetch(base+url,{method,headers:{...(body === undefined ? {} : {'content-type':'application/json'}),...headers},body:body === undefined ? undefined : JSON.stringify(body)});
}
const proxy = {'remote-user':'alice'};
test('authentication cannot be bypassed by requesting HTML, including public pages', async () => {
  const keyResponse = await request('/api/keys',{method:'POST',headers:proxy,body:{name:'Test device'}});
  const key = await keyResponse.json();
  const toggle = await request('/api/auth/settings',{method:'PUT',headers:proxy,body:{requireDeviceKeys:true}});
  assert.equal(toggle.status,200);
  for (const url of ['/', '/index.html', '/api/health', '/share/unknown']) {
    const res = await request(url,{headers:{accept:'text/html'}}); assert.equal(res.headers.get('set-cookie'),null,url);
  }
  assert.equal((await request('/api/state')).status,401);
  assert.equal((await request('/api/state',{headers:{authorization:'Bearer invalid'}})).status,401);
  const exchange = await request('/api/session',{method:'POST',headers:{authorization:`Bearer ${key.key}`}});
  assert.equal(exchange.status,200);
  const cookie = exchange.headers.get('set-cookie').split(';')[0];
  assert.match(exchange.headers.get('set-cookie'),/HttpOnly; SameSite=Lax/);
  assert.equal((await request('/api/state',{headers:{cookie}})).status,200);
  assert.equal((await request('/api/auth/settings',{method:'PUT',headers:{cookie},body:{requireDeviceKeys:false}})).status,403);
  assert.equal((await request('/api/keys/'+key.id,{method:'DELETE',headers:proxy})).status,200);
  assert.equal((await request('/api/state',{headers:{cookie}})).status,401,'key revocation must revoke its browser session');
});
test('current proxy account overrides stale cookie; public requests do not receive host sessions',async()=>{
  const response = await request('/',{headers:proxy});
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const h = await (await request('/api/health',{headers:{cookie,'remote-user':'bob'}})).json();
  assert.equal(h.user,'bob');
  assert.equal((await request('/api/state',{headers:{cookie}})).status,401,'proxy logout must not leave cookie access');
});
test('cross-origin browser writes are rejected, same-origin and native writes work',async()=>{
  for (const headers of [{origin:'https://attacker.example'}, {'sec-fetch-site':'same-site'}, {'sec-fetch-site':'cross-site'}]) {
    assert.equal((await request('/api/state',{method:'PUT',headers:{...proxy,...headers},body:{settings:{}}})).status,403);
  }
  assert.equal((await request('/api/state',{method:'PUT',headers:{...proxy,origin:base,'sec-fetch-site':'same-origin'},body:{settings:{myEmail:'alice@example.test'}}})).status,200);
});
test('malformed imports fail atomically; native references and unknown state fields survive',async()=>{
  const state = {settings:{myEmail:'alice@example.test'}, people:[],bills:[],sharedBills:[{token:'safe_token',serverURL:'https://example.test'}],currentMode:'trips',checks:{checks:[]},trips:{trips:[],sharedTrips:[{token:'trip_token'}]}};
  assert.equal((await request('/api/state',{method:'PUT',headers:proxy,body:state})).status,200);
  for (const body of [{state:{people:'bad'},monthly:{}},{state:{people:[]},monthly:{'2026-13':{}}},{state:{},monthly:{},version:2,attachments:[{data:'bytes'}]},{state:{bills:[{id:'<img>',lines:[]}]},monthly:{}}]) {
    assert.equal((await request('/api/import',{method:'POST',headers:proxy,body})).status,400);
  }
  assert.deepEqual(await (await request('/api/state',{headers:proxy})).json(),state);
  const backup = await request('/api/export',{headers:proxy});
  assert.match(backup.headers.get('cache-control'),/no-store/);
  Data.backup(await backup.json());
});
test('uploads cannot execute in the app origin, alias traversal paths, or leak across users',async()=>{
  const upload = await fetch(base+'/api/trips/trip/itinerary/event/attachments',{method:'POST',headers:{...proxy,'content-type':'text/html','x-attachment-id':'file','x-filename':'file.html'},body:'<script>alert(1)</script>'});
  assert.equal(upload.status,200);
  const download = await request('/api/trips/trip/itinerary/event/attachments/file.html',{headers:proxy});
  assert.equal(download.status,200);
  assert.match(download.headers.get('content-disposition'),/^attachment;/);
  assert.match(download.headers.get('content-security-policy'),/sandbox; default-src 'none'/);
  assert.match(download.headers.get('content-type'),/application\/octet-stream/);
  assert.equal((await request('/api/trips/trip/itinerary/event/attachments/file.html',{headers:{'remote-user':'bob'}})).status,404);
  assert.equal((await request('/api/trips/trip/itinerary/e%2Fvent/attachments/file.html',{headers:proxy})).status,400);
});
test('CSP only authorizes known inline scripts; private responses are not cached',async()=>{
  const response = await request('/',{headers:proxy});
  const csp = response.headers.get('content-security-policy');
  const scriptPolicy = csp.split(';').find(part=>part.trim().startsWith('script-src '));
  assert.ok(!scriptPolicy.includes('unsafe-inline'));
  assert.match(scriptPolicy,/sha256-/);
  assert.match(response.headers.get('cache-control'),/no-store/);
  assert.equal((await request('/api/missing',{headers:proxy})).status,404);
});
test('shared contract rejects unsafe keys, malformed nested state, and allows payment addresses',()=>{
  assert.throws(()=>Data.state(JSON.parse('{"__proto__":{"admin":true}}')));
  assert.throws(()=>Data.state({bills:[{id:'bill',lines:null}]}));
  assert.throws(()=>Data.state({people:[{id:'me',color:'red; background:url(x)'}]}));
  Data.state({people:[{id:'me',payId:'person@example.test',color:'#d8923e'}]});
});
test('serial writer preserves immutable snapshots and keeps failed writes dirty for retry',async()=>{
  const sent=[]; let release;
  const writer=new SnapshotWriter(async(path,body)=>{ sent.push(JSON.parse(body)); if(sent.length===1) await new Promise(resolve=>release=resolve); });
  const data={value:1}; const first=writer.enqueue('/state',data); data.value=2;
  await new Promise(resolve=>setImmediate(resolve));
  const second=writer.enqueue('/state',data); release(); await Promise.all([first,second]);
  assert.deepEqual(sent,[{value:1},{value:2}]); assert.equal(writer.dirty,false);
  let fail=true;const retry=new SnapshotWriter(async()=>{if(fail) throw new Error('offline');});
  await assert.rejects(retry.enqueue('/state',{value:3})); assert.equal(retry.dirty,true);
  fail=false;await retry.flush(); assert.equal(retry.dirty,false);
});
test('email sanitization preserves layout but strips active attributes; SMTP verifies TLS',async()=>{
  const nodemailer=require('nodemailer'); const original=nodemailer.createTransport;
  let transport,message;
  nodemailer.createTransport=options=>{transport=options; return {sendMail:async msg=>{message=msg;}};};
  try {
    await require('../email').sendEmail({provider:'smtp',fromEmail:'host@example.test',fromName:'Host',smtpHost:'smtp.example.test',smtpPass:'test-only'},'guest@example.test','Test','<table><tr><td style="color:red" onclick="alert(1)">Bill</td></tr></table><img src="https://example.test/logo.png" onerror="alert(1)"><script>alert(1)</script>','Bill');
    assert.equal(transport.tls.rejectUnauthorized,true);assert.equal(transport.requireTLS,true);
    assert.equal(transport.disableFileAccess,true);assert.equal(transport.disableUrlAccess,true);
    assert.ok(!/onclick|onerror|<script/.test(message.html)); assert.match(message.html,/<table>/);
  } finally { nodemailer.createTransport=original; }
});
test('a browser with unsaved edits cannot write into a switched proxy account',async()=>{
  const res=await request('/api/state',{method:'PUT',headers:{...proxy,'X-BillHive-User':'bob'},body:{settings:{}}});
  assert.equal(res.status,409);
});
test('bill editor escapes synchronized names and descriptions in HTML attributes',()=>{
  const vm=require('node:vm');const source=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  const esc=source.slice(source.indexOf('function esc('),source.indexOf('// Returns the raw URL'));
  const render=source.slice(source.indexOf('function renderBillBody('),source.indexOf('function toggleBill('));
  const malicious='\"><img src=x onerror=alert(1)><button data-click="clearAll()">';
  const context={getBillTotal:()=>10,getCurrSymbol:()=> '$',fmtCurrency:String,getPerson:()=>({name:malicious,color:'#123456'}),S:{people:[{id:'me',name:malicious}]},ordinal:String};
  vm.createContext(context);vm.runInContext(esc+render,context);
  const result=context.renderBillBody({id:'bill',icon:malicious,name:malicious,color:'#123456',splitType:'pct',lines:[{id:'line',desc:malicious,personId:'me',value:100}]});
  assert.ok(!result.includes('<img src=x'));assert.ok(!result.includes('<button data-click="clearAll()">'));
  assert.match(result,/&lt;img/);
});
test('clear setup revokes shares atomically and preserves the advertised history and other users',async()=>{
  const state={people:[],bills:[],checks:{checks:[{id:'check',name:'Dinner',items:[],participants:[]}]}};
  await request('/api/state',{method:'PUT',headers:proxy,body:state});
  await request('/api/months/2026-09',{method:'PUT',headers:proxy,body:{totals:{bill:100},amounts:{}}});
  await request('/api/state',{method:'PUT',headers:{'remote-user':'bob'},body:{settings:{myEmail:'bob@example.test'}}});
  const share=await (await request('/api/share/check/check',{method:'POST',headers:proxy})).json();
  assert.equal((await request('/public/share/check/'+share.token)).status,200);
  assert.equal((await request('/api/reset-setup',{method:'POST',headers:proxy})).status,200);
  assert.equal((await request('/public/share/check/'+share.token)).status,410);
  assert.deepEqual(await (await request('/api/state',{headers:proxy})).json(),{people:[],bills:[]});
  assert.equal((await (await request('/api/months/2026-09',{headers:proxy})).json()).totals.bill,100);
  assert.equal((await (await request('/api/state',{headers:{'remote-user':'bob'}})).json()).settings.myEmail,'bob@example.test');
});
test('corrupt persisted records fail closed instead of exporting a partial backup',async()=>{
  const Database=require('better-sqlite3');const db=new Database(path.join(dir,'test.db'));
  db.prepare('INSERT INTO user_state (user_id,key,value) VALUES (?,?,?)').run('corrupt','settings','not-json');
  for(const url of ['/api/state','/api/export']) assert.equal((await request(url,{headers:{'remote-user':'corrupt'}})).status,500);
  assert.equal(db.prepare('SELECT value FROM user_state WHERE user_id=?').get('corrupt').value,'not-json');db.close();
});

test('web appearance preferences survive native state writes',async()=>{
  await request('/api/state',{method:'PUT',headers:proxy,body:{webPreferences:{themePref:'dark'},settings:{myEmail:''}}});
  await request('/api/state',{method:'PUT',headers:proxy,body:{settings:{myEmail:'native@example.test'},people:[],bills:[]}});
  const state=await (await request('/api/state',{headers:proxy})).json();assert.equal(state.webPreferences.themePref,'dark');
});

test('other proxy accounts cannot change server-wide authentication policy',async()=>{
  const response=await request('/api/auth/settings',{method:'PUT',headers:{'remote-user':'bob'},body:{requireDeviceKeys:false}});assert.equal(response.status,403);
  const settings=await (await request('/api/auth/settings',{headers:{'remote-user':'bob'}})).json();assert.equal(settings.canManage,false);
});

test('compatibility mode keeps older clients working but refuses clients requiring global revision protection',async()=>{
  const headers={'remote-user':'compatibility-fixture'};
  const health=await (await request('/api/health',{headers})).json();assert.equal(health.capabilities.revisionPreconditionsRequired,false);
  const before=await (await request('/api/sync/snapshot',{headers})).json();
  const body={serverInstanceId:before.serverInstanceId,householdId:before.householdId,baseRevision:before.revision,
    mutationId:require('node:crypto').randomUUID(),state:{people:[]},monthly:{}};
  const protectedWrite=await request('/api/sync/commit',{method:'POST',headers:{...headers,'X-BillHive-Require-Protection':'1'},body});
  assert.equal(protectedWrite.status,428);assert.equal((await protectedWrite.json()).code,'PROTECTION_DISABLED');
  assert.equal((await request('/api/state',{method:'PUT',headers,body:{settings:{currencyCode:'USD'}}})).status,200);
  const stale=await request('/api/sync/commit',{method:'POST',headers,body});assert.equal(stale.status,409);
});
