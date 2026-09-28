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
const output=path.resolve(process.env.HOST_REVIEW_UI_EVIDENCE_DIR||path.join(root,'docs/evidence/browser-host-check-review-ui'));
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'billhive-host-review-ui-'));
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
  async idle(tab){await until(()=>this.evaluate(tab,"!hostReview.busy && !hostReview.dirty && !hostReview.calculating && !_openingCheckAction"),'Claim action completion');}
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
const action=name=>`#host-review-dialog [data-review-action="${name}"]`;
async function choose(tab,selector,value){await cdp.evaluate(tab,`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Unavailable select');e.focus();e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await cdp.idle(tab);}
async function type(tab,selector,value){await cdp.click(tab,selector);await cdp.evaluate(tab,`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(document.activeElement!==e)throw Error('Input lost focus: '+document.activeElement.outerHTML);e.select();})()`);await cdp.send('Input.insertText',{text:value},tab.session);await cdp.idle(tab);}
const row=tab=>cdp.evaluate(tab,'hostReview.client.row');
const view=tab=>cdp.evaluate(tab,"({error:hostReview.error,storageError:hostReview.storageError,message:hostReview.message,dirty:hostReview.dirty,busy:hostReview.busy,calculating:hostReview.calculating,comparison:!!hostReview.comparison,activeId:hostReview.activeId})");
async function open(tab){await cdp.click(tab,'.tab[data-page="checks"]');await cdp.click(tab,'.owner-check-sharing button[data-click^="openCheckGuestReview("]');await cdp.idle(tab);assert.ok((await row(tab)).drafts.dinner,JSON.stringify(await view(tab)));}
async function mapAll(tab){await cdp.click(tab,'#host-review-dialog [data-review-tab="guests"]');const sourceIds=await cdp.evaluate(tab,'hostReview.draft.baseline.sources.map(BillHiveCheckReview.sourceId)');
  for(const id of sourceIds){const choice=await cdp.evaluate(tab,`hostReview.working.choices[${JSON.stringify(id)}]`);if(choice?.action==='APPLY')continue;
    await choose(tab,`[data-review-field="action"][data-source="${id}"]`,'APPLY');await choose(tab,`[data-review-field="target"][data-source="${id}"]`,'__new__');}
}
async function totals(tab){await cdp.click(tab,'#host-review-dialog [data-review-tab="totals"]');await cdp.idle(tab);const need=await cdp.evaluate(tab,"!!document.querySelector('[data-review-field=\"payment-confirm\"]')");if(need&&!await cdp.evaluate(tab,'hostReview.confirmPaymentResets'))await cdp.click(tab,'[data-review-field="payment-confirm"]');}
async function screen(tab,name){const r=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},tab.session);await fs.writeFile(path.join(output,name+'.png'),Buffer.from(r.data,'base64'));}
async function exportReview(tab,name){const dir=path.join(temp,'downloads-'+name);await fs.mkdir(dir,{recursive:true});await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:dir});await cdp.click(tab,action('export'));return until(async()=>{try{return JSON.parse(await fs.readFile(path.join(dir,'guest-split-review.json'),'utf8'));}catch{return null;}},'Review recovery download');}
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
  await link('create');await guest();await guest();await launchChrome();let tab=await cdp.tab(base+'/');await open(tab);
  assert.equal(await cdp.evaluate(tab,'hostReviewPage.sources().length'),2);assert.equal(await cdp.evaluate(tab,'hostReview.preview.ready'),false);assert.equal(await cdp.evaluate(tab,"document.querySelector('button[data-click^=\"pullCheckClaims\"]')"),null);
  await mapAll(tab);assert.equal(await cdp.evaluate(tab,'hostReview.preview.ready'),true);
  await type(tab,'[data-review-field="name"]','  Alex <script>  ');await cdp.click(tab,'#host-review-title');await screen(tab,'guests-phone');
  assert.equal(await cdp.evaluate(tab,'hostReview.working.newParticipants[0].name'),'  Alex <script>  ');
  await cdp.click(tab,'#host-review-dialog [data-review-tab="items"]');await cdp.click(tab,'[data-review-field="manual"][data-person="host"]');await cdp.idle(tab);await screen(tab,'items-phone');
  await cdp.evaluate(tab,"(()=>{const boxes=[...document.querySelectorAll('[data-review-field=\"manual\"]')],ids=boxes.map(b=>b.dataset.person);for(const id of ids.slice(0,2))document.querySelector('[data-review-field=\"manual\"][data-person=\"'+id+'\"]').click();})()");await cdp.idle(tab);
  assert.equal(await cdp.evaluate(tab,"hostReview.working.manualByItem.soup.length"),2);await cdp.evaluate(tab,"(()=>{for(const id of [...hostReview.working.manualByItem.soup])document.querySelector('[data-review-field=\"manual\"][data-person=\"'+id+'\"]').click();})()");await cdp.idle(tab);assert.deepEqual(await cdp.evaluate(tab,'hostReview.working.manualByItem.soup'),[]);
  check('rapid manual checkbox edits preserve every choice before asynchronous previews finish',()=>{});
  assert.equal(await cdp.evaluate(tab,"hostReview.preview.after.totals.host"),'0');await totals(tab);await screen(tab,'totals-phone');
  check('actual host controls explicitly map same-name guests, preserve raw names and preview manual shares and payment resets',()=>{});
  await cdp.evaluate(tab,"window.originalReviewCalculate=hostReview.calculate;hostReview.calculate=async draft=>{await new Promise(resolve=>window.releaseReviewCalculate=resolve);return originalReviewCalculate(draft);}");
  await cdp.click(tab,'#host-review-dialog [data-review-tab="items"]');await cdp.click(tab,'[data-review-field="manual"][data-person="host"]');await cdp.click(tab,'#host-review-dialog [data-review-tab="totals"]');
  assert.equal(await cdp.evaluate(tab,'hostReview.calculating'),true);assert.equal(await cdp.evaluate(tab,"document.querySelector('[data-review-field=\"payment-confirm\"]').disabled"),true);
  await cdp.evaluate(tab,'releaseReviewCalculate();hostReview.calculate=originalReviewCalculate');await cdp.idle(tab);assert.equal(await cdp.evaluate(tab,'hostReview.confirmPaymentResets'),false);
  await cdp.click(tab,'#host-review-dialog [data-review-tab="items"]');await cdp.click(tab,'[data-review-field="manual"][data-person="host"]');await cdp.idle(tab);await totals(tab);
  check('payment-reset confirmation waits for the current saved and calculated preview',()=>{});
  const raw=(await row(tab)).drafts.dinner.plan;await cdp.click(tab,action('close'));assert.equal(await cdp.evaluate(tab,"document.querySelector('#host-review-attention').hidden"),false);
  cdp.socket.close();await stop(chrome,true);chrome=null;await launchChrome();tab=await cdp.tab(base+'/');await cdp.click(tab,'#host-review-attention button');await cdp.idle(tab);assert.deepEqual((await row(tab)).drafts.dinner.plan,raw);
  check('startup recovery reopens raw host choices after actual browser process loss',()=>{});
  await cdp.click(tab,'#host-review-dialog [data-review-tab="guests"]');
  await cdp.evaluate(tab,"(()=>{const store=hostReview.client.store;store.fixtureOriginal=store.transact;store.transact=async()=>{throw Error('Injected local storage failure');};})()");
  await cdp.click(tab,'[data-review-field="name"]');await cdp.evaluate(tab,'document.activeElement.select()');await cdp.send('Input.insertText',{text:'  Keep failed raw text  '},tab.session);await until(()=>cdp.evaluate(tab,'!!hostReview.storageError'),'Failed local review save');
  assert.equal(await cdp.evaluate(tab,'hostReview.dirty'),true);const failedExport=await exportReview(tab,'storage');assert.equal(failedExport.workingPlan.newParticipants[0].name,'  Keep failed raw text  ');
  await cdp.evaluate(tab,'hostReview.client.store.transact=hostReview.client.store.fixtureOriginal');await cdp.click(tab,action('reload'));await cdp.click(tab,action('confirm'));await cdp.idle(tab);assert.equal(await cdp.evaluate(tab,'hostReview.working.newParticipants[0].name'),raw.newParticipants[0].name);
  check('failed local storage preserves visible raw choices and downloadable recovery until explicit reload',()=>{});
  const other=await cdp.tab(base+'/');await cdp.click(other,'#host-review-attention button');await cdp.idle(other);await type(other,'[data-review-field="name"]','Other tab name');
  await cdp.click(tab,'[data-review-field="name"]');await cdp.evaluate(tab,'document.activeElement.select()');await cdp.send('Input.insertText',{text:'This tab raw name'},tab.session);await until(()=>cdp.evaluate(tab,'!!hostReview.storageError'),'Stale local review');
  assert.equal((await exportReview(tab,'stale')).workingPlan.newParticipants[0].name,'This tab raw name');await cdp.click(tab,action('reload'));await cdp.click(tab,action('confirm'));await cdp.idle(tab);assert.equal(await cdp.evaluate(tab,'hostReview.working.newParticipants[0].name'),'Other tab name');
  await cdp.send('Target.closeTarget',{targetId:other.id});cdp.last=tab;
  check('two browser tabs cannot silently overwrite each other’s host-review choices',()=>{});
  await cdp.evaluate(tab,"document.querySelector('#host-review-dialog [data-review-tab=\"guests\"]').focus()");await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9},tab.session);await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9},tab.session);
  assert.equal(await cdp.evaluate(tab,"document.activeElement.dataset.reviewTab"),'items');await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'},tab.session);await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},tab.session);assert.equal(await cdp.evaluate(tab,'hostReviewPage.tab'),'items');assert.equal(await cdp.evaluate(tab,'document.activeElement.dataset.reviewTab'),'items');
  await cdp.evaluate(tab,"document.querySelector('[data-review-field=\"manual\"][data-person=\"host\"]').focus()");for(let i=0;i<2;i++){await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32},tab.session);await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32},tab.session);await cdp.idle(tab);}
  assert.equal(await cdp.evaluate(tab,'document.activeElement.dataset.reviewField'),'manual');assert.deepEqual(await cdp.evaluate(tab,'hostReview.working.manualByItem.soup'),[]);
  check('keyboard navigation and space toggles retain focus through review rerenders',()=>{});
  await totals(tab);await guest();await cdp.click(tab,action('primary'));await cdp.idle(tab);assert.equal((await view(tab)).comparison,true);assert.equal(requests.length,0);await screen(tab,'comparison-phone');
  await cdp.click(tab,action('primary'));await cdp.idle(tab);assert.equal((await view(tab)).comparison,false);assert.equal(await cdp.evaluate(tab,'hostReview.preview.ready'),false);await mapAll(tab);await totals(tab);
  conflictNext=true;await cdp.click(tab,action('primary'));await cdp.idle(tab);assert.equal((await row(tab)).pending.rejection,'CHECK_SHARE_CONFLICT');
  await cdp.click(tab,action('primary'));await cdp.idle(tab);assert.equal((await view(tab)).comparison,true);await cdp.click(tab,action('primary'));await cdp.idle(tab);assert.equal((await row(tab)).pending,null);await mapAll(tab);await totals(tab);
  check('changed selections require visible comparison before and after a definite server rejection',()=>{});
  dropNext=true;await cdp.click(tab,action('primary'));await cdp.idle(tab);const original=(await row(tab)).pending.payload;assert.ok(original);assert.equal(await cdp.evaluate(tab,"[...document.querySelectorAll('[data-review-field]')].every(e=>e.disabled)"),true);
  const downloads=path.join(temp,'downloads');await fs.mkdir(downloads,{recursive:true});await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});await cdp.click(tab,action('export'));
  const exported=await until(async()=>{try{return await fs.readFile(path.join(downloads,'guest-split-review.json'),'utf8');}catch{return null;}},'Host recovery export');assert.equal(exported.includes((await share()).share.token),false);await screen(tab,'pending-phone');
  cdp.socket.close();await stop(chrome,true);chrome=null;dropPayload=null;await write(state=>{state.futureTop={later:true};});await launchChrome();tab=await cdp.tab(base+'/');
  await cdp.click(tab,'.tab[data-page="checks"]');await type(tab,'textarea[aria-label="Notes"]','Unsaved ordinary household note');
  await until(()=>cdp.evaluate(tab,'!!writer.error'),'Ordinary save blocked by pending split');assert.equal((await household()).state.checks.checks[0].notes,undefined);
  await cdp.click(tab,'#host-review-attention button');await cdp.idle(tab);await cdp.click(tab,action('primary'));await cdp.idle(tab);
  assert.equal(requests.at(-1),original);assert.equal((await row(tab)).pending,null);assert.equal(await cdp.evaluate(tab,"findCheck('dinner').notes"),'Unsaved ordinary household note');assert.equal(await cdp.evaluate(tab,'writer.dirty'),true);assert.deepEqual((await household()).state.futureTop,{later:true});
  const participants=(await household()).state.checks.checks[0].participants;assert.equal(participants.length,5);
  check('lost-response retry survives restart, applies once and preserves unrelated unsaved ordinary edits',()=>{});
  await cdp.click(tab,action('close'));await cdp.navigate(tab,base+'/');await open(tab);
  const shareToken=(await share()).share.token,pub=await json('/public/share/check/'+shareToken+'/sync/snapshot'),claimantId=crypto.createHash('sha256').update('check-claimant\0'+shareToken+'\0'+guestKeys[0]).digest('hex');
  await json('/public/share/check/'+shareToken+'/sync/claim',{serverInstanceId:pub.serverInstanceId,householdId:pub.householdId,checkId:pub.checkId,shareId:pub.shareId,claimantId,baseRevision:pub.revision,baseShareRevision:pub.shareRevision,mutationId:crypto.randomUUID(),claim:{claimerName:'Alex',itemIds:[]}},{'X-BillHive-Claimant-Key':guestKeys[0],'X-BillHive-Require-Protection':'1'});
  await cdp.click(tab,action('refresh'));await cdp.idle(tab);await cdp.click(tab,action('primary'));await cdp.idle(tab);await cdp.click(tab,'#host-review-dialog [data-review-tab="guests"]');
  const withdrawn=await cdp.evaluate(tab,`hostReviewPage.sources().find(r=>r.current?.claimantId===${JSON.stringify(claimantId)})`);assert.equal(withdrawn.choice.action,'KEEP_PREVIOUS');assert.equal(await cdp.evaluate(tab,`hostReview.preview.after.totals[${JSON.stringify(withdrawn.previous.participantId)}]`),'375');
  await choose(tab,`[data-review-field="action"][data-source="${withdrawn.id}"]`,'APPLY');await choose(tab,`[data-review-field="target"][data-source="${withdrawn.id}"]`,withdrawn.previous.participantId);await totals(tab);assert.equal(await cdp.evaluate(tab,`hostReview.preview.after.totals[${JSON.stringify(withdrawn.previous.participantId)}]`),'0');await cdp.click(tab,action('primary'));await cdp.idle(tab);
  assert.equal((await household()).state.checks.checks[0].claimApplications.selections.find(s=>s.source.claimantId===claimantId).itemIds.length,0);
  check('withdrawal keeps prior charges until the owner explicitly reviews and applies the empty selection',()=>{});
  await cdp.click(tab,action('close'));await open(tab);await cdp.click(tab,action('close'));await until(()=>cdp.evaluate(tab,'_loaded && !_reloading && !hostReviewPage.open'),'Online reload completes before offline reopening');await cdp.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0},tab.session);await cdp.click(tab,'#host-review-attention button');await until(()=>cdp.evaluate(tab,'hostReviewPage.open'),'Offline saved-review navigation');await cdp.idle(tab);assert.ok(await cdp.evaluate(tab,'hostReview.preview'));assert.equal((await view(tab)).error,'');
  await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1},tab.session);
  check('saved reviews reopen offline inside the already authenticated owner page',()=>{});
  await totals(tab);await cdp.evaluate(tab,"(()=>{const sizes=[...document.querySelectorAll('#host-review-dialog *')].map(e=>[e,getComputedStyle(e).fontSize]);for(const [e,size]of sizes)e.style.fontSize=parseFloat(size)*2+'px';})()");await screen(tab,'totals-phone-large');
  assert.equal(await cdp.evaluate(tab,"(()=>{const d=document.querySelector('#host-review-dialog'),b=d.querySelector('[data-review-action=\"primary\"]').getBoundingClientRect();return d.scrollWidth<=d.clientWidth+1&&b.top>=0&&b.bottom<=innerHeight+1;})()"),true);
  check('phone review keeps its primary action visible with doubled rendered text',()=>{});
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:480,deviceScaleFactor:1,mobile:true},tab.session);await screen(tab,'totals-short-phone-large');
  assert.equal(await cdp.evaluate(tab,"(()=>{const b=document.querySelector('#host-review-dialog [data-review-action=\"primary\"]').getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight+1;})()"),true);
  check('the primary action stays visible in a short phone viewport with doubled rendered text',()=>{});
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1024,height:768,deviceScaleFactor:1,mobile:true},tab.session);await cdp.evaluate(tab,"(()=>{for(const e of document.querySelectorAll('#host-review-dialog *'))e.style.fontSize='';document.documentElement.dataset.theme='light';})()");await screen(tab,'totals-tablet-light');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},tab.session);
  await cdp.click(tab,action('close'));await write(state=>{state.checks.checks[0].isCompleted=true;});await cdp.navigate(tab,base+'/');await cdp.click(tab,'#host-review-attention button');await cdp.idle(tab);await cdp.click(tab,action('refresh'));await cdp.idle(tab);assert.equal(await cdp.evaluate(tab,'hostReview.comparison.unavailable'),true);
  assert.equal(await cdp.evaluate(tab,`document.querySelector(${JSON.stringify(action('primary'))}).disabled`),true);assert.equal(await cdp.evaluate(tab,`document.querySelector(${JSON.stringify(action('export'))}).disabled`),false);
  check('completed checks retain saved-review recovery while blocking new financial application',()=>{});
  await cdp.click(tab,action('close'));await write(state=>{state.checks.checks=[];});await cdp.navigate(tab,base+'/');assert.match(await cdp.evaluate(tab,"document.querySelector('#host-review-attention').textContent"),/Removed check/);await cdp.click(tab,'#host-review-attention button');await cdp.idle(tab);await cdp.click(tab,action('refresh'));await cdp.idle(tab);assert.equal(await cdp.evaluate(tab,'hostReview.comparison.fresh.sharing.checkExists'),false);assert.ok((await exportReview(tab,'removed')).savedPlan);
  check('removed checks remain reachable through startup recovery and retain exportable review choices',()=>{});
  proxyUser='another-owner';await cdp.click(tab,action('refresh'));await cdp.idle(tab);assert.equal(await cdp.evaluate(tab,'hostReview.scope'),null);assert.equal(await cdp.evaluate(tab,'hostReviewPage.open'),false);assert.equal(await cdp.evaluate(tab,"document.querySelector('#app').hidden"),true);
  check('account switching clears the visible review while preserving its original account journal',()=>{});
  proxyUser='owner-ui-test';await cdp.click(tab,'#retry-load');await until(()=>cdp.evaluate(tab,"typeof _loaded!=='undefined'&&_loaded&&!!hostReview.client?.row&&!_reloading"),'Original account reload');
  await cdp.evaluate(tab,"(async()=>{const c=hostReview.client;await c.store.transact(c.scope,r=>{r.drafts.dinner.plan='unreadable saved choices';return r;});})()");await cdp.navigate(tab,base+'/');assert.match(await cdp.evaluate(tab,"document.querySelector('#host-review-attention').textContent"),/original record is kept/);await cdp.click(tab,'#host-review-attention button');
  assert.equal(await cdp.evaluate(tab,"(async()=>{const c=hostReview.client;return (await c.store.transact(c.scope,r=>r)).drafts.dinner.plan;})()"),'unreadable saved choices');
  check('corrupt review storage is surfaced at startup and retained after a retry',()=>{});
  assert.deepEqual(await cdp.evaluate(tab,"(()=>{const check={participants:[{id:'a'},{id:'b'},{id:'c'}],items:[{id:'penny',price:'0.01',sharedByParticipantIds:[]}]};const amounts=checkExactAmounts(check);return check.participants.map(p=>checkShareAmount(amounts,p.id));})()"),['EUR 0.01','EUR 0.00','EUR 0.00']);
  check('ordinary Checks participant displays agree with the reviewed penny allocation',()=>{});
  assert.equal(failures.length,0,failures.join('\n'));
  await fs.writeFile(path.join(output,'results.json'),JSON.stringify({passed:passes.length,checks:passes,browser:browserVersion,runtimeErrors:failures,limits:'Desktop Chrome mobile emulation, injected large text, synthetic authenticated proxy, isolated data. Physical-device and other-browser acceptance remain.'},null,2)+'\n');
  console.log('All '+passes.length+' actual host-review UI checks passed.');
}catch(error){if(cdp&&chrome?.exitCode===null){try{await screen(cdp.last,'failure');await fs.writeFile(path.join(output,'failure.txt'),String(error.stack)+'\n'+JSON.stringify({failures,state:await view(cdp.last),body:await cdp.evaluate(cdp.last,'document.body.innerText.slice(-14000)')},null,2));}catch{}}throw error;}
finally{cdp?.socket.close();await stop(chrome,true);await stop(server);if(proxy){proxy.closeAllConnections();await new Promise(r=>proxy.close(r));}await fs.rm(temp,{recursive:true,force:true});}
console.log('Owned browser/server processes exited; proxy and disposable data cleaned up.');
