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
const output=path.resolve(process.env.CHECK_REMOVAL_EVIDENCE_DIR||path.join(root,'docs/evidence/browser-check-removal'));
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'billhive-check-removal-'));
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
  async click(tab,selector){const box=await this.evaluate(tab,`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Unavailable control: '+${JSON.stringify(selector)});e.scrollIntoView({block:'center',behavior:'instant'});const b=e.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
    await this.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box},tab.session);await this.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box},tab.session);}
  async name(tab,value){await this.evaluate(tab,`(()=>{const e=document.querySelector('#nameInput');e.scrollIntoView({block:'center',behavior:'instant'});e.focus();e.select();})()`);await this.send('Input.insertText',{text:value},tab.session);await this.idle(tab);}
  async idle(tab){await until(()=>this.evaluate(tab,"!checkRemoval.busy && !checkRemoval.dirty && !_openingCheckAction"),'Claim action completion');}
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
const guestKeys=[];
async function guest(){const token=(await share()).share.token,s=await json('/public/share/check/'+token+'/sync/snapshot'),key=crypto.randomBytes(32).toString('hex');guestKeys.push(key);
  return json('/public/share/check/'+token+'/sync/claim',{serverInstanceId:s.serverInstanceId,householdId:s.householdId,checkId:s.checkId,shareId:s.shareId,claimantId:crypto.createHash('sha256').update('check-claimant\0'+token+'\0'+key).digest('hex'),baseRevision:s.revision,baseShareRevision:s.shareRevision,mutationId:crypto.randomUUID(),claim:{claimerName:'Alex',itemIds:['soup']}},{'X-BillHive-Claimant-Key':key,'X-BillHive-Require-Protection':'1'});}

const action=name=>`#check-removal-dialog [data-removal-action="${name}"]`;
const row=tab=>cdp.evaluate(tab,'checkRemoval.client.row');
const view=tab=>cdp.evaluate(tab,'({error:checkRemoval.error,storageError:checkRemoval.storageError,dirty:checkRemoval.dirty,busy:checkRemoval.busy,activeId:checkRemoval.activeId,comparison:!!checkRemoval.comparison})');
async function open(tab,id='dinner'){await cdp.click(tab,'.tab[data-page="checks"]');await cdp.click(tab,`#page-checks button[data-click="deleteCheck('${id}')"]`);await until(()=>cdp.evaluate(tab,'checkRemovalPage.open'),'Deletion dialog opens');await cdp.idle(tab);assert.equal(await cdp.evaluate(tab,'checkRemoval.activeId'),id,JSON.stringify(await view(tab)));}
async function confirm(tab,value=true){const current=await cdp.evaluate(tab,'checkRemoval.working');if(current!==value)await cdp.click(tab,'[data-removal-confirm]');await cdp.idle(tab);}
async function screen(tab,name){await cdp.evaluate(tab,"(async()=>{await document.fonts.ready;await new Promise(requestAnimationFrame);await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));})()");const r=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},tab.session);await fs.writeFile(path.join(output,name+'.png'),Buffer.from(r.data,'base64'));}
async function close(tab){await cdp.click(tab,action('close'));await until(()=>cdp.evaluate(tab,'!_reloading && !checkRemovalPage.open'),'Close and deferred reload');}
async function exported(tab,name){const directory=path.join(temp,name);await fs.mkdir(directory,{recursive:true});await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:directory});await cdp.click(tab,action('export'));return until(async()=>{try{return JSON.parse(await fs.readFile(path.join(directory,'check-deletion-review.json'),'utf8'));}catch{return null;}},'Deletion recovery download');}
try{
  await fs.mkdir(output,{recursive:true});const serverPort=await port();upstream='http://127.0.0.1:'+serverPort;
  server=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:String(serverPort),DB_PATH:path.join(temp,'server.db'),TRUSTED_AUTH_HEADERS:'remote-user',TRUST_PROXY:'loopback',SYNC_REQUIRE_PRECONDITIONS:'1'},stdio:['ignore','pipe','pipe']});
  let serverOutput='';server.stdout.on('data',c=>serverOutput+=c);server.stderr.on('data',c=>serverOutput+=c);await until(()=>serverOutput.includes('running on'),'Host review UI fixture server');
  proxy=http.createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',async()=>{
    const body=Buffer.concat(chunks),financialWrite=req.method==='POST'&&req.url==='/api/sync/commit'&&body.includes('checkSharePreconditions');
    if(financialWrite)requests.push(body.toString());const drop=financialWrite&&(dropNext||dropPayload===body.toString());if(drop){dropNext=false;dropPayload=body.toString();}
    if(financialWrite&&conflictNext){conflictNext=false;await guest();}
    const forward=http.request(upstream+req.url,{method:req.method,headers:{...req.headers,'remote-user':proxyUser,'x-forwarded-for':'192.0.2.126'}},response=>{
      if(drop){response.resume();response.once('end',()=>res.destroy());}else{res.writeHead(response.statusCode,response.headers);response.pipe(res);}
    });forward.on('error',()=>res.destroy());req.on('aborted',()=>forward.destroy());res.on('close',()=>forward.destroy());forward.end(body);
  });});await new Promise(r=>proxy.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+proxy.address().port;
  await write(state=>Object.assign(state,{people:[{id:'me',name:'Host',color:'#d8923e',payMethod:'none',payId:'',email:'',greeting:''}],bills:[],settings:{currencyCode:'EUR'},futureTop:{kept:true},
    checks:{checks:[{id:'dinner',name:'Dinner',icon:'🍽️',dateISO:'2026-09-27',isCompleted:false,items:[{id:'soup',name:'Soup',price:12,sharedByParticipantIds:['host'],futureItem:{kept:true}}],participants:[{id:'host',name:'Host'}],paidParticipantIds:['host'],paymentRequestDates:{host:'2026-09-27T12:00:00Z'},taxAmount:1,tipAmount:2,discountAmount:0,compAmount:0,serviceFeeAmount:0,futurePrivate:'kept'}]}}));

  await link('create');await guest();const originalCheck=structuredClone((await household()).state.checks.checks[0]);const originalToken=(await share()).share.token;
  await launchChrome();let tab=await cdp.tab(base+'/');await cdp.click(tab,'.tab[data-page="checks"]');await cdp.click(tab,'.owner-check-sharing button[data-click^="openCheckGuestReview("]');await until(()=>cdp.evaluate(tab,'hostReviewPage.open && !hostReview.busy && !hostReview.calculating'),'Unfinished split review');await cdp.click(tab,'#host-review-dialog [data-review-action="close"]');await until(()=>cdp.evaluate(tab,'!_reloading'),'Split close reload');
  await open(tab);assert.equal(await cdp.evaluate(tab,`document.querySelector(${JSON.stringify(action('primary'))}).disabled`),true);assert.match(await cdp.evaluate(tab,'document.querySelector("#check-removal-dialog").innerText'),/permanently revoked/);await screen(tab,'review-phone');await confirm(tab);await close(tab);assert.ok((await household()).state.checks.checks.find(c=>c.id==='dinner'));
  check('actual Delete opens a detailed guarded review and closing preserves confirmation without deleting',()=>{});
  cdp.socket.close();await stop(chrome,true);chrome=null;await launchChrome();tab=await cdp.tab(base+'/');await cdp.click(tab,'#host-review-attention button[data-click^="deleteCheck("]');await cdp.idle(tab);assert.equal(await cdp.evaluate(tab,'checkRemoval.working'),true);assert.ok((await row(tab)).drafts.dinner);
  check('saved deletion confirmation and unfinished split review survive actual browser process replacement',()=>{});
  await close(tab);await cdp.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0},tab.session);await cdp.click(tab,'#host-review-attention button[data-click^="deleteCheck("]');await until(()=>cdp.evaluate(tab,'checkRemovalPage.open'),'Offline deletion opens');await cdp.idle(tab);assert.equal(await cdp.evaluate(tab,'checkRemoval.working'),true);await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1},tab.session);
  check('saved deletion can reopen offline inside an authenticated loaded page',()=>{});
  await write(state=>{state.checks.checks[0].notes='Newer check notes';state.checks.checks[0].futurePrivate={changed:true};});await cdp.click(tab,action('primary'));await cdp.idle(tab);assert.equal((await view(tab)).comparison,true);assert.equal(requests.length,0);await screen(tab,'comparison-phone');await fs.writeFile(path.join(output,'comparison-layout.json'),JSON.stringify(await cdp.evaluate(tab,"(()=>{const e=document.querySelector('#check-removal-dialog .host-review-actions');return {display:getComputedStyle(e).display,wrap:getComputedStyle(e).flexWrap,overflow:getComputedStyle(e).overflow,height:e.getBoundingClientRect().height,items:[...e.children].map(b=>({text:b.innerText,rect:b.getBoundingClientRect().toJSON(),scrollWidth:b.scrollWidth,clientWidth:b.clientWidth}))};})()"),null,2));assert.equal(await cdp.evaluate(tab,"(()=>{const b=document.querySelector('#check-removal-dialog .host-review-body');return b.scrollWidth<=b.clientWidth+1;})()"),true);
  await guest();await cdp.click(tab,action('primary'));await cdp.idle(tab);assert.match((await view(tab)).error,/changed again/);await cdp.click(tab,action('primary'));await cdp.idle(tab);assert.equal(await cdp.evaluate(tab,'checkRemoval.working'),false);
  check('changed check data and guest declarations require current comparison and renewed confirmation',()=>{});
  await cdp.evaluate(tab,"(()=>{const store=checkRemoval.client.store;store.savedTransact=store.transact;store.transact=async()=>{throw Error('Injected storage failure');};})()");await cdp.click(tab,'[data-removal-confirm]');await until(()=>cdp.evaluate(tab,'!!checkRemoval.storageError'),'Storage failure');assert.equal(await cdp.evaluate(tab,'checkRemoval.dirty'),true);assert.equal((await exported(tab,'failed')).workingConfirmation,true);
  await cdp.evaluate(tab,'checkRemoval.client.store.transact=checkRemoval.client.store.savedTransact');await cdp.click(tab,action('reload'));await cdp.click(tab,action('confirm'));await cdp.idle(tab);assert.equal(await cdp.evaluate(tab,'checkRemoval.working'),false);
  check('failed confirmation storage preserves the working choice for export and explicit reload',()=>{});
  const other=await cdp.tab(base+'/');await cdp.click(other,'#host-review-attention button[data-click^="deleteCheck("]');await cdp.idle(other);await confirm(other);await cdp.click(tab,'[data-removal-confirm]');await until(()=>cdp.evaluate(tab,'!!checkRemoval.storageError'),'Stale tab confirmation');assert.equal(await cdp.evaluate(tab,'checkRemoval.dirty'),true);await cdp.click(tab,action('reload'));await cdp.click(tab,action('confirm'));await cdp.idle(tab);assert.equal(await cdp.evaluate(tab,'checkRemoval.working'),true);await cdp.send('Target.closeTarget',{targetId:other.id});cdp.last=tab;
  check('two tabs cannot silently replace a newer deletion confirmation',()=>{});
  await cdp.evaluate(tab,"document.querySelector('[data-removal-confirm]').focus()");for(let i=0;i<2;i++){await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32},tab.session);await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32},tab.session);await cdp.idle(tab);}assert.equal(await cdp.evaluate(tab,'document.activeElement.dataset.removalKey'),'confirmation');assert.equal(await cdp.evaluate(tab,'checkRemoval.working'),true);
  check('native checkbox keyboard toggles retain focus and save in order',()=>{});
  await cdp.evaluate(tab,"(()=>{const sizes=[...document.querySelectorAll('#check-removal-dialog *')].map(e=>[e,getComputedStyle(e).fontSize]);for(const [e,size]of sizes)e.style.fontSize=parseFloat(size)*2+'px';})()");await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:480,deviceScaleFactor:1,mobile:true},tab.session);await screen(tab,'review-short-phone-large');assert.equal(await cdp.evaluate(tab,"(()=>{const d=document.querySelector('#check-removal-dialog'),r=d.querySelector('[data-removal-action=primary]').getBoundingClientRect();return d.scrollWidth<=d.clientWidth+1&&r.top>=0&&r.bottom<=innerHeight+1;})()"),true);
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1024,height:768,deviceScaleFactor:1,mobile:true},tab.session);await cdp.evaluate(tab,"(()=>{for(const e of document.querySelectorAll('#check-removal-dialog *'))e.style.fontSize='';document.documentElement.dataset.theme='light';})()");await screen(tab,'review-tablet-light');await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},tab.session);
  check('deletion primary action remains visible at doubled text in a short phone viewport',()=>{});
  conflictNext=true;await cdp.click(tab,action('primary'));await cdp.idle(tab);assert.equal((await row(tab)).pending.rejection,'CHECK_SHARE_CONFLICT');await cdp.click(tab,action('primary'));await cdp.idle(tab);await cdp.click(tab,action('primary'));await cdp.idle(tab);assert.equal(await cdp.evaluate(tab,'checkRemoval.working'),false);await confirm(tab);
  check('guest changes after preparation reject deletion and require a fresh review',()=>{});
  await write(state=>{state.futureTop={newer:true};state.checks.futureContainer={keep:true};state.checks.checks.push({id:'spare',name:'Independent check',items:[],participants:[],dateISO:'2026-09-27'});});
  dropNext=true;await cdp.click(tab,action('primary'));await cdp.idle(tab);const original=(await row(tab)).pending.payload;assert.ok(original);const removed=await household();assert.equal(removed.state.checks.checks.some(c=>c.id==='dinner'),false);assert.deepEqual(removed.state.futureTop,{newer:true});assert.deepEqual(removed.state.checks.futureContainer,{keep:true});assert.equal((await share()).share,null);assert.equal((await fetch(upstream+'/public/share/check/'+originalToken+'/sync/snapshot')).status,410);assert.ok((await row(tab)).drafts.dinner);assert.equal(JSON.stringify(await exported(tab,'pending')).includes(originalToken),false);await screen(tab,'pending-phone');
  check('reviewed deletion preserves unrelated newer records and permanently revokes the active link',()=>{});
  cdp.socket.close();await stop(chrome,true);chrome=null;dropPayload=null;await launchChrome();tab=await cdp.tab(base+'/');await cdp.click(tab,'.tab[data-page="checks"]');await cdp.click(tab,'textarea[aria-label="Notes"]');await cdp.send('Input.insertText',{text:'Ordinary unsaved note'},tab.session);await until(()=>cdp.evaluate(tab,'!!writer.error'),'Ordinary save blocked by deletion');
  await cdp.click(tab,'#host-review-attention button[data-click^="openCheckGuestReview("]');await until(()=>cdp.evaluate(tab,'checkRemovalPage.open'),'Pending deletion redirects split recovery');await cdp.idle(tab);await cdp.click(tab,action('primary'));await cdp.idle(tab);assert.equal(requests.at(-1),original);assert.equal((await row(tab)).pending,null);assert.equal(await cdp.evaluate(tab,"findCheck('spare').notes"),'Ordinary unsaved note');assert.equal(await cdp.evaluate(tab,'writer.dirty'),true);assert.ok((await row(tab)).drafts.dinner);await close(tab);await cdp.navigate(tab,base+'/');
  assert.equal(await cdp.evaluate(tab,"(async()=>{const c=ownerSharing.client('dinner');await c.open();return c.row.snapshot;})()"),null);
  check('exact deletion retry survives restart, routes recovery correctly and preserves ordinary edits and split drafts',()=>{});
  check('confirmed deletion clears the eligible stale sharing cache on reload',()=>{});
  await write(state=>{state.checks.checks.push({...originalCheck,name:'Restored dinner'});});await link('create');const restoredToken=(await share()).share.token;assert.notEqual(restoredToken,originalToken);assert.equal((await fetch(upstream+'/public/share/check/'+originalToken+'/sync/snapshot')).status,410);await cdp.navigate(tab,base+'/');await open(tab);await confirm(tab);dropNext=true;await cdp.click(tab,action('primary'));await cdp.idle(tab);const secondPending=(await row(tab)).pending.payload;
  await write(state=>{state.checks.checks.push({...originalCheck,name:'Restored after deletion'});});await link('create');const newestToken=(await share()).share.token;dropPayload=null;await cdp.click(tab,action('primary'));await cdp.idle(tab);assert.equal(requests.at(-1),secondPending);assert.equal((await household()).state.checks.checks.find(c=>c.id==='dinner').name,'Restored after deletion');assert.equal((await share()).share.token,newestToken);assert.notEqual(newestToken,restoredToken);await close(tab);
  check('replaying an older deletion never removes a newer restored check or its new link',()=>{});
  await write(state=>{state.checks.checks.find(c=>c.id==='dinner').isCompleted=true;});await cdp.navigate(tab,base+'/');await open(tab);assert.match(await cdp.evaluate(tab,'document.querySelector("#check-removal-dialog").innerText'),/Completed/);await confirm(tab);
  await cdp.evaluate(tab,"(()=>{const transport=checkRemoval.client.transport,send=transport.send.bind(transport);transport.send=async payload=>{const result=await send(payload);const store=ownerSharing.store;store.savedTransact=store.transact;store.transact=async()=>{throw Error('Injected cleanup storage failure');};return result;};})()");
  await cdp.click(tab,action('primary'));await cdp.idle(tab);assert.equal((await household()).state.checks.checks.some(c=>c.id==='dinner'),false);assert.equal((await row(tab)).pending,null);assert.ok((await row(tab)).removedSharing.dinner);assert.match(await cdp.evaluate(tab,"document.querySelector('#host-review-attention').textContent"),/cleanup to retry/);
  await cdp.evaluate(tab,'ownerSharing.store.transact=ownerSharing.store.savedTransact');await close(tab);assert.equal(await cdp.evaluate(tab,'financialCheckRow().removedSharing.dinner'),undefined);
  check('failed sharing cleanup remains durably queued after deletion and retries on reload',()=>{});
  check('completed checks can be explicitly reviewed and deleted',()=>{});
  await open(tab,'spare');await write(state=>{state.checks.checks=[];});await cdp.click(tab,action('refresh'));await cdp.idle(tab);assert.equal(await cdp.evaluate(tab,'checkRemoval.comparison.unavailable'),true);assert.equal((await exported(tab,'removed')).checkId,'spare');await close(tab);
  check('externally removed checks retain their saved deletion review and recovery export',()=>{});
  await cdp.click(tab,'#host-review-attention button[data-click^="deleteCheck("]');await cdp.idle(tab);proxyUser='another-owner';await cdp.click(tab,action('refresh'));await until(()=>cdp.evaluate(tab,"document.querySelector('#app').hidden && !checkRemovalPage.open"),'Account changed');assert.equal(await cdp.evaluate(tab,'checkRemoval.scope'),null);
  check('account switching hides the deletion and keeps its original account journal',()=>{});
  proxyUser='owner-ui-test';await cdp.click(tab,'#retry-load');await until(()=>cdp.evaluate(tab,'_loaded && !_reloading && !!checkRemoval.client?.row'),'Original account reload');await cdp.evaluate(tab,"(async()=>{const c=checkRemoval.client;await c.store.transact(c.scope,r=>{r.removals.spare.confirmed='corrupt';return r;});})()");await cdp.navigate(tab,base+'/');assert.match(await cdp.evaluate(tab,"document.querySelector('#host-review-attention').textContent"),/original record is kept/);await cdp.click(tab,'#host-review-attention button');assert.equal(await cdp.evaluate(tab,"(async()=>{const c=checkRemoval.client;return (await c.store.transact(c.scope,r=>r)).removals.spare.confirmed;})()"),'corrupt');
  check('corrupt saved deletion stays visible for recovery and is never replaced',()=>{});
  assert.equal(failures.length,0,failures.join('\n'));await fs.writeFile(path.join(output,'results.json'),JSON.stringify({passed:passes.length,checks:passes,browser:browserVersion,runtimeErrors:failures,limits:'Desktop Chrome with emulated phone/tablet viewport and injected doubled text; physical devices and other browsers remain unverified.'},null,2)+'\n');console.log('All '+passes.length+' actual deletion browser checks passed.');
}catch(error){if(cdp&&chrome?.exitCode===null){try{await screen(cdp.last,'failure');await fs.writeFile(path.join(output,'failure.txt'),String(error.stack)+'\n'+JSON.stringify({failures,state:await view(cdp.last),body:await cdp.evaluate(cdp.last,'document.body.innerText.slice(-14000)')},null,2));}catch{}}throw error;}
finally{cdp?.socket.close();await stop(chrome,true);await stop(server);if(proxy){proxy.closeAllConnections();await new Promise(r=>proxy.close(r));}await fs.rm(temp,{recursive:true,force:true});}
console.log('Owned browser/server processes exited; proxy and disposable data cleaned up.');
