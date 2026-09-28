// Run with Node 24 and a local Chrome binary. Every server, profile and record is
// disposable; no user browser profile, deployed server or Google account is used.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const chromePath=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const output=path.resolve(process.env.HOST_REVIEW_EVIDENCE_DIR||path.join(root,'docs/evidence/browser-host-check-review'));
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'billhive-host-review-'));
let server,chrome,proxy,cdp,base,upstream,browserVersion,dropNext=false,dropPayload=null,conflictNext=false,proxyUser='owner-ui-test',requests=[],failures=[],passes=[],dialogs=[];
const check=(name,fn)=>{fn();passes.push(name);console.log('PASS '+name);};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,message,timeout=15000) {
  const end=Date.now()+timeout;let value;
  while(Date.now()<end) { value=await fn();if(value)return value;await pause(60); }
  throw new Error(message+' (timed out)');
}
async function port() {const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function stop(child,kill=false) {
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  const done=once(child,'exit');if(kill)process.kill(-child.pid,'SIGKILL');else child.kill('SIGTERM');await done;
}
class CDP {
  constructor(socket){this.socket=socket;this.id=0;this.waits=new Map();socket.addEventListener('message',event=>{
    const message=JSON.parse(event.data);if(message.id){const p=this.waits.get(message.id);this.waits.delete(message.id);if(!p)return;clearTimeout(p.timer);message.error?p.reject(new Error(JSON.stringify(message.error))):p.resolve(message.result);}
    if(message.method==='Runtime.exceptionThrown')failures.push(message.params.exceptionDetails.text+': '+(message.params.exceptionDetails.exception?.description||''));
    if(message.method==='Log.entryAdded' && /Content Security Policy|Refused to (load|execute)/i.test(message.params.entry.text))failures.push(message.params.entry.text);
    if(message.method==='Page.javascriptDialogOpening') {
      dialogs.push(message.params.type);
      // Only this disposable test profile is controlled by this connection.
      this.send('Page.handleJavaScriptDialog',{accept:true},message.sessionId).catch(error=>failures.push(error.message));
    }
  });}
  send(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++this.id;const timer=setTimeout(()=>{this.waits.delete(id);reject(new Error('CDP timeout: '+method));},15000);this.waits.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
  async tab(url){const {targetId}=await this.send('Target.createTarget',{url:'about:blank'});const {sessionId}=await this.send('Target.attachToTarget',{targetId,flatten:true});
    const tab={id:targetId,session:sessionId};this.last=tab;await this.send('Runtime.enable',{},sessionId);await this.send('Page.enable',{},sessionId);await this.send('Log.enable',{},sessionId);await this.send('Network.enable',{},sessionId);await this.send('Network.setBlockedURLs',{urls:['https://cdnjs.cloudflare.com/*','https://fonts.googleapis.com/*','https://fonts.gstatic.com/*']},sessionId);
    await this.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},sessionId);
    await this.navigate(tab,url);return tab;}
  async evaluate(tab,expression){const result=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},tab.session);if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;}
  async navigate(tab,url){const mark=crypto.randomUUID();await this.evaluate(tab,'window.__navigationProbe='+JSON.stringify(mark));await this.send('Page.navigate',{url},tab.session);
    await until(async()=>{try{return await this.evaluate(tab,`window.__navigationProbe !== ${JSON.stringify(mark)} && typeof _loaded !== 'undefined' && _loaded && !_reloading && !document.querySelector('#app').hidden`);}catch(error){if(/context.*destroyed|Cannot find context/i.test(error.message))return false;throw error;}},'Claim page initialization');}
  async click(tab,selector){const box=await this.evaluate(tab,`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Unavailable control: '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
    await this.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box},tab.session);await this.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box},tab.session);}
  async name(tab,value){await this.evaluate(tab,`(()=>{const e=document.querySelector('#nameInput');e.scrollIntoView({block:'center'});e.focus();e.select();})()`);await this.send('Input.insertText',{text:value},tab.session);await this.idle(tab);}
  async idle(tab){await until(()=>this.evaluate(tab,"ownerSharing.busy === null && !_reloading && !_stateDirty && !writer.dirty"),'Claim action completion');}
  async screenshot(tab,name){await this.evaluate(tab,"(async()=>{document.querySelector('#owner-sharing-recovery .owner-check-sharing, .owner-check-sharing')?.scrollIntoView({block:'start'});await new Promise(requestAnimationFrame);await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));})()");const r=await this.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},tab.session);await fs.writeFile(path.join(output,name+'.png'),Buffer.from(r.data,'base64'));}
}
async function launchChrome(){
  const profile=path.join(temp,'profile');await fs.mkdir(profile,{recursive:true});await fs.rm(path.join(profile,'DevToolsActivePort'),{force:true});
  chrome=spawn(chromePath,['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--disable-features=Translate','about:blank'],{detached:true,stdio:['ignore','ignore','pipe']});
  chrome.stderr.on('data',()=>{});
  const endpoint=await until(async()=>{try{return (await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];}catch{return null;}},'Chrome debugging endpoint');
  const info=await fetch('http://127.0.0.1:'+endpoint+'/json/version').then(r=>r.json());
  browserVersion=info.Browser;
  const socket=new WebSocket(info.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});cdp=new CDP(socket);
}
async function json(url,body,headers={}){const response=await fetch(upstream+url,{method:body===undefined?'GET':'POST',headers:{...headers,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  assert.equal(response.status,200,await response.clone().text());return response.json();}
const auth={'remote-user':'owner-ui-test'};
const household=()=>json('/api/sync/snapshot',undefined,auth);
const share=()=>json('/api/share/check/dinner/sync/snapshot',undefined,auth);
async function write(change){const s=await household();change(s.state);return json('/api/sync/commit',{serverInstanceId:s.serverInstanceId,householdId:s.householdId,baseRevision:s.revision,mutationId:crypto.randomUUID(),state:s.state,monthly:s.monthly},auth);}
async function link(kind){const s=await share();return json('/api/share/check/dinner/sync/commit',{serverInstanceId:s.serverInstanceId,householdId:s.householdId,checkId:'dinner',baseRevision:s.revision,baseShareRevision:s.shareRevision,mutationId:crypto.randomUUID(),kind},{...auth,'X-BillHive-Require-Protection':'1'});}
async function guest(){const token=(await share()).share.token,s=await json('/public/share/check/'+token+'/sync/snapshot'),key=crypto.randomBytes(32).toString('hex');
  return json('/public/share/check/'+token+'/sync/claim',{serverInstanceId:s.serverInstanceId,householdId:s.householdId,checkId:s.checkId,shareId:s.shareId,claimantId:crypto.createHash('sha256').update('check-claimant\0'+token+'\0'+key).digest('hex'),baseRevision:s.revision,baseShareRevision:s.shareRevision,mutationId:crypto.randomUUID(),claim:{claimerName:'Alex',itemIds:['soup']}},{'X-BillHive-Claimant-Key':key,'X-BillHive-Require-Protection':'1'});}
async function setup(tab){await cdp.evaluate(tab,`(async()=>{
  for(const src of ['/check-claim-review.js','/check-review-client.js'])await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=reject;document.head.appendChild(s);});
  window.reviewFixtureClient=new BillHiveCheckReviewClient.Client({owner:revisionClient.baseline});await reviewFixtureClient.open();
})()`);}
const row=tab=>cdp.evaluate(tab,'reviewFixtureClient.row');
async function choices(tab){await cdp.evaluate(tab,`(async()=>{
  const client=reviewFixtureClient,draft=client.row.drafts.dinner,plan=structuredClone(draft.plan);
  plan.newParticipants=[];plan.choices={};
  draft.baseline.sources.forEach((source,i)=>{const id='guest-'+(i+1);plan.newParticipants.push({id,name:source.name,linkedPersonId:null});plan.choices[BillHiveCheckReview.sourceId(source)]={action:'APPLY',participantId:id};});
  await client.edit('dinner',plan);
})()`);}
const prepare=tab=>cdp.evaluate(tab,"(async()=>{const c=reviewFixtureClient;await c.prepare('dinner',await c.transport.load('dinner'),c.preview('dinner'),true);})()");
try{
  await fs.mkdir(output,{recursive:true});const serverPort=await port();upstream='http://127.0.0.1:'+serverPort;
  server=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:String(serverPort),DB_PATH:path.join(temp,'server.db'),TRUSTED_AUTH_HEADERS:'remote-user',TRUST_PROXY:'loopback',SYNC_REQUIRE_PRECONDITIONS:'1'},stdio:['ignore','pipe','pipe']});
  let serverOutput='';server.stdout.on('data',c=>serverOutput+=c);server.stderr.on('data',c=>serverOutput+=c);await until(()=>serverOutput.includes('running on'),'Host review fixture server');
  proxy=http.createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
    const body=Buffer.concat(chunks),financialWrite=req.method==='POST'&&req.url==='/api/sync/commit'&&body.includes('checkSharePreconditions');
    if(financialWrite)requests.push(body.toString());const drop=financialWrite&&(dropNext||dropPayload===body.toString());if(drop){dropNext=false;dropPayload=body.toString();}
    const forward=http.request(upstream+req.url,{method:req.method,headers:{...req.headers,'remote-user':proxyUser,'x-forwarded-for':'192.0.2.125'}},response=>{
      if(drop){response.resume();response.once('end',()=>res.destroy());}else{res.writeHead(response.statusCode,response.headers);response.pipe(res);}
    });forward.on('error',()=>res.destroy());req.on('aborted',()=>forward.destroy());res.on('close',()=>forward.destroy());forward.end(body);
  });});await new Promise(r=>proxy.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+proxy.address().port;
  await write(state=>Object.assign(state,{people:[{id:'me',name:'Host',color:'#d8923e',payMethod:'none',payId:'',email:'',greeting:''}],bills:[],settings:{currencyCode:'EUR'},futureTop:{kept:true},
    checks:{checks:[{id:'dinner',name:'Dinner',icon:'🍽️',dateISO:'2026-09-27',isCompleted:false,items:[{id:'soup',name:'Soup',price:12,sharedByParticipantIds:['host'],futureItem:{kept:true}}],participants:[{id:'host',name:'Host'}],paidParticipantIds:['host'],paymentRequestDates:{host:'2026-09-27T12:00:00Z'},taxAmount:1,tipAmount:2,discountAmount:0,compAmount:0,serviceFeeAmount:0,futurePrivate:'kept'}]}}));
  await link('create');await guest();await launchChrome();let tab=await cdp.tab(base+'/');await setup(tab);
  await cdp.evaluate(tab,"(async()=>{const c=reviewFixtureClient;await c.start(await c.transport.load('dinner'));})()");await choices(tab);
  assert.equal(await cdp.evaluate(tab,"reviewFixtureClient.preview('dinner').ready"),true);await prepare(tab);const first=(await row(tab)).pending.payload;
  await guest();const before=await household();const conflict=await cdp.evaluate(tab,"reviewFixtureClient.submit().then(()=>null,e=>e.code)");assert.equal(conflict,'CHECK_SHARE_CONFLICT');assert.deepEqual(await household(),before);assert.equal((await row(tab)).pending.payload,first);
  check('actual IndexedDB review and strict HTTP reject a newer guest selection without a financial write',()=>{});
  await cdp.evaluate(tab,"(async()=>{const c=reviewFixtureClient;await c.review('dinner',await c.transport.load('dinner'),true);})()");assert.equal(await cdp.evaluate(tab,"reviewFixtureClient.preview('dinner').ready"),false);
  await choices(tab);const preview=await cdp.evaluate(tab,"reviewFixtureClient.preview('dinner')");assert.deepEqual(preview.after.totals,{host:'500','guest-1':'500','guest-2':'500'});assert.deepEqual(preview.clearedPaid,['host']);assert.deepEqual(preview.clearedRequests,['host']);
  await prepare(tab);const original=(await row(tab)).pending.payload;dropNext=true;await cdp.evaluate(tab,"reviewFixtureClient.submit().catch(e=>e.message)");assert.equal((await row(tab)).pending.payload,original);
  const applied=await household(),checkValue=applied.state.checks.checks[0];assert.equal(checkValue.participants.length,3);assert.equal(checkValue.claimApplications.selections.length,2);assert.deepEqual(checkValue.paidParticipantIds,[]);assert.deepEqual(checkValue.items[0].futureItem,{kept:true});assert.equal(checkValue.futurePrivate,'kept');
  const publicState=await json('/public/share/check/'+(await share()).share.token+'/sync/snapshot');assert.equal(JSON.stringify(publicState).includes('claimApplications'),false);assert.equal(JSON.stringify(publicState).includes('futurePrivate'),false);assert.equal(JSON.stringify(publicState).includes('sharedByParticipantIds'),false);
  check('explicit same-name mappings save guarded assignments, reset changed payment flags and keep private provenance out of public data',()=>{});
  const exported=await cdp.evaluate(tab,"reviewFixtureClient.recovery('dinner')");assert.equal(exported.includes((await share()).share.token),false);assert.equal(exported.includes('futurePrivate'),false);await fs.writeFile(path.join(output,'sanitized-review-recovery.json'),exported+'\n');
  cdp.socket.close();await stop(chrome,true);chrome=null;dropPayload=null;await write(state=>{state.futureTop={later:true};});await launchChrome();tab=await cdp.tab(base+'/');await setup(tab);
  assert.equal((await row(tab)).pending.payload,original);await cdp.evaluate(tab,'reviewFixtureClient.submit()');assert.equal(requests.at(-1),original);assert.equal((await row(tab)).pending,null);assert.equal((await row(tab)).drafts.dinner,undefined);assert.deepEqual((await row(tab)).receipt.snapshot.state.futureTop,{later:true});
  assert.equal((await household()).state.checks.checks[0].participants.length,3);
  check('real Chrome process loss retries the exact financial request and retains newer server data without duplicating participants',()=>{});
  await cdp.evaluate(tab,"(async()=>{const c=reviewFixtureClient;await c.start(await c.transport.load('dinner'));})()");
  const rawPlan=await cdp.evaluate(tab,"(async()=>{const c=reviewFixtureClient,p=structuredClone(c.row.drafts.dinner.plan);p.newParticipants.push({id:'unsaved-guest',name:'  Draft only  '});await c.edit('dinner',p);return p;})()");
  cdp.socket.close();await stop(chrome,true);chrome=null;await launchChrome();tab=await cdp.tab(base+'/');await setup(tab);assert.deepEqual((await row(tab)).drafts.dinner.plan,rawPlan);
  check('unsubmitted raw review choices also survive complete browser process replacement',()=>{});
  await prepare(tab);const pending=(await row(tab)).pending.payload,unchanged=await household();proxyUser='other-review-owner';
  await cdp.evaluate(tab,'reviewFixtureClient.submit().catch(e=>e.message)');assert.equal((await row(tab)).pending.payload,pending);assert.equal((await row(tab)).pending.rejection,null);assert.deepEqual(await household(),unchanged);
  check('an account switch cannot apply or discard the original account financial request',()=>{});
  proxyUser='owner-ui-test';await cdp.evaluate(tab,'reviewFixtureClient.submit()');
  const saved=await row(tab);await cdp.evaluate(tab,"(async()=>{const c=reviewFixtureClient;await c.store.transact(c.scope,r=>{r.drafts={dinner:{broken:true}};return r;});})()");
  assert.match(await cdp.evaluate(tab,'reviewFixtureClient.open().catch(e=>e.message)'),/original record is kept/);
  assert.equal(await cdp.evaluate(tab,"(async()=>{const c=reviewFixtureClient;return (await c.store.transact(c.scope,r=>r)).drafts.dinner.broken;})()"),true);
  check('corrupt saved review remains intact and cannot prepare a new financial request',()=>{});
  assert.equal(failures.length,0,failures.join('\n'));
  await fs.writeFile(path.join(output,'browser-results.json'),JSON.stringify({passed:passes.length,checks:passes,browser:browserVersion,runtimeErrors:failures,limits:'Data modules loaded into the real owner page; no host-review controls integrated or exercised. Disposable strict server and proxy identities, not live authentication.'},null,2)+'\n');
  console.log('All '+passes.length+' browser host-review checks passed.');
}finally{cdp?.socket.close();await stop(chrome,true);await stop(server);if(proxy){proxy.closeAllConnections();await new Promise(r=>proxy.close(r));}await fs.rm(temp,{recursive:true,force:true});}
console.log('Owned browser/server processes exited; proxy and disposable data cleaned up.');
