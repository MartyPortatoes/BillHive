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
const output=path.resolve(process.env.OWNER_UI_EVIDENCE_DIR||path.join(root,'docs/evidence/browser-owner-check-ui'));
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'billhive-owner-ui-'));
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
const sharing='.owner-check-sharing[data-owner-check="dinner"]';
function button(text,section=sharing){return `${section} button[data-click^="${text}("]`;}
const row=tab=>cdp.evaluate(tab,"ownerSharing.view('dinner').row");
const message=tab=>cdp.evaluate(tab,"ownerSharing.view('dinner').message");
async function dialog(tab){await until(()=>cdp.evaluate(tab,"document.querySelector('#modal-overlay').style.display==='flex'"),'Owner confirmation');}
async function download(tab){const dir=path.join(temp,'downloads');await fs.mkdir(dir,{recursive:true});await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:dir});await cdp.click(tab,button('exportCheckSharing'));await cdp.idle(tab);
  return until(async()=>{try{return JSON.parse(await fs.readFile(path.join(dir,'check-sharing-recovery.json'),'utf8'));}catch{return null;}},'Owner recovery download');}
try {
  await fs.mkdir(output,{recursive:true});const serverPort=await port();upstream='http://127.0.0.1:'+serverPort;
  server=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:String(serverPort),DB_PATH:path.join(temp,'server.db'),TRUSTED_AUTH_HEADERS:'remote-user',TRUST_PROXY:'loopback',SYNC_REQUIRE_PRECONDITIONS:'1'},stdio:['ignore','pipe','pipe']});
  let serverOutput='';server.stdout.on('data',c=>serverOutput+=c);server.stderr.on('data',c=>serverOutput+=c);await until(()=>serverOutput.includes('running on'),'Owner fixture server');
  proxy=http.createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',async()=>{
    const body=Buffer.concat(chunks),route=req.url,ownerWrite=req.method==='POST'&&/^\/api\/share\/check\/[^/]+\/sync\/commit$/.test(route);
    if(ownerWrite)requests.push(body.toString());const drop=ownerWrite&&(dropNext||dropPayload===body.toString());if(drop){dropNext=false;dropPayload=body.toString();}
    if(ownerWrite&&conflictNext){conflictNext=false;await guest();}
    const forward=http.request(upstream+route,{method:req.method,headers:{...req.headers,'remote-user':proxyUser,'x-forwarded-for':'192.0.2.124'}},response=>{
      if(drop){response.resume();response.once('end',()=>res.destroy());}else{res.writeHead(response.statusCode,response.headers);response.pipe(res);}
    });forward.on('error',()=>res.destroy());req.on('aborted',()=>forward.destroy());res.on('close',()=>forward.destroy());forward.end(body);
  });});await new Promise(r=>proxy.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+proxy.address().port;
  await write(state=>Object.assign(state,{people:[{id:'me',name:'Host',color:'#d8923e',payMethod:'none',payId:'',email:'',greeting:''}],bills:[],settings:{currencyCode:'EUR'},futureTop:{kept:true},
    checks:{checks:[{id:'dinner',name:'Dinner with a descriptive name',icon:'🍽️',dateISO:'2026-09-27',isCompleted:false,items:[{id:'soup',name:'Soup',price:12,sharedByParticipantIds:['host']}],participants:[{id:'host',name:'Host'}],taxAmount:1,tipAmount:2,discountAmount:0,compAmount:0,serviceFeeAmount:0}]}}));
  const initial=await household();await launchChrome();let tab=await cdp.tab(base+'/');await cdp.click(tab,'.tab[data-page="checks"]');
  await cdp.click(tab,button('createCheckShareWeb'));await cdp.idle(tab);
  assert.ok((await share()).share,await message(tab));assert.equal((await row(tab)).pending,null);assert.deepEqual((await household()).state,initial.state);
  check('actual owner Generate control creates a protected link without changing household data',()=>{});await cdp.screenshot(tab,'owner-link-phone');
  await guest();await guest();await cdp.click(tab,button('refreshCheckShareWeb'));await cdp.idle(tab);
  assert.equal(await cdp.evaluate(tab,`document.querySelector(${JSON.stringify(sharing)}).querySelectorAll('.mode-row').length`),2);
  check('owner page displays same-name guest declarations independently',()=>{});
  const token=(await share()).share.token;await cdp.click(tab,button('createCheckShareWeb'));await dialog(tab);await cdp.click(tab,'#modal-cancel-btn');await cdp.idle(tab);assert.equal((await share()).share.token,token);
  check('canceling replacement does not create or send a request',()=>{});
  await cdp.click(tab,button('createCheckShareWeb'));await dialog(tab);await guest();await cdp.click(tab,'#modal-ok-btn');await cdp.idle(tab);
  assert.match(await message(tab),/changed during confirmation/);assert.equal((await share()).share.token,token);assert.equal((await row(tab)).pending,null);
  check('guest changes during replacement confirmation require a fresh review',()=>{});await cdp.screenshot(tab,'owner-confirmation-changed-phone');
  await cdp.click(tab,button('createCheckShareWeb'));await dialog(tab);await cdp.click(tab,'#modal-ok-btn');await cdp.idle(tab);assert.notEqual((await share()).share.token,token);
  check('reviewed replacement changes the active link through the actual controls',()=>{});
  conflictNext=true;await cdp.click(tab,button('createCheckShareWeb'));await dialog(tab);await cdp.click(tab,'#modal-ok-btn');await cdp.idle(tab);
  assert.equal((await row(tab)).pending.rejection,'SHARE_CONFLICT');const rejected=(await row(tab)).pending.payload;
  await cdp.click(tab,button('dismissCheckSharing'));await dialog(tab);await cdp.click(tab,'#modal-cancel-btn');await cdp.idle(tab);assert.equal((await row(tab)).pending.payload,rejected);
  await cdp.click(tab,button('dismissCheckSharing'));await dialog(tab);await cdp.click(tab,'#modal-ok-btn');await cdp.idle(tab);assert.equal((await row(tab)).pending,null);
  check('definite server rejection keeps its request until the user confirms clearing it',()=>{});
  dropNext=true;await cdp.click(tab,button('createCheckShareWeb'));await dialog(tab);await cdp.click(tab,'#modal-ok-btn');await cdp.idle(tab);
  const pending=(await row(tab)).pending;assert.ok(pending&&!pending.rejection,await message(tab));const original=pending.payload;
  assert.equal(await cdp.evaluate(tab,"document.querySelector('#owner-sharing-attention').hidden"),false);
  const exported=await download(tab);assert.deepEqual(exported.pendingRequest,JSON.parse(original));assert.equal(JSON.stringify(exported).includes((await share()).share.token),false);
  await cdp.screenshot(tab,'owner-pending-recovery-phone');
  cdp.socket.close();await stop(chrome,true);chrome=null;dropPayload=null;await launchChrome();tab=await cdp.tab(base+'/');
  assert.equal(await cdp.evaluate(tab,"document.querySelector('#owner-sharing-attention').hidden"),false);
  await cdp.click(tab,'#owner-sharing-attention button');await cdp.click(tab,button('reopenCheckSharing','#owner-sharing-recovery '+sharing));await cdp.idle(tab);
  assert.equal((await row(tab)).pending.payload,original);const rotated=await link('rotate');
  await cdp.click(tab,button('retryCheckSharing','#owner-sharing-recovery '+sharing));await cdp.idle(tab);
  assert.equal(requests.at(-1),original);assert.equal((await row(tab)).pending,null);assert.equal((await row(tab)).snapshot.share.token,rotated.resultToken);
  check('startup attention and actual retry recover process loss without resurrecting an old link',()=>{});
  dropNext=true;await cdp.click(tab,button('revokeCheckShareWeb'));await dialog(tab);await cdp.click(tab,'#modal-ok-btn');await cdp.idle(tab);assert.ok((await row(tab)).pending);
  await write(state=>{state.checks.checks=[];});await cdp.idle(tab);await cdp.navigate(tab,base+'/');await cdp.click(tab,'#owner-sharing-attention button');
  assert.match(await cdp.evaluate(tab,"document.querySelector('#owner-sharing-recovery').textContent"),/Removed check/);
  await cdp.click(tab,button('reopenCheckSharing','#owner-sharing-recovery '+sharing));await cdp.idle(tab);dropPayload=null;
  await cdp.click(tab,button('retryCheckSharing','#owner-sharing-recovery '+sharing));await cdp.idle(tab);assert.equal((await row(tab)).pending,null);assert.equal((await row(tab)).snapshot.checkExists,false);
  check('removed check keeps recovery navigation and acknowledges its earlier revoke',()=>{});
  await write(state=>{state.checks.checks=structuredClone(initial.state.checks.checks);state.checks.checks[0].isCompleted=true;});await until(()=>cdp.evaluate(tab,"findCheck('dinner')?.isCompleted === true && !_reloading"),'Restored completed check');await cdp.click(tab,button('refreshCheckShareWeb'));await cdp.idle(tab);
  assert.equal(await cdp.evaluate(tab,`document.querySelector(${JSON.stringify(button('createCheckShareWeb'))}).disabled`),true);
  check('completed check cannot generate a new link',()=>{});
  await write(state=>{state.checks.checks[0].isCompleted=false;});await until(()=>cdp.evaluate(tab,"findCheck('dinner')?.isCompleted === false && !_reloading"),'Reopened check');await cdp.click(tab,button('refreshCheckShareWeb'));await cdp.idle(tab);await cdp.click(tab,button('createCheckShareWeb'));await cdp.idle(tab);
  await cdp.evaluate(tab,"(()=>{const sizes=Array.from(document.querySelectorAll('.owner-check-sharing *')).map(e=>[e,getComputedStyle(e).fontSize]);for(const [e,size]of sizes)e.style.fontSize=parseFloat(size)*2+'px';})()");await cdp.screenshot(tab,'owner-link-doubled-text-phone');
  assert.equal(await cdp.evaluate(tab,'document.documentElement.scrollWidth<=innerWidth+1'),true);
  check('owner sharing controls remain within the phone viewport with doubled rendered text',()=>{});
  const beforeCorruption=await row(tab);
  await cdp.evaluate(tab,"(async()=>{const client=ownerSharing.client('dinner');await client.store.transact(client.id,r=>{r.pending={payload:'unreadable saved request',rejection:null};return r;});})()");
  await cdp.navigate(tab,base+'/');await cdp.click(tab,'#owner-sharing-attention button');const beforeRequests=requests.length;
  await cdp.click(tab,button('reopenCheckSharing'));await cdp.idle(tab);
  assert.match(await cdp.evaluate(tab,"document.querySelector('#owner-sharing-recovery').textContent"),/original record is kept/);assert.equal(requests.length,beforeRequests);
  check('unreadable sharing state stays visible in recovery and cannot create a replacement action',()=>{});
  // Restore only this deliberately corrupted disposable fixture for later cases.
  await cdp.evaluate(tab,`(async()=>{const client=ownerSharing.client('dinner');await client.store.transact(client.id,()=>(${JSON.stringify(beforeCorruption)}));})()`);
  await cdp.click(tab,button('refreshCheckShareWeb'));await cdp.idle(tab);
  proxyUser='another-owner';await cdp.click(tab,button('createCheckShareWeb'));await cdp.idle(tab);
  assert.equal(await cdp.evaluate(tab,"document.querySelector('#app').hidden"),true);assert.equal(await cdp.evaluate(tab,'ownerSharing.scope'),null);
  assert.equal(await cdp.evaluate(tab,"document.querySelector('#connection-panel').hidden"),false);assert.match(await cdp.evaluate(tab,"document.querySelector('#connection-message').textContent"),/account changed/);
  assert.equal((await json('/api/share/check/dinner/sync/snapshot',undefined,{'remote-user':'another-owner'})).share,null);
  check('account change hides the old household and clears its visible sharing context',()=>{});
  await cdp.click(tab,'#retry-load');await until(()=>cdp.evaluate(tab,"typeof _loaded !== 'undefined' && _loaded && _currentUser === 'another-owner' && !_reloading"),'Explicit account reload');
  assert.equal(await cdp.evaluate(tab,"document.querySelector('#owner-sharing-attention').hidden"),true);assert.equal(await cdp.evaluate(tab,"findCheck('dinner') == null"),true);
  check('explicit reload opens the new account without exposing prior sharing records',()=>{});
  assert.equal(failures.length,0,failures.join('\n'));
  await fs.writeFile(path.join(output,'results.json'),JSON.stringify({passed:passes.length,checks:passes,browser:browserVersion,viewport:'390x844',runtimeErrors:failures,limitations:'Chrome desktop mobile emulation; doubled text is injected, not OS accessibility. Unrelated remote Chart.js/fonts blocked; trend charts not exercised.'},null,2)+'\n');
  console.log('All '+passes.length+' owner UI checks passed.');
}catch(error){if(cdp&&chrome?.exitCode===null){try{await fs.writeFile(path.join(output,'failure.txt'),String(error.stack)+'\n'+JSON.stringify({failures,body:await cdp.evaluate(cdp.last,'document.body.innerText.slice(0,4000)'),state:await cdp.evaluate(cdp.last,"({busy:ownerSharing.busy,message:ownerSharing.view('dinner').message,inert:document.querySelector('#app').inert,editing:isEditing(),focus:document.activeElement?.outerHTML.slice(0,500),pending:!!ownerSharing.view('dinner').row?.pending,protected:ownerSharing.view('dinner').row?.snapshot?.revisionPreconditionsRequired,buttons:[...document.querySelectorAll('.owner-check-sharing button')].map(b=>({text:b.textContent,disabled:b.disabled}))})")},null,2));}catch{}}throw error;}
finally{cdp?.socket.close();await stop(chrome,true);await stop(server);if(proxy){proxy.closeAllConnections();await new Promise(r=>proxy.close(r));}await fs.rm(temp,{recursive:true,force:true});}
console.log('Owned browser/server processes exited; proxy and disposable data cleaned up.');
