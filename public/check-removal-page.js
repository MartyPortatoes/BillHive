/* Native dialog for durable, explicitly confirmed whole-check deletion. */
(function(root){
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const raw=b=>b.owner.state.checks?.checks.find(c=>c.id===b.checkId);
  const count=(n,label)=>n+' '+label+(n===1?'':'s');
  class Page{
    constructor(session,{closed=()=>{}}={}){this.s=session;this.closed=closed;this.confirm=null;this.returnFocus=null;
      this.dialog=document.createElement('dialog');this.dialog.id='check-removal-dialog';this.dialog.className='host-review-dialog';this.dialog.setAttribute('aria-labelledby','check-removal-title');
      this.dialog.innerHTML='<header class="host-review-header"><h2 id="check-removal-title">Delete check</h2><button type="button" class="btn btn-ghost" data-removal-action="close" data-removal-key="close">Close</button></header><div class="host-review-body" tabindex="-1"></div><footer class="host-review-footer"><p class="host-review-status" role="status" aria-live="polite"></p><button type="button" class="btn btn-danger" data-removal-action="primary" data-removal-key="primary"></button></footer>';
      document.body.append(this.dialog);this.body=this.dialog.querySelector('.host-review-body');
      this.dialog.addEventListener('cancel',event=>{event.preventDefault();this.close();});this.dialog.addEventListener('click',event=>this.click(event));
      this.dialog.addEventListener('change',event=>{if(event.target.matches('[data-removal-confirm]'))this.s.setConfirmation(event.target.checked);});
      const resize=()=>{this.dialog.style.setProperty('--review-height',(root.visualViewport?.height||innerHeight)+'px');this.dialog.style.setProperty('--review-top',(root.visualViewport?.offsetTop||0)+'px');};resize();root.visualViewport?.addEventListener('resize',resize);root.visualViewport?.addEventListener('scroll',resize);
      root.addEventListener('beforeunload',event=>{if(this.s.dirty){event.preventDefault();event.returnValue='';}});
    }
    get open(){return this.dialog.open;}
    async show(id){if(this.open)return;this.returnFocus=document.activeElement;this.confirm=null;this.dialog.showModal();this.render();await this.s.open(id);this.render();}
    close(){if(this.s.close())this.hide();}
    hide(){if(!this.open)return;this.dialog.close();this.closed();if(this.returnFocus?.isConnected&&!this.returnFocus.disabled)this.returnFocus.focus();else document.querySelector('.tab[data-page="checks"]')?.focus();}
    button(label,action,disabled=false){return `<button type="button" class="btn btn-ghost" data-removal-action="${action}" data-removal-key="${action}" ${disabled?'disabled':''}>${esc(label)}</button>`;}
    summary(b,label){const c=raw(b),currency=b.owner.state.settings?.currencyCode||'USD';if(!c)return `<section class="host-review-card"><h3>${esc(label)}</h3><p>This check is already removed.</p></section>`;
      const names=new Map((c.participants||[]).map(p=>[p.id,p.name||p.id]));return `<section class="host-review-card"><h3>${esc(label)}</h3><p>${esc(c.name||c.id)} · ${c.isCompleted?'Completed':'Open'} · ${esc(c.dateISO||'No date')}</p>
        <p>${esc(c.notes||'No notes')}</p><p>Currency: ${esc(currency)}</p><p>${count((c.items||[]).length,'item')} · ${count((c.participants||[]).length,'participant')} · ${count((c.paidParticipantIds||[]).length,'paid mark')} · ${count(Object.keys(c.paymentRequestDates||{}).length,'payment request')}</p>
        <ul>${(c.items||[]).map(i=>`<li>${esc(i.name||i.id)}: ${esc(i.price??i.amount??0)} · ${esc((i.sharedByParticipantIds||[]).map(id=>names.get(id)||id).join(', ')||'Everyone')}</li>`).join('')}</ul>
        <p>${[['taxAmount','Tax'],['tipAmount','Tip'],['discountAmount','Discount'],['compAmount','Comp credit'],['serviceFeeAmount','Service fee']].map(([key,label])=>label+': '+esc(c[key]??0)).join(' · ')}</p>
        <p>Participants: ${esc((c.participants||[]).map(p=>(p.name||p.id)+(p.linkedPersonId?' (household person '+p.linkedPersonId+')':'')).join(', ')||'None')}</p>
        <p>Paid: ${esc((c.paidParticipantIds||[]).map(id=>names.get(id)||id).join(', ')||'None')}</p><p>Requested: ${esc(Object.entries(c.paymentRequestDates||{}).map(([id,date])=>(names.get(id)||id)+' · '+date).join(', ')||'None')}</p>
        <p>${b.guard.shareId?'The active public link will be permanently revoked.':'No active public link.'} ${count(b.sources.length,'guest declaration')}.</p>
        <ul>${b.sources.map(s=>`<li>${esc(s.name)} · ${esc(s.itemIds.map(id=>(c.items||[]).find(i=>i.id===id)?.name||id).join(', ')||'No selected items')} · ${esc(s.claimedAt)}</li>`).join('')}</ul></section>`;
    }
    render(){if(!this.s.scope){this.hide();return;}if(!this.open)return;const s=this.s,focused=document.activeElement,key=this.dialog.contains(focused)?focused.dataset.removalKey:null,scroll=this.body.scrollTop;
      const brief=s.error||s.storageError?'Needs attention':s.busy?'Working…':s.dirty?'Saving confirmation…':s.pending?'Pending deletion':s.draft?'Review saved':'Finished';this.dialog.querySelector('.host-review-status').textContent=brief;
      const primary=this.dialog.querySelector('[data-removal-action="primary"]');primary.textContent=s.comparison?'Use current check and review again':s.pending?(s.pending.rejection?'Compare current check':'Retry saved deletion'):'Delete reviewed check';
      primary.className='btn '+(s.comparison||s.pending?.rejection?'btn-green':'btn-danger');
      primary.disabled=s.busy||s.dirty||!!s.storageError||!s.draft||!!s.comparison?.unavailable||!s.comparison&&!s.pending&&!s.working;
      this.dialog.querySelector('#check-removal-title').textContent='Delete check'+(s.draft?' · '+(raw(s.draft.baseline).name||s.activeId):'');
      const message=s.error||s.storageError||s.message||'Opening saved deletion review…';if(!s.draft){this.body.innerHTML=`<p role="status">${esc(message)}</p>`;return;}
      const actions=this.button('Refresh / compare','refresh',s.busy||!!s.pending&&!s.pending.rejection)+this.button('Export recovery copy','export',s.busy)+this.button('Reload saved confirmation','reload',s.busy)+this.button('Discard deletion review','discard',s.busy||!!s.pending&&!s.pending.rejection)+(s.dirty?this.button('Retry saving confirmation','save',s.busy):'');
      let comparison='';if(s.comparison){const f=s.comparison.fresh;const next={owner:f.owner,checkId:s.activeId,guard:{shareId:f.sharing.share?.shareId??null},sources:root.BillHiveCheckReview.sources(f.sharing)};
        comparison=`<p>The check, currency, link, guest declarations or other saved check details changed. Updating the review clears your previous confirmation and does not delete anything.</p><div class="host-review-comparison">${this.summary(s.draft.baseline,'Saved review')}${this.summary(next,'Current check')}</div>`;}
      this.body.innerHTML=`<p ${s.error||s.storageError?'role="alert"':''}>${esc(message)}</p><div class="host-review-actions">${actions}</div>
        ${this.confirm?`<section class="host-review-card" role="alert"><p>${this.confirm==='reload'?'Replace the on-screen confirmation with the saved one?':'Discard this deletion review? The check itself will be kept.'}</p>${this.button('Confirm','confirm',s.busy)} ${this.button('Cancel','cancel')}</section>`:''}
        ${s.pending?`<p>Saved deletion: ${s.pending.rejection?'rejected; compare before preparing another request':'outcome uncertain; retry sends the original request'}. Confirmation is locked.</p>`:''}
        ${comparison||this.summary(s.draft.baseline,'Check to delete')}
        <section class="host-review-card"><p>Deleting removes this check and its payment tracking. Saved unfinished reviews remain available for recovery. Restoring the same check later will not reactivate its old public link.</p>
        <label class="review-check"><input type="checkbox" data-removal-confirm data-removal-key="confirmation" ${s.working?'checked':''} ${s.editable?'':'disabled'}>I reviewed this check and confirm deleting it and revoking its active public link.</label></section>`;
      this.body.scrollTop=scroll;if(key){const next=[...this.dialog.querySelectorAll('[data-removal-key]')].find(e=>e.dataset.removalKey===key);if(next&&!next.disabled)next.focus({preventScroll:true});}
    }
    async click(event){const el=event.target.closest('[data-removal-action]');if(!el||el.disabled)return;event.preventDefault();const action=el.dataset.removalAction,s=this.s;
      if(action==='close'){this.close();return;}
      if(action==='reload'||action==='discard'){this.confirm=action;this.render();return;}
      if(action==='cancel'){this.confirm=null;this.render();return;}
      if(action==='confirm'){const kind=this.confirm;this.confirm=null;if(kind==='reload')await s.reloadSaved();else if(kind==='discard')await s.discard();}
      if(action==='refresh')await s.refresh();if(action==='save')await s.saveWorking();
      if(action==='primary'){if(s.comparison)await s.adopt();else if(s.pending){if(s.pending.rejection)await s.refresh();else await s.retry();}else await s.apply();}
      if(action==='export'){try{const url=URL.createObjectURL(new Blob([s.export()],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='check-deletion-review.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);s.message='Recovery copy downloaded without link credentials.';}catch(error){s.error=error.message;}}
      this.render();
    }
  }
  root.BillHiveCheckRemovalPage=Page;
})(globalThis);
