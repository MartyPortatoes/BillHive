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
  function baseline(owner,sharing,capabilities,{removal=false}={}){
    ownerSnapshot(owner);Owner.validateSnapshot(sharing,{...account(owner),checkId:sharing.checkId});
    requireValue(capabilities?.checkShareGuardProtocol===1&&capabilities.revisionPreconditionsRequired&&sharing.revisionPreconditionsRequired,'Use a server with protected guest split review.');
    requireValue(owner.revision===sharing.revision,'The household changed while loading guest selections. Refresh both before review.');
    const check=checkIn(owner,sharing.checkId);
    if(removal)requireValue(!!check===sharing.checkExists&&(!check||!!check.isCompleted===sharing.isCompleted),'The check changed while loading its sharing state.');
    else requireValue(check&&sharing.checkExists&&!check.isCompleted&&!sharing.isCompleted,'Reopen this check before applying guest selections.');
    const confirmed=Object.fromEntries(['protocolVersion','userId','serverInstanceId','householdId','revision','state','monthly'].map(key=>[key,clone(owner[key])]));
    return {owner:confirmed,checkId:sharing.checkId,guard:{checkId:sharing.checkId,shareId:sharing.share?.shareId??null,shareRevision:sharing.shareRevision},sources:Review.sources(sharing)};
  }
  function validateBaseline(b,binding,{removal=false}={}){
    requireValue(object(b)&&id(b.checkId),'Invalid saved review baseline.');ownerSnapshot(b.owner,binding);
    const g=b.guard;requireValue(object(g)&&g.checkId===b.checkId&&revision(g.shareRevision)&&(g.shareId===null||/^[a-f0-9]{64}$/.test(g.shareId)),'Invalid saved sharing comparison.');
    requireValue(Array.isArray(b.sources)&&b.sources.every(s=>Review.validateSource(s)&&s.shareId===g.shareId)&&new Set(b.sources.map(Review.sourceId)).size===b.sources.length,'Invalid saved selections.');
    const check=checkIn(b.owner,b.checkId);requireValue(check&&(removal||!check.isCompleted),'Invalid saved check review.');if(!removal)Review.ledger(check);return b;
  }
  function preview(draft){const b=draft.baseline;return Review.preview(checkIn(b.owner,b.checkId),b.owner.state.settings?.currencyCode||'USD',b.sources,draft.plan,b.owner.state.people||[]);}
  const fingerprint=draft=>Shared.sha256(Shared.canonical(draft));
  function request(draft,mutationId,confirmation){
    const b=draft.baseline,proposal=Review.confirmed(preview(draft),confirmation),state=clone(b.owner.state);
    state.checks.checks=state.checks.checks.map(c=>c.id===b.checkId?proposal:c);
    return {serverInstanceId:b.owner.serverInstanceId,householdId:b.owner.householdId,baseRevision:b.owner.revision,mutationId,state,monthly:clone(b.owner.monthly),checkSharePreconditions:[clone(b.guard)]};
  }
  const removalBaseline=fresh=>baseline(fresh.owner,fresh.sharing,fresh.capabilities,{removal:true});
  function compareRemoval(old,next){
    requireValue(next.checkId===old.checkId&&same(account(next.owner),account(old.owner)),'The deletion household changed.');
    requireValue(next.owner.revision>=old.owner.revision&&next.guard.shareRevision>=old.guard.shareRevision,'Deletion review revisions moved backwards. The original review is kept.');
    requireValue(next.owner.revision!==old.owner.revision||same(next.owner,old.owner),'The household changed without a new revision.');
    requireValue(next.guard.shareRevision!==old.guard.shareRevision||same(next.guard,old.guard)&&same(next.sources,old.sources),'Guest selections changed without a new revision.');
    const current=checkIn(next.owner,next.checkId);
    return {next,missing:!current,changed:!current||!same(checkIn(old.owner,old.checkId),current)||
      (old.owner.state.settings?.currencyCode||'USD')!==(next.owner.state.settings?.currencyCode||'USD')||!same(old.guard,next.guard)||!same(old.sources,next.sources)};
  }
  function removalRequest(draft,mutationId){
    requireValue(draft.confirmed,'Confirm the reviewed deletion before saving.');const b=draft.baseline,state=clone(b.owner.state);
    state.checks.checks=state.checks.checks.filter(c=>c.id!==b.checkId);
    return {serverInstanceId:b.owner.serverInstanceId,householdId:b.owner.householdId,baseRevision:b.owner.revision,mutationId,state,monthly:clone(b.owner.monthly),checkSharePreconditions:[clone(b.guard)]};
  }
  const pendingDraft=(row,p)=>p.kind==='removal'?row.removals?.[p.checkId]:row.drafts[p.checkId];
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
        if(row.removals!==undefined){requireValue(object(row.removals),'Invalid saved deletions.');for(const [key,draft]of Object.entries(row.removals)){
          requireValue(id(key)&&draft.baseline.checkId===key&&typeof draft.confirmed==='boolean','Invalid deletion review identity.');validateBaseline(draft.baseline,this.binding,{removal:true});
        }}
        if(row.removedSharing!==undefined){requireValue(object(row.removedSharing),'Invalid sharing cleanup journal.');for(const [key,proof]of Object.entries(row.removedSharing)){
          requireValue(id(key)&&proof.checkId===key&&same(account(proof),this.binding)&&revision(proof.revision)&&revision(proof.committedRevision)&&proof.revision>=proof.committedRevision&&proof.checkAbsent===true,'Invalid confirmed sharing cleanup.');
        }}
        if(row.pending){const p=row.pending,d=pendingDraft(row,p);requireValue((p.kind===undefined||p.kind==='removal')&&d&&typeof p.payload==='string'&&p.reviewHash===fingerprint(d)&&typeof p.confirmPaymentResets==='boolean'&&(p.rejection===null||rejections.includes(p.rejection)),'Invalid pending review.');
          const r=JSON.parse(p.payload);requireValue(id(r.mutationId)&&r.mutationId.length>=16&&same(r,p.kind==='removal'?removalRequest(d,r.mutationId):request(d,r.mutationId,p.confirmPaymentResets)),'Invalid prepared financial save.');}
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
      requireValue(!row.pending||row.pending.kind===undefined&&row.pending.checkId===checkId&&row.pending.rejection,'Confirm the pending split save before reviewing newer data.');
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
        const current=pendingDraft(row,sent.pending);requireValue(current&&fingerprint(current)===sent.pending.reviewHash,'The saved review changed. Its original request is kept.');
        if(sent.pending.kind==='removal')delete row.removals[sent.pending.checkId];else delete row.drafts[sent.pending.checkId];
        if(sent.pending.kind==='removal'&&!checkIn(result,sent.pending.checkId)){
          row.removedSharing??={};row.removedSharing[sent.pending.checkId]={...account(result),checkId:sent.pending.checkId,revision:result.revision,committedRevision:result.committedRevision,checkAbsent:true};
        }
        row.pending=null;row.receipt={mutationId:r.mutationId,requestHash,checkId:sent.pending.checkId,...(sent.pending.kind?{kind:sent.pending.kind}:{}),committedRevision:result.committedRevision,snapshot:clone(result)};row.generation++;return this.validate(row);
      });return clone(result);
    }
    discard(checkId){return this.update(row=>{requireValue(!row.pending||row.pending.kind===undefined&&row.pending.checkId===checkId&&row.pending.rejection,'Retry the uncertain split save before discarding its review.');delete row.drafts[checkId];row.pending=null;return row;});}
    startRemoval(fresh){const b=removalBaseline(fresh);validateBaseline(b,this.binding,{removal:true});return this.update(row=>{
      requireValue(!row.pending,'Resolve the saved financial action before reviewing deletion.');row.removals??={};row.removals[b.checkId]??={baseline:b,confirmed:false};return row;
    });}
    confirmRemoval(checkId,confirmed){requireValue(typeof confirmed==='boolean','Invalid deletion confirmation.');return this.update(row=>{
      requireValue(!row.pending,'Resolve the saved financial action before changing confirmation.');requireValue(row.removals?.[checkId],'Open the saved deletion first.');row.removals[checkId].confirmed=confirmed;return row;
    });}
    compareRemoval(checkId,fresh){const old=this.row?.removals?.[checkId]?.baseline;requireValue(old,'Open the saved deletion first.');return compareRemoval(old,removalBaseline(fresh));}
    reviewRemoval(checkId,fresh){const c=this.compareRemoval(checkId,fresh);requireValue(!c.missing,'This check was removed. Keep or discard the saved deletion review.');return this.update(row=>{
      requireValue(!row.pending||row.pending.kind==='removal'&&row.pending.checkId===checkId&&row.pending.rejection,'Retry the uncertain financial action before changing its review.');
      row.removals[checkId]={baseline:c.next,confirmed:false};row.pending=null;return row;
    });}
    prepareRemoval(checkId,fresh){const c=this.compareRemoval(checkId,fresh);return this.update(row=>{
      requireValue(!row.pending,'Resolve the saved financial action before deleting.');requireValue(!c.changed,'The check or guest selections changed. Review the current values before deleting.');
      const d=row.removals[checkId];requireValue(d.confirmed,'Confirm the reviewed deletion before saving.');
      requireValue(this.crypto&&typeof this.crypto.getRandomValues==='function','Secure save identity is unavailable.');
      // Only the reviewed check is removed from the latest household. Independent
      // edits and container metadata survive without requiring a new confirmation.
      d.baseline=c.next;const mutationId='check-remove-'+Array.from(this.crypto.getRandomValues(new Uint8Array(24)),v=>v.toString(16).padStart(2,'0')).join('');
      const payload=JSON.stringify(removalRequest(d,mutationId));requireValue(new TextEncoder().encode(payload).length<=10*1024*1024,'This household exceeds the server save limit. Export the deletion review.');
      row.pending={kind:'removal',checkId,payload,reviewHash:fingerprint(d),confirmPaymentResets:false,rejection:null};return row;
    });}
    discardRemoval(checkId){return this.update(row=>{requireValue(!row.pending||row.pending.kind==='removal'&&row.pending.checkId===checkId&&row.pending.rejection,'Retry the uncertain financial action before discarding its review.');delete row.removals?.[checkId];row.pending=null;return row;});}
    finishSharingCleanup(checkId,proof){return this.update(row=>{requireValue(same(row.removedSharing?.[checkId],proof),'The saved sharing cleanup changed. Its current record is kept.');delete row.removedSharing[checkId];return row;});}
    removalRecovery(checkId,workingConfirmation=null){const d=this.row?.removals?.[checkId];requireValue(d,'Open the saved deletion first.');const b=d.baseline,c=checkIn(b.owner,checkId),p=this.row.pending;
      // Whitelist known descriptive fields; do not export unknown wire fields or
      // the exact request because older clients may have embedded bearer tokens.
      const text=value=>typeof value==='string'?value:null,amount=value=>typeof value==='number'||typeof value==='string'?value:null;
      const participants=(c.participants||[]).map(p=>({id:p.id,name:text(p.name),linkedPersonId:text(p.linkedPersonId)})),ids=new Set(participants.map(p=>p.id));
      const check={id:c.id,name:text(c.name),isCompleted:!!c.isCompleted,dateISO:text(c.dateISO),notes:text(c.notes),
        items:(c.items||[]).map(i=>({id:i.id,name:text(i.name),price:amount(i.price),sharedByParticipantIds:Array.isArray(i.sharedByParticipantIds)?i.sharedByParticipantIds.filter(id=>ids.has(id)):[]})),
        participants,paidParticipantIds:Array.isArray(c.paidParticipantIds)?c.paidParticipantIds.filter(id=>ids.has(id)):[],
        paymentRequestDates:Object.fromEntries(Object.entries(c.paymentRequestDates||{}).filter(([id,date])=>ids.has(id)&&typeof date==='string'&&/^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/.test(date)))};
      for(const key of ['taxAmount','tipAmount','discountAmount','compAmount','serviceFeeAmount'])check[key]=amount(c[key]??0);
      return JSON.stringify({format:'billhive-check-removal-recovery',version:1,checkId,check,currency:b.owner.state.settings?.currencyCode||'USD',guard:b.guard,sources:b.sources,
        revision:b.owner.revision,confirmed:d.confirmed,workingConfirmation,pending:p?.kind==='removal'&&p.checkId===checkId?{mutationId:JSON.parse(p.payload).mutationId,requestHash:Shared.sha256(p.payload),rejection:p.rejection}:null},null,2);
    }
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
  return {Client,Store,Transport,baseline,preview,ownerSnapshot,removalBaseline,compareRemoval};
});
