/* Coordinates owner UI intent without coupling link writes to household saves. */
(function(root,factory){
  const api=factory(typeof module==='object'&&module.exports?require('./check-owner-client'):root.BillHiveCheckOwner,
    typeof module==='object'&&module.exports?require('./check-claim-client'):root.BillHiveCheckClaims);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.BillHiveCheckOwnerSession=api;
})(globalThis,function(Data,Shared){
  'use strict';
  const clone=structuredClone;
  const scope=owner=>owner?Shared.canonical({userId:owner.userId,serverInstanceId:owner.serverInstanceId,householdId:owner.householdId}):null;
  class Session {
    constructor({owner,beforeAction,confirm,changed=()=>{},store=new Data.Store(),clientFactory=args=>new Data.Client(args),apiBase='/api'}) {
      Object.assign(this,{owner,beforeAction,confirm,changed,store,clientFactory,apiBase});
      this.clients=new Map();this.messages=new Map();this.listing=[];this.listError='';this.scope=null;this.busy=null;
    }
    current(){const owner=this.owner();if(!owner)throw new Error('Load this household on a server with protected check sharing support.');return owner;}
    bound(client){if(scope(this.current())!==scope(client.owner))throw new Error('The account or household changed. Reopen sharing in the original account.');}
    client(id){const owner=this.current();if(scope(owner)!==this.scope)throw new Error('Sharing is still loading for this household.');
      if(!this.clients.has(id))this.clients.set(id,this.clientFactory({owner,checkId:id,apiBase:this.apiBase,store:this.store}));return this.clients.get(id);}
    async hydrate(owner){
      const next=scope(owner);
      if(next!==this.scope){this.scope=next;this.clients.clear();this.messages.clear();this.listing=[];this.listError='';}
      if(!owner){this.changed();return;}
      await this.list();
    }
    async list(){
      const expected=this.scope;if(!expected)return;
      try{const client=this.clientFactory({owner:this.current(),checkId:'listing',apiBase:this.apiBase,store:this.store});const listing=await client.list();
        if(this.scope===expected){this.listing=listing;this.listError='';}}
      catch(error){if(this.scope===expected)this.listError=error.message;}
      this.changed();
    }
    async run(id,work){
      if(this.busy!==null)return false;
      this.busy=id;this.messages.delete(id);const expected=this.scope;this.changed();
      try{const client=this.client(id);await client.open();this.bound(client);await work(client);this.bound(client);return true;}
      catch(error){if(this.scope===expected)this.messages.set(id,error.message||'Sharing could not be confirmed. Your saved action is kept.');return false;}
      finally{await this.list();this.busy=null;this.changed();}
    }
    open(id){return this.run(id,async()=>{});}
    refresh(id){return this.run(id,async client=>{await this.beforeAction();this.bound(client);await client.refresh(this.current());this.messages.set(id,'Sharing refreshed.');});}
    change(id,kind){return this.run(id,async client=>{
      if(client.row.pending)throw new Error('Resolve the saved sharing action before starting another.');
      await this.beforeAction();this.bound(client);await client.refresh(this.current());
      const reviewed=clone(client.row.snapshot);this.changed();
      if(kind==='rotate'||kind==='revoke'){
        if(!await this.confirm(kind,clone(reviewed)))return;
        this.bound(client);await this.beforeAction();this.bound(client);await client.refresh(this.current());
        if(Shared.canonical(reviewed)!==Shared.canonical(client.row.snapshot))throw new Error('The check or sharing changed during confirmation. Review the current details and confirm again.');
      }
      this.bound(client);await client.prepare(kind,reviewed,this.current());this.changed();
      this.bound(client);await client.submit();this.messages.set(id,kind==='revoke'?'The link action is confirmed.':'The link action is confirmed. The current link is shown below.');
    });}
    retry(id){return this.run(id,async client=>{this.bound(client);await client.submit();this.messages.set(id,'Saved sharing action confirmed. The current link status is shown below.');});}
    dismiss(id){return this.run(id,async client=>{
      if(!client.row.pending?.rejection)throw new Error('Only a definitely rejected action can be cleared. Retry an uncertain action.');
      if(!await this.confirm('dismiss',clone(client.row.snapshot)))return;
      this.bound(client);await client.dismissRejected();this.messages.set(id,'Rejected action cleared. Refresh and review before starting another action.');
    });}
    async export(id,download){return this.run(id,async client=>{this.bound(client);await download(client.recovery());this.messages.set(id,'Recovery copy downloaded without links or credentials.');});}
    view(id){const row=this.clients.get(id)?.row,entry=this.listing.find(v=>v.checkId===id);
      return {row,entry,busy:this.busy!==null,message:this.messages.get(id)||entry?.error||'',available:!!this.scope};}
  }
  return Session;
});
