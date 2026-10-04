'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const net=require('node:net');

test('the Dockerfile COPY set contains the real server runtime modules and serves protected reset from a staged tree',async()=>{
 const source=path.join(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'selfhive-docker-copy-'));
 let child;
 try {
  // This verifies the packaging closure using the local Node/native dependency
  // runtime. It is intentionally not a Docker or Alpine compatibility claim.
  for(const line of fs.readFileSync(path.join(source,'Dockerfile'),'utf8').split('\n')) {
   if(!line.startsWith('COPY '))continue;
   const parts=line.slice(5).trim().split(/\s+/),destination=parts.pop();
   if(destination.startsWith('/'))continue;
   const target=path.resolve(dir,destination);assert.ok(target===dir || target.startsWith(dir+path.sep));fs.mkdirSync(target,{recursive:true});
   for(const input of parts) {
    const from=path.join(source,input);
    fs.cpSync(from,fs.statSync(from).isDirectory()?target:path.join(target,path.basename(input)),{recursive:true});
   }
  }
  fs.symlinkSync(path.join(source,'node_modules'),path.join(dir,'node_modules'));
  const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  let output='';child=spawn(process.execPath,['server.js'],{cwd:dir,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DB_PATH:path.join(dir,'data','test.db'),TRUST_PROXY:'0',SYNC_REQUIRE_PRECONDITIONS:'1',TRUSTED_AUTH_HEADERS:''},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',s=>{output+=s});child.stderr.on('data',s=>{output+=s});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(output || 'Staged runtime did not start')),10000);child.stdout.on('data',s=>{if(String(s).includes('running on')){clearTimeout(timer);resolve();}});child.on('exit',code=>{clearTimeout(timer);reject(new Error(`Staged runtime exit ${code}: ${output}`));});});
  const base=`http://127.0.0.1:${port}`;
  const health=await fetch(base+'/api/health');assert.equal(health.status,200);assert.equal((await health.json()).capabilities.householdResetProtocol,1);
  const preview=await fetch(base+'/api/sync/reset/preview');assert.equal(preview.status,200);assert.equal((await preview.json()).householdReset.summary.stateKeys,0);
  const home=await fetch(base+'/');assert.equal(home.status,200);assert.match(await home.text(),/BillHive/);
 } finally {
  if(child?.exitCode==null){child.kill();await new Promise(r=>child.once('exit',r));}
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
