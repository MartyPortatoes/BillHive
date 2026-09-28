/* Ordered UI intent, raw draft preservation and reviewed financial saves. */
(function(root,factory){
  const node=typeof module==='object'&&module.exports;
  const api=factory(node?require('./check-review-client'):root.BillHiveCheckReviewClient,node?require('./check-claim-review'):root.BillHiveCheckReview,node?require('./check-claim-client'):root.BillHiveCheckClaims);
  if(node)module.exports=api;else root.BillHiveCheckReviewSession=api;
})(globalThis,function(Data,Review,Shared){
  'use strict';
  const same=(a,b)=>Shared.canonical(a)===Shared.canonical(b),copy=structuredClone;
  const scope=o=>o?Shared.canonical([o.userId,o.serverInstanceId,o.householdId]):null;
  class Session{
    constructor({owner,beforeApply,checkLinks,committed,accountChanged=async()=>{},changed=()=>{},clientFactory=args=>new Data.Client(args),calculate=d=>Promise.resolve(Data.preview(d))}){
      Object.assign(this,{owner,beforeApply,checkLinks,committed,accountChanged,changed,clientFactory,calculate});
      this.client=null;this.scope=null;this.epoch=0;this.activeId=null;this.working=null;this.preview=null;this.comparison=null;this.message='';this.error='';this.storageError='';
      this.busy=false;this.dirty=false;this.calculating=false;this.version=0;this.confirmPaymentResets=false;this.queue=Promise.resolve();
    }
    bound(client=this.client){if(!client||scope(this.owner())!==this.scope||scope(client.binding)!==this.scope)throw new Error('Reopen this review in its original signed-in household.');}
    async hydrate(owner){const next=scope(owner);if(next!==this.scope){this.epoch++;this.scope=next;this.client=owner?this.clientFactory({owner}):null;this.activeId=null;this.working=null;this.preview=null;this.comparison=null;this.dirty=false;this.busy=false;this.calculating=false;this.error='';this.storageError='';this.version++;}
      const epoch=this.epoch,client=this.client;if(client&&!this.activeId){try{await client.open();if(epoch===this.epoch)this.storageError='';}catch(error){if(epoch===this.epoch)this.storageError=error.message;}}
      this.changed();
    }
    get pending(){return this.client?.row?.pending;}
    get draft(){return this.client?.row?.drafts[this.activeId];}
    get editable(){return !!this.draft&&!this.pending&&!this.busy&&!this.comparison;}
    async ordinaryWriteAllowed(){if(!this.client)return;this.bound();const probe=this.clientFactory({owner:this.owner(),store:this.client.store});await probe.open();if(probe.row.pending)throw new Error('Resolve the saved guest split before saving household changes. Your edits are kept in this tab.');}
    async run(work){if(this.busy)return false;const epoch=this.epoch,client=this.client;this.busy=true;this.error='';this.message='';this.changed();
      try{await this.queue;if(epoch!==this.epoch)throw new Error('The review account changed.');this.bound(client);await work();return true;}
      catch(error){if(epoch===this.epoch){this.error=error.message;if(error.code==='REVIEW_ACCOUNT_CHANGED')await this.accountChanged().catch(()=>{});}return false;}
      finally{if(epoch===this.epoch){this.busy=false;this.changed();}}
    }
    async calculateCurrent(){const epoch=this.epoch,version=this.version,id=this.activeId;if(!this.draft||!this.working)return;
      const draft={...copy(this.draft),plan:copy(this.working)};this.calculating=true;this.changed({inputs:true});
      try{const result=await this.calculate(draft);if(epoch===this.epoch&&version===this.version&&id===this.activeId)this.preview=result;}
      catch(error){if(epoch===this.epoch&&version===this.version){this.preview=null;this.error=error.message;}}
      finally{if(epoch===this.epoch&&version===this.version){this.calculating=false;this.changed({inputs:true});}}
    }
    async restoreWorking(){this.working=this.draft?copy(this.draft.plan):null;this.dirty=false;this.version++;this.confirmPaymentResets=false;this.comparison=null;this.preview=null;this.storageError='';await this.calculateCurrent();}
    open(checkId){return this.run(async()=>{
      if(this.activeId&&this.dirty)throw new Error('Keep or export the current unsaved choices before opening another review.');
      const client=this.client;await client.open();this.bound(client);if(client.row.pending?.kind==='removal')throw new Error('A check deletion is pending. Close and reopen its saved deletion review.');checkId=client.row.pending?.checkId||checkId;this.activeId=checkId;
      if(!client.row.drafts[checkId]){await this.beforeApply();await this.checkLinks(checkId);const fresh=await client.transport.load(checkId);this.bound(client);await client.start(fresh);}
      await this.restoreWorking();this.message=this.pending?'A saved split is awaiting confirmation.':'Your choices are saved as you edit. Refresh checks for newer selections.';
    });}
    edit(transform){if(!this.editable)return;const next=copy(this.working);transform(next);Review.validatePlan(next);this.working=next;this.dirty=true;this.confirmPaymentResets=false;this.version++;
      const version=this.version,epoch=this.epoch,client=this.client,id=this.activeId;this.error='';this.changed({inputs:true});
      this.queue=this.queue.then(async()=>{if(epoch!==this.epoch)return;this.bound(client);await client.edit(id,next);if(version===this.version){this.dirty=false;this.storageError='';}})
        .catch(error=>{if(epoch===this.epoch)this.storageError=error.message;}).then(()=>{if(epoch===this.epoch)this.changed({inputs:true});});
      this.calculateCurrent();
    }
    saveWorking(){return this.run(async()=>{const client=this.client;if(this.dirty){await client.edit(this.activeId,this.working);this.bound(client);this.dirty=false;this.storageError='';}await this.calculateCurrent();this.bound(client);this.message='Review choices saved.';});}
    reloadSaved(){return this.run(async()=>{const client=this.client;await client.open();this.bound(client);await this.restoreWorking();this.bound(client);this.message='Saved choices reopened.';});}
    refresh(){return this.run(async()=>{const client=this.client,id=this.activeId;if(this.dirty)throw new Error('Save or export your unsaved choices before comparing newer data.');await this.checkLinks(id);this.bound(client);const fresh=await client.transport.load(id);this.bound(client);this.inspect(fresh);});}
    inspect(fresh){
      if(!fresh.sharing.checkExists||fresh.sharing.isCompleted||!fresh.sharing.revisionPreconditionsRequired||fresh.capabilities?.checkShareGuardProtocol!==1){this.comparison={fresh,unavailable:true};this.confirmPaymentResets=false;this.message='This check is removed, completed or no longer supports protected review. Saved choices remain available for recovery.';return false;}
      if(this.client.compare(this.activeId,fresh).changed){this.comparison={fresh,unavailable:false};this.confirmPaymentResets=false;this.message='The household or guest selections changed. Compare the saved and current values before continuing.';return false;}
      this.comparison=null;this.message='The saved review matches the current household and selections.';return true;
    }
    adopt(keep){return this.run(async()=>{if(this.dirty||!this.comparison||this.comparison.unavailable)throw new Error('Load a current open check before updating this review.');
      const client=this.client,id=this.activeId,reviewed=copy(this.comparison.fresh);await this.checkLinks(id);this.bound(client);const fresh=await client.transport.load(id);this.bound(client);
      if(!same(Data.baseline(reviewed.owner,reviewed.sharing,reviewed.capabilities),Data.baseline(fresh.owner,fresh.sharing,fresh.capabilities))){this.inspect(fresh);throw new Error('The comparison changed again. Review the latest values before choosing.');}
      await client.review(id,fresh,keep);this.bound(client);await this.restoreWorking();this.message='Review updated. Check the assignments and totals again before applying.';
    });}
    apply(){return this.run(async()=>{
      if(this.dirty||this.storageError)throw new Error('Save your review choices before applying the split.');
      const client=this.client,id=this.activeId;await this.calculateCurrent();this.bound(client);if(!this.preview?.ready)throw new Error('Resolve the review items before applying the split.');
      await this.beforeApply();this.bound(client);await this.checkLinks(id);this.bound(client);const fresh=await client.transport.load(id);this.bound(client);if(!this.inspect(fresh))return;
      await client.prepare(id,fresh,this.preview,this.confirmPaymentResets);this.bound(client);this.changed();await this.submit();
    });}
    async submit(){const client=this.client;if(client.row.pending?.kind==='removal')throw new Error('Open the saved deletion review instead.');const result=await client.submit();this.bound(client);this.working=null;this.preview=null;this.dirty=false;this.message='Guest split confirmed.';await this.committed(result);}
    retry(){return this.run(async()=>{await this.submit();});}
    discard(){return this.run(async()=>{const client=this.client;await client.discard(this.activeId);this.bound(client);this.working=null;this.preview=null;this.dirty=false;this.message='Saved review discarded.';});}
    export(){this.bound();return this.client.recovery(this.activeId,this.dirty?this.working:null);}
    close(){if(this.busy||this.dirty){this.error='Wait for saving, or export and explicitly reload saved choices before closing.';this.changed();return false;}this.activeId=null;this.working=null;this.preview=null;this.comparison=null;this.changed();return true;}
  }
  return Session;
});
