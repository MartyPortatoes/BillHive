/* Durable, account-scoped host reviews; one exact financial request at a time. */
(function(root,factory){
  const node=typeof module==='object'&&module.exports;
  const api=factory(node?require('./check-claim-client'):root.BillHiveCheckClaims,node?require('./check-owner-client'):root.BillHiveCheckOwner,
    node?require('./check-claim-review'):root.BillHiveCheckReview,node?require('./data-contract'):root.BHData);
  if(node)module.exports=api;else root.BillHiveCheckReviewClient=api;
})(globalThis,function(Shared,Owner,Review,Data){
  'use strict';
  const clone=structuredClone,same=(a,b)=>Shared.canonical(a)===Shared.canonical(b);
  const requireValue=(ok,message)=>{if(!ok)throw new Error(message);};
  const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
  const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
  const revision=v=>Number.isSafeInteger(v)&&v>=0;
  const rejections=['REVISION_CONFLICT','CHECK_SHARE_CONFLICT','PROTECTION_DISABLED'];
  const account=v=>({userId:v.userId,serverInstanceId:v.serverInstanceId,householdId:v.householdId});
  function ownerSnapshot(s,binding){
    requireValue(object(s)&&s.protocolVersion===1&&revision(s.revision)&&id(s.serverInstanceId)&&id(s.householdId)&&typeof s.userId==='string'&&s.userId.trim(),'Invalid household snapshot.');
    requireValue(!binding||same(account(s),account(binding)),'This review belongs to another account, server or household.');
    Data.state(s.state);Data.months(s.monthly);return s;
  }
  const checkIn=(owner,id)=>owner.state.checks?.checks.find(c=>c.id===id);
  function baseline(owner,sharing,capabilities){
    ownerSnapshot(owner);Owner.validateSnapshot(sharing,{...account(owner),checkId:sharing.checkId});
    requireValue(capabilities?.checkShareGuardProtocol===1&&capabilities.revisionPreconditionsRequired&&sharing.revisionPreconditionsRequired,'Use a server with protected guest split review.');
    requireValue(owner.revision===sharing.revision,'The household changed while loading guest selections. Refresh both before review.');
    const check=checkIn(owner,sharing.checkId);
    requireValue(check&&sharing.checkExists&&!check.isCompleted&&!sharing.isCompleted,'Reopen this check before applying guest selections.');
    const confirmed=Object.fromEntries(['protocolVersion','userId','serverInstanceId','householdId','revision','state','monthly'].map(key=>[key,clone(owner[key])]));
    return {owner:confirmed,checkId:sharing.checkId,guard:{checkId:sharing.checkId,shareId:sharing.share?.shareId??null,shareRevision:sharing.shareRevision},sources:Review.sources(sharing)};
  }
  function validateBaseline(b,binding){
    requireValue(object(b)&&id(b.checkId),'Invalid saved review baseline.');ownerSnapshot(b.owner,binding);
    const g=b.guard;requireValue(object(g)&&g.checkId===b.checkId&&revision(g.shareRevision)&&(g.shareId===null||/^[a-f0-9]{64}$/.test(g.shareId)),'Invalid saved sharing comparison.');
    requireValue(Array.isArray(b.sources)&&b.sources.every(s=>Review.validateSource(s)&&s.shareId===g.shareId)&&new Set(b.sources.map(Review.sourceId)).size===b.sources.length,'Invalid saved selections.');
    const check=checkIn(b.owner,b.checkId);requireValue(check&&!check.isCompleted,'Invalid saved check review.');Review.ledger(check);return b;
  }
  function preview(draft){const b=draft.baseline;return Review.preview(checkIn(b.owner,b.checkId),b.owner.state.settings?.currencyCode||'USD',b.sources,draft.plan,b.owner.state.people||[]);}
  const fingerprint=draft=>Shared.sha256(Shared.canonical(draft));
  function request(draft,mutationId,confirmation){
    const b=draft.baseline,proposal=Review.confirmed(preview(draft),confirmation),state=clone(b.owner.state);
    state.checks.checks=state.checks.checks.map(c=>c.id===b.checkId?proposal:c);
    return {serverInstanceId:b.owner.serverInstanceId,householdId:b.owner.householdId,baseRevision:b.owner.revision,mutationId,state,monthly:clone(b.owner.monthly),checkSharePreconditions:[clone(b.guard)]};
  }
  class Store extends Shared.IndexedStore {constructor(indexedDB=globalThis.indexedDB){super(indexedDB,'billhive-host-check-reviews-v1');}}
  class Transport extends Owner.Transport {
    constructor({binding,apiBase='/api',fetcher}){super({binding:{...binding,checkId:'review'},apiBase,fetcher});this.path=apiBase+'/';this.apiBase=apiBase;this.rejections=rejections;}
    async load(checkId){
      const health=await this.request('health');if(health.user!==this.binding.userId)throw Object.assign(new Error('Sign in to the original account to continue this review.'),{code:'REVIEW_ACCOUNT_CHANGED'});
      const owner=ownerSnapshot(await this.request('sync/snapshot'),this.binding);
      const sharing=await new Owner.Transport({binding:{...this.binding,checkId},apiBase:this.apiBase,fetcher:this.fetcher}).load();
      return {owner,sharing,capabilities:health.capabilities};
    }
    send(payload){return this.request('sync/commit',payload);}
  }
  class Client {
    constructor({owner,apiBase='/api',store=new Store(),transport,crypto=globalThis.crypto}){
      ownerSnapshot(owner);this.binding=account(owner);this.store=store;this.crypto=crypto;
      this.scope=Shared.sha256('host-check-review\0'+apiBase+'\0'+Shared.canonical(this.binding));this.row=null;
      this.transport=transport||new Transport({binding:this.binding,apiBase});
    }
    validate(row){
      try{
        requireValue(object(row)&&row.version===1&&row.scope===this.scope&&revision(row.generation)&&object(row.drafts),'Invalid record.');
        for(const [key,draft]of Object.entries(row.drafts)){
          requireValue(id(key)&&draft.baseline.checkId===key,'Invalid review identity.');validateBaseline(draft.baseline,this.binding);Review.validatePlan(draft.plan);
          requireValue(Array.isArray(draft.retainedSources),'Invalid retained selections.');draft.retainedSources.forEach(Review.validateSource);
        }
        if(row.pending){const p=row.pending,d=row.drafts[p.checkId];requireValue(d&&typeof p.payload==='string'&&p.reviewHash===fingerprint(d)&&typeof p.confirmPaymentResets==='boolean'&&(p.rejection===null||rejections.includes(p.rejection)),'Invalid pending review.');
          const r=JSON.parse(p.payload);requireValue(id(r.mutationId)&&r.mutationId.length>=16&&same(r,request(d,r.mutationId,p.confirmPaymentResets)),'Invalid prepared financial save.');}
        if(row.receipt){const r=row.receipt;requireValue(id(r.mutationId)&&id(r.checkId)&&revision(r.committedRevision)&&/^[a-f0-9]{64}$/.test(r.requestHash),'Invalid review acknowledgement.');ownerSnapshot(r.snapshot,this.binding);requireValue(r.snapshot.revision>=r.committedRevision,'Invalid acknowledged household.');}
        return row;
      }catch{throw new Error('Saved guest review could not be opened. Its original record is kept.');}
    }
    async open(){this.row=await this.store.transact(this.scope,saved=>saved===undefined?{version:1,scope:this.scope,generation:0,drafts:{},pending:null,receipt:null}:this.validate(saved));return clone(this.row);}
    async update(change){const expected=clone(this.row);requireValue(expected,'Open saved reviews first.');
      this.row=await this.store.transact(this.scope,saved=>{this.validate(saved);requireValue(same(saved,expected),'Guest review changed in another tab. Reopen its saved choices.');const next=change(clone(saved));next.generation++;return this.validate(next);});return clone(this.row);}
    async start(fresh){const b=baseline(fresh.owner,fresh.sharing,fresh.capabilities);ownerSnapshot(b.owner,this.binding);
      return this.update(row=>{requireValue(!row.pending,'Confirm the pending guest split save before starting another.');
        if(!row.drafts[b.checkId])row.drafts[b.checkId]={baseline:b,plan:Review.seed(checkIn(b.owner,b.checkId)),retainedSources:[]};return row;});}
    edit(checkId,plan){Review.validatePlan(plan);return this.update(row=>{requireValue(!row.pending,'Confirm the pending split save before changing choices.');requireValue(row.drafts[checkId],'Open this review first.');row.drafts[checkId].plan=clone(plan);return row;});}
    compare(checkId,fresh){const next=baseline(fresh.owner,fresh.sharing,fresh.capabilities);ownerSnapshot(next.owner,this.binding);requireValue(next.checkId===checkId,'The check changed.');
      const old=this.row.drafts[checkId]?.baseline;requireValue(old,'Open the saved review first.');
      requireValue(next.owner.revision>=old.owner.revision&&next.guard.shareRevision>=old.guard.shareRevision,'Review revisions moved backwards. Original choices are kept.');
      requireValue(next.owner.revision!==old.owner.revision||same(next.owner,old.owner),'The household changed without a new revision. Original choices are kept.');
      requireValue(next.guard.shareRevision!==old.guard.shareRevision||same(next.guard,old.guard)&&same(next.sources,old.sources),'Guest selections changed without a new revision. Original choices are kept.');
      return {changed:!same(old,next),next};}
    review(checkId,fresh,keep){const comparison=this.compare(checkId,fresh);return this.update(row=>{
      requireValue(!row.pending||row.pending.checkId===checkId&&row.pending.rejection,'Confirm the pending split save before reviewing newer data.');
      const old=row.drafts[checkId];requireValue(old,'Open this review first.');
      requireValue(comparison.next.owner.revision>=old.baseline.owner.revision&&comparison.next.guard.shareRevision>=old.baseline.guard.shareRevision,'Review revisions moved backwards. Original choices are kept.');
      const current=new Set(comparison.next.sources.map(Review.sourceId));
      const retained=keep?[...new Map([...old.retainedSources,...old.baseline.sources].filter(s=>!current.has(Review.sourceId(s))).map(s=>[Review.sourceId(s),s])).values()]:[];
      row.drafts[checkId]={baseline:comparison.next,plan:keep?old.plan:Review.seed(checkIn(comparison.next.owner,checkId)),retainedSources:retained};row.pending=null;return row;
    });}
    prepare(checkId,fresh,reviewed,confirmPaymentResets=false){const comparison=this.compare(checkId,fresh);return this.update(row=>{
      requireValue(!row.pending,'Resolve the pending financial save before applying this split.');const draft=row.drafts[checkId];
      requireValue(draft&&!comparison.changed,'The household or guest selections changed. Review the current values before applying this split.');
      requireValue(same(preview(draft),reviewed),'The proposed split changed. Review the totals again.');
      requireValue(this.crypto&&typeof this.crypto.getRandomValues==='function','Secure save identity is unavailable.');
      const mutationId='claim-apply-'+Array.from(this.crypto.getRandomValues(new Uint8Array(24)),v=>v.toString(16).padStart(2,'0')).join('');
      const payload=JSON.stringify(request(draft,mutationId,confirmPaymentResets));requireValue(new TextEncoder().encode(payload).length<=10*1024*1024,'This household exceeds the server save limit. Export your review before reducing it.');
      row.pending={checkId,payload,reviewHash:fingerprint(draft),confirmPaymentResets,rejection:null};return row;
    });}
    async submit(){
      const expected=clone(this.row);requireValue(expected?.pending&&!expected.pending.rejection,'There is no uncertain guest split save to retry.');
      const sent=await this.store.transact(this.scope,row=>{this.validate(row);requireValue(row.pending?.payload===expected.pending.payload&&!row.pending.rejection,'The original guest split request changed. Reopen the review.');return row;});this.row=clone(sent);
      let result;try{result=await this.transport.send(sent.pending.payload);}catch(error){
        if(rejections.includes(error.code))this.row=await this.store.transact(this.scope,row=>{this.validate(row);if(row.pending?.payload===sent.pending.payload){row.pending.rejection=error.code;row.generation++;}return this.validate(row);});throw error;
      }
      ownerSnapshot(result,this.binding);const r=JSON.parse(sent.pending.payload);
      requireValue(result.mutationId===r.mutationId&&typeof result.replayed==='boolean'&&revision(result.committedRevision)&&result.committedRevision>=r.baseRevision&&result.revision>=result.committedRevision&&
        (result.replayed||result.revision===result.committedRevision),'The save receipt does not match the reviewed split. Its original request is kept.');
      this.row=await this.store.transact(this.scope,row=>{
        this.validate(row);const requestHash=Shared.sha256(sent.pending.payload);
        if(!row.pending){requireValue(row.receipt?.requestHash===requestHash&&row.receipt.committedRevision===result.committedRevision,'This review is no longer awaiting confirmation.');return row;}
        requireValue(row.pending.payload===sent.pending.payload,'Another guest split request is pending.');
        const current=row.drafts[sent.pending.checkId];requireValue(current&&fingerprint(current)===sent.pending.reviewHash,'The saved review changed. Its original request is kept.');
        delete row.drafts[sent.pending.checkId];row.pending=null;row.receipt={mutationId:r.mutationId,requestHash,checkId:sent.pending.checkId,committedRevision:result.committedRevision,snapshot:clone(result)};row.generation++;return this.validate(row);
      });return clone(result);
    }
    discard(checkId){return this.update(row=>{requireValue(!row.pending||row.pending.checkId===checkId&&row.pending.rejection,'Retry the uncertain split save before discarding its review.');delete row.drafts[checkId];row.pending=null;return row;});}
    preview(checkId){const d=this.row?.drafts[checkId];requireValue(d,'Open this review first.');return preview(d);}
    recovery(checkId,workingPlan=null){const draft=this.row?.drafts[checkId];requireValue(draft,'Open this review first.');const b=draft.baseline,c=checkIn(b.owner,checkId),p=this.row.pending;
      if(workingPlan!==null)Review.validatePlan(workingPlan);
      // Whitelist review data. Whole household documents can carry legacy bearer tokens.
      const check={id:c.id,name:c.name,isCompleted:!!c.isCompleted,participants:c.participants.map(v=>({id:v.id,name:v.name,linkedPersonId:v.linkedPersonId??null})),
        items:c.items.map(v=>({id:v.id,name:v.name,price:v.price??0,sharedByParticipantIds:v.sharedByParticipantIds||[]})),claimApplications:c.claimApplications??null};
      for(const key of ['taxAmount','tipAmount','discountAmount','compAmount','serviceFeeAmount'])check[key]=c[key]??0;
      return JSON.stringify({format:'billhive-host-check-review-recovery',version:1,checkId,serverInstanceId:b.owner.serverInstanceId,householdId:b.owner.householdId,revision:b.owner.revision,
        currency:b.owner.state.settings?.currencyCode||'USD',guard:b.guard,check,sources:b.sources,retainedSources:draft.retainedSources,savedPlan:draft.plan,workingPlan,
        pending:p?.checkId===checkId?{mutationId:JSON.parse(p.payload).mutationId,requestHash:Shared.sha256(p.payload),rejection:p.rejection}:null},null,2);
    }
  }
  return {Client,Store,Transport,baseline,preview,ownerSnapshot};
});
