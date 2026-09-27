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
const output=path.resolve(process.env.CLAIM_EVIDENCE_DIR||path.join(root,'docs/evidence/browser-check-claims'));
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'billhive-browser-claims-'));
let server,chrome,proxy,cdp,base,upstream,browserVersion,dropNext=false,dropPayload=null,requests=[],failures=[],passes=[],dialogs=[];
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
    const tab={id:targetId,session:sessionId};await this.send('Runtime.enable',{},sessionId);await this.send('Page.enable',{},sessionId);await this.send('Log.enable',{},sessionId);
    await this.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},sessionId);
    await this.navigate(tab,url);return tab;}
  async evaluate(tab,expression){const result=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},tab.session);if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;}
  async navigate(tab,url){const mark=crypto.randomUUID();await this.evaluate(tab,'window.__navigationProbe='+JSON.stringify(mark));await this.send('Page.navigate',{url},tab.session);
    await until(async()=>{try{return await this.evaluate(tab,`window.__navigationProbe !== ${JSON.stringify(mark)} && !!document.querySelector('#confirmBtn') && document.querySelector('#confirmBtn').textContent !== 'Working…' && document.querySelector('#confirmBtn').textContent !== 'Loading…'`);}catch(error){if(/context.*destroyed|Cannot find context/i.test(error.message))return false;throw error;}},'Claim page initialization');}
  async click(tab,selector){const box=await this.evaluate(tab,`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Unavailable control: '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
    await this.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box},tab.session);await this.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box},tab.session);}
  async name(tab,value){await this.evaluate(tab,`(()=>{const e=document.querySelector('#nameInput');e.scrollIntoView({block:'center'});e.focus();e.select();})()`);await this.send('Input.insertText',{text:value},tab.session);await this.idle(tab);}
  async idle(tab){await until(()=>this.evaluate(tab,"document.querySelector('#confirmBtn').textContent !== 'Working…' && !document.querySelector('#message').textContent.includes('Saving your selection')"),'Claim action completion');}
  async screenshot(tab,name){await this.evaluate(tab,"(async()=>{window.scrollTo(0,0);await new Promise(requestAnimationFrame);await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));})()");const r=await this.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},tab.session);await fs.writeFile(path.join(output,name+'.png'),Buffer.from(r.data,'base64'));}
}
async function recoveryExport(tab,label){
  const folder=path.join(temp,'downloads',label);await fs.mkdir(folder,{recursive:true});
  await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:folder});await cdp.click(tab,'#export');
  return until(async()=>{try{return JSON.parse(await fs.readFile(path.join(folder,'check-selection-recovery.json'),'utf8'));}catch{return null;}},'Recovery download');
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
async function fixture(){
  const headers={'remote-user':'browser-owner-'+crypto.randomUUID()};const household=()=>json('/api/sync/snapshot',undefined,headers);
  let state={settings:{currencyCode:'EUR'},checks:{checks:[{id:'dinner',name:'Dinner with a long descriptive title <img src=x onerror="window.injected=true">',dateISO:'2026-09-27',isCompleted:false,
    items:[{id:'soup',name:'Soup <script>window.injected=true</script>',price:12},{id:'bread',name:'Bread',price:3}],participants:[],taxAmount:1,tipAmount:2,discountAmount:0,compAmount:0,serviceFeeAmount:3}]}};
  const write=async()=>{const s=await household();return json('/api/sync/commit',{serverInstanceId:s.serverInstanceId,householdId:s.householdId,baseRevision:s.revision,mutationId:crypto.randomUUID(),state,monthly:{}},headers);};await write();
  const owner=()=>json('/api/share/check/dinner/sync/snapshot',undefined,headers);
  const link=async kind=>{const s=await owner();return json('/api/share/check/dinner/sync/commit',{serverInstanceId:s.serverInstanceId,householdId:s.householdId,checkId:s.checkId,baseRevision:s.revision,baseShareRevision:s.shareRevision,mutationId:crypto.randomUUID(),kind},{...headers,'X-BillHive-Require-Protection':'1'});};
  const created=await link('create'),token=created.resultToken;
  const publicRead=()=>json('/public/share/check/'+token+'/sync/snapshot');
  const guest=async()=>{const s=await publicRead(),key=crypto.randomBytes(32).toString('hex');return json('/public/share/check/'+token+'/sync/claim',
    {serverInstanceId:s.serverInstanceId,householdId:s.householdId,checkId:s.checkId,shareId:s.shareId,claimantId:crypto.createHash('sha256').update('check-claimant\0'+token+'\0'+key).digest('hex'),baseRevision:s.revision,baseShareRevision:s.shareRevision,mutationId:crypto.randomUUID(),claim:{claimerName:'Alex',itemIds:['bread']}},
    {'X-BillHive-Claimant-Key':key,'X-BillHive-Require-Protection':'1'});};
  return {state,write,link,token,publicRead,guest,household,url:base+'/hive/share/'+token+'/'};
}
const saved=tab=>cdp.evaluate(tab,`(async()=>{const path=location.pathname.match(/^(.*?)\\/share\\/([A-Za-z0-9_-]+)\\/?$/);const client=new BillHiveCheckClaims.Client({token:path[2],prefix:path[1]});await client.open();return {generation:client.row.generation,claimantId:client.row.claimantId,draft:client.row.draft,pending:client.row.pending,access:client.row.access,snapshot:client.row.snapshot};})()`);
try {
  await fs.mkdir(output,{recursive:true});const serverPort=await port();upstream='http://127.0.0.1:'+serverPort;
  server=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:String(serverPort),DB_PATH:path.join(temp,'server.db'),TRUSTED_AUTH_HEADERS:'remote-user',TRUST_PROXY:'loopback',SYNC_REQUIRE_PRECONDITIONS:'1'},stdio:['ignore','pipe','pipe']});
  let serverOutput='';server.stdout.on('data',c=>serverOutput+=c);server.stderr.on('data',c=>serverOutput+=c);
  await until(()=>serverOutput.includes('running on'),'Fixture server');
  proxy=http.createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
    const body=Buffer.concat(chunks),route=req.url.replace(/^\/hive(?=\/)/,'');const claim=req.method==='POST'&&route.endsWith('/sync/claim');
    if(claim)requests.push({body:body.toString(),key:req.headers['x-billhive-claimant-key']});
    // Chrome can transparently retry a disconnected POST. Lose every response
    // for this exact mutation until the scenario explicitly restores the link.
    const drop=claim&&(dropNext||dropPayload===body.toString());if(drop){dropNext=false;dropPayload=body.toString();}
    const forward=http.request(upstream+route,{method:req.method,headers:{...req.headers,host:'127.0.0.1:'+serverPort,'x-forwarded-for':'192.0.2.123'}},response=>{
      if(drop){response.resume();response.once('end',()=>res.destroy());}
      else{res.writeHead(response.statusCode,response.headers);response.pipe(res);}
    });forward.on('error',()=>res.destroy());forward.end(body);
  });});await new Promise(r=>proxy.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+proxy.address().port;
  const f=await fixture();await f.guest();await launchChrome();let tab=await cdp.tab(f.url);
  check('prefixed trailing-slash page loads under shipped CSP; names are escaped and currency is EUR',()=>assert.equal(failures.length,0));
  check('same-name visitor is not mistaken for an existing guest',()=>{});
  assert.deepEqual(await cdp.evaluate(tab,"({name:document.querySelector('#nameInput').value,disabled:document.querySelector('#confirmBtn').disabled,injected:!!window.injected,euro:document.querySelector('#items').textContent.includes('€')})"),{name:'',disabled:true,injected:false,euro:true});
  assert.equal(await cdp.evaluate(tab,"document.querySelector('#check-date').textContent"),'9/27/2026');
  await cdp.name(tab,'Alex');await cdp.click(tab,'[data-item="soup"]');await cdp.idle(tab);
  assert.deepEqual((await saved(tab)).draft.itemIds,['soup']);await cdp.screenshot(tab,'selection-phone');
  await cdp.click(tab,'#confirmBtn');await cdp.idle(tab);
  assert.equal((await saved(tab)).pending,null);assert.equal((await f.publicRead()).claims.length,2,JSON.stringify(await cdp.evaluate(tab,"({message:document.querySelector('#message').textContent,button:document.querySelector('#confirmBtn').outerHTML,dock:document.querySelector('.action-dock').getBoundingClientRect().toJSON(),height:innerHeight,width:innerWidth,scroll:document.documentElement.scrollWidth})")));
  check('real browser selection creates a distinct same-name declaration on the strict server',()=>assert.equal((requests.length),1));
  await cdp.click(tab,'#clear');await cdp.idle(tab);await cdp.click(tab,'#confirmBtn');await cdp.idle(tab);
  const own=(await saved(tab)).claimantId;const withdrawn=(await f.publicRead()).claims;
  check('empty selection withdraws only this browser guest',()=>{assert.deepEqual(withdrawn.find(c=>c.claimantId===own).itemIds,[]);assert.deepEqual(withdrawn.find(c=>c.claimantId!==own).itemIds,['bread']);});
  await cdp.click(tab,'[data-item="soup"]');await cdp.idle(tab);await cdp.navigate(tab,f.url);
  check('raw draft and selected items survive full page reload',()=>{});assert.equal(await cdp.evaluate(tab,"document.querySelector('[data-item=soup]').checked"),true);
  const other=await cdp.tab(f.url);await cdp.name(tab,'Unsaved in older tab');
  assert.match(await cdp.evaluate(tab,"document.querySelector('#message').textContent"),/another tab/);
  assert.equal(await cdp.evaluate(tab,"document.querySelector('#nameInput').value"),'Unsaved in older tab');
  check('concurrent tab conflict keeps unsaved input and blocks sending',()=>{});assert.equal(await cdp.evaluate(tab,"document.querySelector('#confirmBtn').disabled"),true);
  await cdp.send('Target.closeTarget',{targetId:tab.id});tab=other;
  f.state.checks.checks[0].items=f.state.checks.checks[0].items.filter(i=>i.id!=='soup');await f.write();
  await cdp.click(tab,'#refresh');await cdp.idle(tab);
  assert.equal(await cdp.evaluate(tab,"document.querySelector('#comparison').hidden"),false);
  assert.equal(await cdp.evaluate(tab,"document.querySelector('[data-item=soup]').checked"),true);
  assert.equal(await cdp.evaluate(tab,"document.querySelector('#confirmBtn').disabled"),true);await cdp.screenshot(tab,'removed-item-review-phone');
  await cdp.click(tab,'[data-item="soup"]');await cdp.idle(tab);await cdp.click(tab,'[data-item="bread"]');await cdp.idle(tab);await cdp.click(tab,'#confirmBtn');await cdp.idle(tab);
  check('removed selected item remains explicit until unchecked and comparison accepted',()=>{});assert.equal(await cdp.evaluate(tab,"document.querySelector('#comparison').hidden"),true);
  await cdp.evaluate(tab,"(()=>{const sizes=Array.from(document.querySelectorAll('body *')).map(e=>[e,getComputedStyle(e).fontSize]);for(const [e,size]of sizes)e.style.fontSize=(parseFloat(size)*2)+'px';})()");
  await cdp.screenshot(tab,'selection-phone-doubled-text');
  const geometry=await cdp.evaluate(tab,"(()=>{const b=document.querySelector('#confirmBtn').getBoundingClientRect();return {width:innerWidth,scroll:document.documentElement.scrollWidth,bottom:b.bottom,top:b.top,height:innerHeight};})()");
  assert.ok(geometry.scroll<=geometry.width+1,JSON.stringify(geometry));assert.ok(geometry.bottom<=geometry.height&&geometry.top>=0,JSON.stringify(geometry));
  check('phone layout retains visible primary action with doubled rendered text',()=>{});
  dropNext=true;await cdp.click(tab,'#confirmBtn');await cdp.idle(tab);const lost=await saved(tab);
  assert.ok(lost.pending&&!lost.pending.rejection,JSON.stringify({pending:lost.pending,draft:lost.draft,requests:requests.length,dropNext,page:await cdp.evaluate(tab,"({message:document.querySelector('#message').textContent,button:document.querySelector('#confirmBtn').textContent,height:innerHeight,width:innerWidth,dock:document.querySelector('.action-dock').getBoundingClientRect().toJSON()})")}));assert.equal(await cdp.evaluate(tab,"document.querySelector('#nameInput').disabled"),true);
  await cdp.screenshot(tab,'pending-retry-phone');const original=requests.at(-1);
  const pendingExport=await recoveryExport(tab,'pending');
  assert.deepEqual(pendingExport.pendingRequest,JSON.parse(original.body));assert.equal(JSON.stringify(pendingExport).includes(original.key),false);assert.equal(JSON.stringify(pendingExport).includes(f.token),false);
  check('downloaded pending recovery includes original intent without credentials or link token',()=>{});
  cdp.socket.close();await stop(chrome,true);chrome=null;dropPayload=null;await launchChrome();tab=await cdp.tab(f.url);
  assert.equal((await saved(tab)).pending.payload,lost.pending.payload);
  await f.guest();f.state.settings.unrelated='changed';await f.write();
  await cdp.click(tab,'#confirmBtn');await cdp.idle(tab);
  check('real Chrome process loss retries identical request and keeps newer server selections',()=>assert.deepEqual(requests.at(-1),original));
  assert.equal((await saved(tab)).pending,null);assert.equal((await f.publicRead()).claims.length,3);
  await cdp.click(tab,'#clear');await cdp.idle(tab);dropNext=true;await cdp.click(tab,'#confirmBtn');await cdp.idle(tab);
  assert.ok((await saved(tab)).pending);await f.link('revoke');await cdp.click(tab,'#refresh');await cdp.idle(tab);
  assert.equal((await saved(tab)).access,'revoked');dropPayload=null;await cdp.click(tab,'#confirmBtn');await cdp.idle(tab);
  check('receipt-only replay acknowledges a committed withdrawal after link revocation',()=>{});
  assert.equal((await saved(tab)).pending,null);assert.equal((await saved(tab)).access,'revoked');assert.equal(await cdp.evaluate(tab,"document.querySelector('#nameInput').disabled"),true);
  assert.equal(await cdp.evaluate(tab,"document.querySelectorAll('input[data-item]:checked').length"),0);
  await cdp.screenshot(tab,'revoked-recovery-phone');
  // Exercise the production IndexedDB adapter's transaction rollback independently
  // of protocol simulation, then provoke its real DOMException failure in the UI.
  const g=await fixture();tab=await cdp.tab(g.url);await cdp.name(tab,'Saved draft');
  assert.equal(await cdp.evaluate(tab,`(async()=>{const store=new BillHiveCheckClaims.IndexedStore(indexedDB,'rollback-probe');await store.transact('a',()=>({name:'kept'}));try{await store.transact('a',v=>{v.name='lost';throw Error('abort');});}catch{}return (await store.transact('a',v=>v)).name;})()`),'kept');
  check('real IndexedDB transaction abort leaves the prior record intact',()=>{});
  await cdp.evaluate(tab,"IDBObjectStore.prototype.put=function(){throw new DOMException('Synthetic quota exceeded','QuotaExceededError');}");
  await cdp.name(tab,'Unsaved after quota failure');assert.equal(await cdp.evaluate(tab,"document.querySelector('#nameInput').value"),'Unsaved after quota failure');
  assert.equal(await cdp.evaluate(tab,"document.querySelector('#confirmBtn').disabled"),true);assert.equal(await cdp.evaluate(tab,"document.querySelector('#export').disabled"),false);
  const rawExport=await recoveryExport(tab,'unsaved');assert.equal(rawExport.working.name,'Unsaved after quota failure');assert.equal(rawExport.draft.name,'Saved draft');assert.equal(JSON.stringify(rawExport).includes(g.token),false);
  check('storage failure preserves visible raw input and recovery export without sending',()=>{});
  await cdp.screenshot(tab,'storage-failure-phone');
  await cdp.navigate(tab,g.url);assert.equal(await cdp.evaluate(tab,"document.querySelector('#nameInput').value"),'Saved draft');
  assert.ok(dialogs.includes('beforeunload'));
  check('leaving unsaved input requires a browser warning; reload keeps the earlier durable draft',()=>{});
  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]},tab.session);
  await cdp.screenshot(tab,'selection-phone-light');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1024,height:768,deviceScaleFactor:1,mobile:false},tab.session);
  await cdp.screenshot(tab,'selection-tablet-light');
  assert.equal(await cdp.evaluate(tab,'document.documentElement.scrollWidth<=innerWidth'),true);
  check('light phone and tablet layouts fit the viewport',()=>{});
  await cdp.evaluate(tab,"document.querySelector('[data-item=soup]').focus()");
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32},tab.session);
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32},tab.session);await cdp.idle(tab);
  assert.deepEqual((await saved(tab)).draft.itemIds,['soup']);
  const tree=await cdp.send('Accessibility.getFullAXTree',{},tab.session);
  assert.ok(tree.nodes.some(n=>n.role?.value==='checkbox'&&n.name?.value.includes('Soup')));
  assert.ok(tree.nodes.some(n=>n.role?.value==='textbox'&&n.name?.value==='Your name'));
  check('keyboard selection and accessibility names use native labeled controls',()=>{});
  g.state.checks.checks[0].isCompleted=true;await g.write();await cdp.click(tab,'#refresh');await cdp.idle(tab);
  assert.equal(await cdp.evaluate(tab,"document.querySelector('#nameInput').disabled"),true);assert.equal(await cdp.evaluate(tab,"document.querySelector('#confirmBtn').disabled"),true);assert.deepEqual((await saved(tab)).draft.itemIds,['soup']);
  check('completed check becomes read-only while keeping its unfinished selection',()=>{});
  assert.equal(failures.length,0,failures.join('\n'));
  await fs.writeFile(path.join(output,'results.json'),JSON.stringify({passed:passes.length,checks:passes,browser:browserVersion+' headless, isolated persistent profile',viewport:'390x844 phone; 1024x768 tablet',processLoss:'SIGKILL of owned Chrome process group; profile reopened',limits:'Doubled rendered text is injected for layout coverage, not an OS accessibility or physical-device certification.',runtimeErrors:failures},null,2)+'\n');
  console.log('All '+passes.length+' browser checks passed. Evidence: '+output);
} finally {
  cdp?.socket.close();await stop(chrome,true);await stop(server);if(proxy){proxy.closeAllConnections();await new Promise(r=>proxy.close(r));}
  await fs.rm(temp,{recursive:true,force:true});
}
console.log('Owned Chrome/server processes exited; proxy closed; disposable profile, database and downloads removed.');
