/* Account-scoped owner link actions. Guest declarations do not modify finances. */
(function(root,factory) {
  const api=factory(typeof module==='object'&&module.exports?require('./check-claim-client'):root.BillHiveCheckClaims);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.BillHiveCheckOwner=api;
})(globalThis,function(Shared) {
  'use strict';
  const clone=v=>v==null?v:JSON.parse(JSON.stringify(v));
  const same=(a,b)=>Shared.canonical(a)===Shared.canonical(b);
  const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
  const requireValue=(condition,message)=>{if(!condition)throw new Error(message);};
  const identifier=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v)&&!['__proto__','prototype','constructor'].includes(v);
  const revision=v=>Number.isSafeInteger(v)&&v>=0;
  const tokenPattern=/^[A-Za-z0-9_-]{16,128}$/;
  const keys=['userId','serverInstanceId','householdId','checkId'];
  const rejected=['SHARE_CONFLICT','CHECK_COMPLETED','CHECK_NOT_FOUND','PROTECTION_DISABLED'];
  function account(value) {
    requireValue(object(value)&&typeof value.userId==='string'&&value.userId.trim()&&identifier(value.serverInstanceId)&&identifier(value.householdId),'Load the signed-in household before opening sharing.');
    return {userId:value.userId,serverInstanceId:value.serverInstanceId,householdId:value.householdId};
  }
  function identity(a,b) {requireValue(keys.every(k=>a[k]===b[k]),'Sharing belongs to a different account, server, household or check. Existing records are kept.');}
  function publicURL(value,token) {
    if(value==null)return null;
    requireValue(typeof value==='string'&&token&&!/[%\\\u0000-\u0020]/.test(value),'Invalid public sharing address.');
    const url=new URL(value);
    const prefix=url.pathname.slice(0,-('/share/'+token).length);
    requireValue(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash&&
      url.pathname.endsWith('/share/'+token)&&(prefix===''||/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+$/.test(prefix)),'The public address does not match the current link.');
    return value;
  }
  function validateSnapshot(s,binding) {
    requireValue(object(s)&&s.protocolVersion===1&&revision(s.revision)&&revision(s.shareRevision)&&identifier(s.checkId)&&
      typeof s.checkExists==='boolean'&&typeof s.isCompleted==='boolean'&&typeof s.revisionPreconditionsRequired==='boolean','Invalid owner sharing snapshot.');
    account(s);if(binding)identity(s,binding);
    requireValue(s.checkExists||!s.isCompleted&&s.share===null,'A removed check cannot have an active link.');
    if(s.share!==null) {
      const share=s.share;
      requireValue(object(share)&&tokenPattern.test(share.token)&&share.shareId===Shared.sha256(share.token)&&revision(share.createdAt)&&s.shareRevision>0,'Invalid active check link.');
      requireValue(Array.isArray(share.claims)&&share.claims.length<=500&&share.claims.every(c=>object(c)&&typeof c.claimerName==='string'&&typeof c.claimedAt==='string'&&Array.isArray(c.itemIds)&&c.itemIds.every(identifier)&&
        (c.claimantId===undefined||/^[a-f0-9]{64}$/.test(c.claimantId))),'Invalid guest declarations.');
      const ids=share.claims.flatMap(c=>c.claimantId?[c.claimantId]:[]);requireValue(new Set(ids).size===ids.length,'Repeated guest identities.');
    }
    publicURL(s.shareUrl,s.share?.token);return s;
  }
  function following(next,old) {
    identity(next,old);
    requireValue(next.revision>=old.revision&&next.shareRevision>=old.shareRevision,'Sharing revisions moved backwards. Your saved action is kept.');
    requireValue(next.shareRevision!==old.shareRevision||same(next.share,old.share),'The link or declarations changed without a new sharing revision.');
    requireValue(next.revision!==old.revision||next.checkExists===old.checkExists&&next.isCompleted===old.isCompleted,'The check changed without a new household revision.');
  }
  function requestValue(payload,binding) {
    requireValue(typeof payload==='string','Invalid saved link request.');const r=JSON.parse(payload);
    requireValue(object(r)&&same(Object.keys(r).sort(),['serverInstanceId','householdId','checkId','baseRevision','baseShareRevision','mutationId','kind'].sort())&&
      ['serverInstanceId','householdId','checkId','mutationId'].every(k=>identifier(r[k]))&&r.mutationId.length>=16&&revision(r.baseRevision)&&revision(r.baseShareRevision)&&['create','rotate','revoke'].includes(r.kind),'Invalid saved link request.');
    identity({...r,userId:binding.userId},binding);return r;
  }
  function validateReceipt(value,payload,binding) {
    const r=requestValue(payload,binding);
    requireValue(object(value)&&value.protocolVersion===1&&typeof value.replayed==='boolean'&&revision(value.committedShareRevision),'Invalid owner link receipt.');
    identity(value,binding);
    requireValue(value.mutationId===r.mutationId&&value.committedShareRevision>=r.baseShareRevision&&
      (value.resultToken===null||typeof value.resultToken==='string'&&tokenPattern.test(value.resultToken))&&
      (value.resultToken===null)===(r.kind==='revoke'),'The link receipt does not match the saved action.');
    const s=validateSnapshot(value.snapshot,binding);
    requireValue(s.revision>=r.baseRevision&&s.shareRevision>=value.committedShareRevision,'The receipt snapshot is older than its result.');
    if(!value.replayed)requireValue(s.revisionPreconditionsRequired&&s.revision===r.baseRevision&&s.shareRevision===value.committedShareRevision&&
      (s.share?.token||null)===value.resultToken&&(r.kind!=='rotate'||value.committedShareRevision>r.baseShareRevision),'The current link does not confirm this action.');
    return value;
  }
  class Store extends Shared.IndexedStore {
    constructor(indexedDB=globalThis.indexedDB) {super(indexedDB,'billhive-owner-checks-v1');}
    async summaries(scope,select) {
      const db=await this.database();return new Promise((resolve,reject)=>{
        const tx=db.transaction('links','readonly'),result=[];
        tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(new Error('Saved sharing actions could not be listed. Existing records are kept.'));
        const request=tx.objectStore('links').openCursor();
        request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;
          if(typeof cursor.key==='string'&&cursor.key.startsWith(scope+':')) {
            const id=cursor.key.slice(scope.length+1);
            try{requireValue(identifier(id),'Invalid saved check identity');result.push(select(id,cursor.value));}
            catch{result.push({checkId:identifier(id)?id:null,error:'Saved sharing details could not be opened. The original record is kept.'});}
          }
          cursor.continue();
        };
      });
    }
  }
  class Transport {
    constructor({binding,apiBase='/api',fetcher=globalThis.fetch.bind(globalThis)}) {
      account(binding);requireValue(identifier(binding.checkId),'Invalid check identity.');
      requireValue(/^\/(?:[A-Za-z0-9._~-]+\/)*api$/.test(apiBase)&&!apiBase.split('/').some(v=>v==='.'||v==='..'),'Invalid server API path.');
      this.binding=clone(binding);this.path=apiBase+'/share/check/'+encodeURIComponent(binding.checkId)+'/sync/';this.fetcher=fetcher;this.rejections=rejected;
    }
    async request(path,payload) {
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
      try {
        const response=await this.fetcher(this.path+path,{method:payload===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,
          headers:{'X-BillHive-User':this.binding.userId,...(payload===undefined?{}:{'Content-Type':'application/json','X-BillHive-Require-Protection':'1'})},body:payload});
        const limit=response.ok?16*1024*1024:8192;
        if(Number(response.headers.get('content-length')||0)>limit){await response.body?.cancel();throw new Error('The sharing response is too large.');}
        requireValue(response.body,'The server returned an empty sharing response.');
        const reader=response.body.getReader(),chunks=[];let size=0;
        try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;requireValue(size<=limit,'The sharing response is too large.');chunks.push(value);}}
        catch(error){await reader.cancel();throw error;}
        const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
        let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Error('The sharing response was unreadable. Your saved action is kept.');}
        if(!response.ok) {
          const error=new Error(response.status===401?'Sign in to the same account before retrying this sharing action.':'The sharing action could not be confirmed. Your saved request is kept.');
          if([400,404,409,428].includes(response.status)&&this.rejections.includes(body?.code))error.code=body.code;throw error;
        }
        return body;
      }finally{clearTimeout(timer);}
    }
    load(){return this.request('snapshot');}
    send(payload){return this.request('commit',payload);}
  }
  class Client {
    constructor({owner,checkId,apiBase='/api',store=new Store(),transport,crypto=globalThis.crypto}) {
      this.owner=account(owner);requireValue(identifier(checkId),'Invalid check identity.');
      this.binding={...this.owner,checkId};this.apiBase=apiBase;
      this.scope=Shared.sha256('owner-check\0'+apiBase+'\0'+Shared.canonical(this.owner));this.id=this.scope+':'+checkId;
      this.store=store;this.crypto=crypto;this.transport=transport||new Transport({binding:this.binding,apiBase});this.row=null;
    }
    validate(row) {
      try { return this.validateRecord(row); }
      catch { throw new Error('Saved sharing details could not be opened. The original record is kept.'); }
    }
    validateRecord(row) {
      requireValue(object(row)&&row.version===1&&row.scope===this.scope&&row.checkId===this.binding.checkId&&revision(row.generation),'Saved sharing details could not be opened. The original record is kept.');
      if(row.snapshot)validateSnapshot(row.snapshot,this.binding);
      if(row.pending){const p=row.pending,r=requestValue(p.payload,this.binding);
        requireValue(row.snapshot&&r.baseRevision<=row.snapshot.revision&&r.baseShareRevision<=row.snapshot.shareRevision&&(p.rejection===null||rejected.includes(p.rejection)),'Invalid saved sharing action.');}
      if(row.receipt){const r=requestValue(row.receipt.payload,this.binding);requireValue(revision(row.receipt.committedShareRevision)&&row.receipt.committedShareRevision>=r.baseShareRevision&&typeof row.receipt.replayed==='boolean','Invalid saved sharing acknowledgement.');}
      return row;
    }
    async open() {this.row=await this.store.transact(this.id,saved=>saved===undefined?{version:1,scope:this.scope,checkId:this.binding.checkId,generation:0,snapshot:null,pending:null,receipt:null}:this.validate(saved));return clone(this.row);}
    async update(change) {
      const expected=clone(this.row);requireValue(expected,'Open the saved sharing action first.');
      this.row=await this.store.transact(this.id,saved=>{this.validate(saved);requireValue(same(saved,expected),'Sharing changed in another tab. Reopen it before continuing.');
        const next=change(clone(saved));next.generation=saved.generation+1;return this.validate(next);});return clone(this.row);
    }
    async refresh(owner) {
      requireValue(same(account(owner),this.owner)&&revision(owner.revision),'The loaded household identity changed. Reopen sharing in the original account.');
      const next=validateSnapshot(await this.transport.load(),this.binding);
      requireValue(next.revision===owner.revision,'The household changed while loading sharing. Refresh the household and review again.');
      return this.update(row=>{if(row.snapshot)following(next,row.snapshot);row.snapshot=clone(next);return row;});
    }
    async prepare(kind,reviewed,owner) {
      return this.update(row=>{
        requireValue(!row.pending,'Resolve the saved sharing action before starting another.');
        const s=row.snapshot;requireValue(s&&same(s,reviewed),'Sharing changed. Review the current link before continuing.');
        requireValue(same(account(owner),this.owner)&&owner.revision===s.revision,'The household changed. Refresh sharing before continuing.');
        requireValue(s.revisionPreconditionsRequired,'Enable protected sharing before changing links.');
        requireValue(['create','rotate','revoke'].includes(kind)&&(kind==='revoke'||s.checkExists&&!s.isCompleted),'Reopen this check before creating or replacing a link.');
        requireValue(this.crypto&&typeof this.crypto.getRandomValues==='function','Secure request identity is unavailable in this browser.');
        const id=Array.from(this.crypto.getRandomValues(new Uint8Array(24)),n=>n.toString(16).padStart(2,'0')).join('');
        const r={serverInstanceId:s.serverInstanceId,householdId:s.householdId,checkId:s.checkId,baseRevision:s.revision,baseShareRevision:s.shareRevision,mutationId:'link-'+id,kind};
        row.pending={payload:JSON.stringify(r),rejection:null};return row;
      });
    }
    async submit() {
      const expected=clone(this.row);requireValue(expected?.pending&&!expected.pending.rejection,'There is no uncertain link action to retry.');
      const sent=await this.store.transact(this.id,row=>{this.validate(row);requireValue(row.pending?.payload===expected.pending.payload&&!row.pending.rejection,'The saved link action changed. Reopen it before retrying.');return row;});
      this.row=clone(sent);let receipt;
      try{receipt=await this.transport.send(sent.pending.payload);}catch(error){
        if(rejected.includes(error.code))this.row=await this.store.transact(this.id,row=>{this.validate(row);if(row.pending?.payload!==sent.pending.payload)return row;row.pending.rejection=error.code;row.generation++;return this.validate(row);});
        throw error;
      }
      validateReceipt(receipt,sent.pending.payload,this.binding);
      this.row=await this.store.transact(this.id,row=>{
        this.validate(row);
        if(!row.pending){requireValue(row.receipt?.payload===sent.pending.payload&&row.receipt.committedShareRevision===receipt.committedShareRevision,'This sharing action is no longer awaiting confirmation.');return row;}
        requireValue(row.pending.payload===sent.pending.payload,'A different sharing action is pending. Its request is kept.');
        const next=receipt.snapshot,old=row.snapshot;
        if(next.revision>=old.revision&&next.shareRevision>=old.shareRevision){following(next,old);
          if(next.revision>old.revision||next.shareRevision>old.shareRevision||row.generation===sent.generation)row.snapshot=clone(next);
        }else{requireValue(next.revision<=old.revision&&next.shareRevision<=old.shareRevision,'The sharing revision streams disagree. Keep the original request.');following(old,next);}
        row.receipt={payload:sent.pending.payload,committedShareRevision:receipt.committedShareRevision,replayed:receipt.replayed};row.pending=null;row.generation++;return this.validate(row);
      });return clone(receipt);
    }
    dismissRejected(){return this.update(row=>{requireValue(row.pending?.rejection,'Retry an uncertain action before clearing it.');row.pending=null;return row;});}
    async forgetRemoved(receipt){
      requireValue(same(account(receipt),this.owner)&&receipt.checkId===this.binding.checkId&&receipt.checkAbsent===true&&revision(receipt.committedRevision)&&revision(receipt.revision)&&receipt.revision>=receipt.committedRevision,'Invalid confirmed deletion.');
      this.row=await this.store.transact(this.id,row=>{this.validate(row);
        // Recovery intent, unreadable records and newer restored links are never
        // cleared by an older financial receipt. Repeating cleanup is harmless.
        if(row.pending||!row.snapshot||row.snapshot.revision>receipt.committedRevision)return row;
        row.snapshot=null;row.receipt=null;row.generation++;return this.validate(row);
      });return clone(this.row);
    }
    recovery(){const r=this.row,s=r?.snapshot;return JSON.stringify({format:'billhive-owner-check-sharing-recovery',version:1,checkId:this.binding.checkId,
      serverInstanceId:this.owner.serverInstanceId,householdId:this.owner.householdId,revision:s?.revision,shareRevision:s?.shareRevision,checkExists:s?.checkExists,linkActive:!!s?.share,
      pendingRequest:r?.pending?JSON.parse(r.pending.payload):null,pendingRejection:r?.pending?.rejection||null,receipt:r?.receipt||null},null,2);}
    list(){return this.store.summaries(this.scope,(id,value)=>{const client=new Client({owner:this.owner,checkId:id,apiBase:this.apiBase,store:this.store,transport:this.transport});client.validate(value);
      return {checkId:id,hasLink:!!value.snapshot?.share,pendingKind:value.pending?JSON.parse(value.pending.payload).kind:null,rejected:!!value.pending?.rejection};});}
  }
  return {Client,Store,Transport,validateSnapshot,validateReceipt,following,publicURL};
});
