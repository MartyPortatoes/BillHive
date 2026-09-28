/* Reviewed deletion uses the same account-scoped financial journal as splits. */
(function(root,factory){
  const node=typeof module==='object'&&module.exports;
  const api=factory(node?require('./check-review-session'):root.BillHiveCheckReviewSession,node?require('./check-review-client'):root.BillHiveCheckReviewClient,node?require('./check-claim-client'):root.BillHiveCheckClaims);
  if(node)module.exports=api;else root.BillHiveCheckRemovalSession=api;
})(globalThis,function(Base,Data,Shared){
  'use strict';
  const copy=structuredClone,same=(a,b)=>Shared.canonical(a)===Shared.canonical(b);
  class Session extends Base{
    get draft(){return this.client?.row?.removals?.[this.activeId];}
    async restoreWorking(){this.working=this.draft?.confirmed??false;this.dirty=false;this.comparison=null;this.storageError='';this.version++;}
    open(checkId){return this.run(async()=>{
      if(this.activeId&&this.dirty)throw new Error('Save or explicitly reload the current confirmation first.');
      const client=this.client;await client.open();this.bound(client);
      if(client.row.pending&&client.row.pending.kind!=='removal')throw new Error('A guest split is pending. Close and open its saved review before deleting.');
      this.activeId=client.row.pending?.checkId||checkId;
      if(!this.draft){await this.beforeApply();this.bound(client);await this.checkLinks(this.activeId);this.bound(client);const fresh=await client.transport.load(this.activeId);this.bound(client);await client.startRemoval(fresh);this.bound(client);}
      await this.restoreWorking();this.message=this.pending?'A deletion is awaiting confirmation.':'Review the check and its sharing before confirming deletion. Closing keeps this review.';
    });}
    setConfirmation(value){if(!this.editable)return;this.working=!!value;this.dirty=true;this.error='';this.version++;
      const epoch=this.epoch,version=this.version,client=this.client,id=this.activeId;this.changed();
      this.queue=this.queue.then(async()=>{if(epoch!==this.epoch)return;this.bound(client);await client.confirmRemoval(id,!!value);if(epoch===this.epoch&&version===this.version){this.dirty=false;this.storageError='';}})
        .catch(error=>{if(epoch===this.epoch)this.storageError=error.message;}).then(()=>{if(epoch===this.epoch)this.changed();});
    }
    saveWorking(){return this.run(async()=>{const client=this.client;if(this.dirty){await client.confirmRemoval(this.activeId,this.working);this.bound(client);this.dirty=false;this.storageError='';}this.message='Deletion confirmation saved.';});}
    refresh(){return this.run(async()=>{if(this.dirty)throw new Error('Save or explicitly reload your confirmation before comparing.');const client=this.client;await this.checkLinks(this.activeId);this.bound(client);const fresh=await client.transport.load(this.activeId);this.bound(client);this.inspect(fresh);});}
    inspect(fresh){
      if(fresh.capabilities?.checkShareGuardProtocol!==1||!fresh.capabilities.revisionPreconditionsRequired||!fresh.sharing.revisionPreconditionsRequired){this.comparison={fresh,unavailable:true};this.message='Protected deletion is unavailable. The saved review remains available for recovery.';return false;}
      const result=this.client.compareRemoval(this.activeId,fresh);
      if(result.changed){this.comparison={fresh,unavailable:result.missing};this.message=result.missing?'This check was removed. Keep or discard the saved review.':'The check or guest selections changed. Compare them and confirm again.';return false;}
      this.comparison=null;this.message='The reviewed check and guest selections are current.';return true;
    }
    adopt(){return this.run(async()=>{if(this.dirty||!this.comparison||this.comparison.unavailable)throw new Error('Load a current check before updating this deletion review.');
      const client=this.client,id=this.activeId,reviewed=copy(this.comparison.fresh);await this.checkLinks(id);this.bound(client);const fresh=await client.transport.load(id);this.bound(client);
      if(!same(Data.removalBaseline(reviewed),Data.removalBaseline(fresh))){this.inspect(fresh);throw new Error('The comparison changed again. Review the latest values.');}
      await client.reviewRemoval(id,fresh);this.bound(client);await this.restoreWorking();this.message='Review updated. Confirm deletion of the current check again.';
    });}
    apply(){return this.run(async()=>{if(this.dirty||this.storageError||!this.working)throw new Error('Save your confirmation before deleting the reviewed check.');
      const client=this.client,id=this.activeId;await this.beforeApply();this.bound(client);await this.checkLinks(id);this.bound(client);const fresh=await client.transport.load(id);this.bound(client);
      if(!this.inspect(fresh))return;await client.prepareRemoval(id,fresh);this.bound(client);this.changed();await this.submit();
    });}
    async submit(){const client=this.client;if(client.row.pending?.kind!=='removal')throw new Error('Open the pending guest split instead.');
      const result=await client.submit();this.bound(client);this.working=false;this.dirty=false;this.message='Deletion confirmed.';await this.committed(result);
    }
    discard(){return this.run(async()=>{const client=this.client;await client.discardRemoval(this.activeId);this.bound(client);this.working=false;this.dirty=false;this.comparison=null;this.message='Deletion review discarded.';});}
    export(){this.bound();return this.client.removalRecovery(this.activeId,this.dirty?this.working:null);}
  }
  return Session;
});
