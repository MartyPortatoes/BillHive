/* Native controls for host review; the session owns all durable intent. */
(function(root){
  'use strict';
  const R=root.BillHiveCheckReview,copy=structuredClone,esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const uniq=a=>[...new Set(a)],same=(a,b)=>root.BillHiveCheckClaims.canonical(a)===root.BillHiveCheckClaims.canonical(b);
  function calculator(){let worker=null,next=0;const waiting=new Map();
    if(typeof Worker==='function'){worker=new Worker('/check-review-worker.js');worker.onmessage=event=>{const p=waiting.get(event.data.id);if(!p)return;waiting.delete(event.data.id);event.data.error?p.reject(new Error(event.data.error)):p.resolve(event.data.result);};worker.onerror=()=>{worker.terminate();worker=null;for(const p of waiting.values())p.reject(new Error('The split preview could not run. Reopen the saved review.'));waiting.clear();};}
    return draft=>worker?new Promise((resolve,reject)=>{const id=++next;waiting.set(id,{resolve,reject});worker.postMessage({id,draft});}):Promise.resolve(root.BillHiveCheckReviewClient.preview(draft));
  }
  class Page{
    constructor(session,{closed=()=>{}}={}){this.s=session;this.closed=closed;this.tab='guests';this.confirm=null;this.returnFocus=null;this.checkId=null;
      const dialog=document.createElement('dialog');dialog.className='host-review-dialog';dialog.id='host-review-dialog';dialog.setAttribute('aria-labelledby','host-review-title');
      dialog.innerHTML='<header class="host-review-header"><h2 id="host-review-title">Review guest split</h2><button type="button" class="btn btn-ghost" data-review-action="close" data-review-key="close" aria-label="Close guest split review">Close</button></header><nav class="host-review-nav" aria-label="Guest split review steps"></nav><div class="host-review-body" tabindex="-1"></div><footer class="host-review-footer"><p class="host-review-status" role="status" aria-live="polite"></p><button type="button" class="btn btn-green" data-review-action="primary" data-review-key="primary"></button></footer>';
      document.body.append(dialog);this.dialog=dialog;this.body=dialog.querySelector('.host-review-body');
      dialog.addEventListener('cancel',event=>{event.preventDefault();this.close();});dialog.addEventListener('click',event=>this.click(event));dialog.addEventListener('change',event=>this.input(event));dialog.addEventListener('input',event=>{if(event.target.matches('[data-review-field="name"]'))this.input(event);});
      const resize=()=>{dialog.style.setProperty('--review-height',(visualViewport?.height||innerHeight)+'px');dialog.style.setProperty('--review-top',(visualViewport?.offsetTop||0)+'px');};resize();root.visualViewport?.addEventListener('resize',resize);root.visualViewport?.addEventListener('scroll',resize);
      root.addEventListener('beforeunload',event=>{if(this.s.dirty){event.preventDefault();event.returnValue='';}});
    }
    get open(){return this.dialog.open;}
    async show(checkId){if(this.open)return;this.returnFocus=document.activeElement;this.checkId=checkId;this.tab='guests';this.confirm=null;this.dialog.showModal();this.render();await this.s.open(checkId);this.render();}
    close(){if(!this.s.close())return;this.hide();}
    hide(){if(!this.open)return;this.dialog.close();const previous=this.returnFocus;this.closed();
      if(previous?.isConnected&&!previous.disabled)previous.focus();else document.querySelector('.tab[data-page="checks"]')?.focus();}
    options(values,selected){return values.map(([value,label])=>`<option value="${esc(value)}" ${value===(selected??'')?'selected':''}>${esc(label)}</option>`).join('');}
    button(label,action,extra='',disabled=false){return `<button type="button" class="btn btn-ghost" data-review-action="${action}" ${extra} ${disabled?'disabled':''}>${esc(label)}</button>`;}
    inputAttrs(field,key,extra=''){return `data-review-field="${field}" data-review-key="${esc(field+':'+key)}" ${extra} ${!this.s.editable?'disabled':''}`;}
    people(){return [...(this.s.draft?.baseline.owner.state.checks.checks.find(c=>c.id===this.s.activeId)?.participants||[]),...(this.s.working?.newParticipants||[])];}
    person(id){const p=this.people().find(p=>p.id===id);return p?`${p.name||'Unnamed'} · ${id.slice(-8)}`:`Unavailable participant · ${id}`;}
    item(id){const c=this.s.draft?.baseline.owner.state.checks.checks.find(c=>c.id===this.s.activeId);return c?.items.find(i=>i.id===id)?.name||`Removed item · ${id}`;}
    sources(){if(!this.s.draft)return[];const d=this.s.draft,c=d.baseline.owner.state.checks.checks.find(c=>c.id===this.s.activeId),previous=new Map((R.ledger(c)?.selections||[]).map(v=>[R.sourceId(v.source),v]));
      const current=new Map(d.baseline.sources.map(v=>[R.sourceId(v),v])),all=new Map([...previous].map(([id,v])=>[id,v.source]));for(const [id,s]of current)all.set(id,s);
      for(const s of d.retainedSources)if(Object.hasOwn(this.s.working.choices,R.sourceId(s))&&!all.has(R.sourceId(s)))all.set(R.sourceId(s),s);
      return [...all].map(([id,source])=>({id,source,current:current.get(id),previous:previous.get(id),choice:this.s.working.choices[id]}));
    }
    guests(){const rows=this.sources();if(!rows.length)return '<p>No guest selections are waiting. Previously applied assignments still appear under Items.</p>';
      return rows.map(row=>{const {id,source,current,previous,choice}=row,obsolete=!current&&!previous,key=`data-source="${id}"`,target=choice?.participantId??(choice?.action==='KEEP_PREVIOUS'?previous?.participantId:null),newPerson=this.s.working.newParticipants.find(p=>p.id===target);
        const choices=[['','Choose how to handle this guest'],...(current?[['APPLY','Use current selection']]:[]),...(previous?[['KEEP_PREVIOUS','Keep previous assignment']]:[]),['REMOVE','Ignore / remove contribution']];
        const missing=uniq(current?.itemIds||[]).filter(id=>!this.s.draft.baseline.owner.state.checks.checks.find(c=>c.id===this.s.activeId).items.some(i=>i.id===id));
        return `<section class="host-review-card"><h3>${esc(source.name||'Unnamed guest')}</h3><p>Guest reference ${esc(id.slice(-8))}${source.claimantId===null?' · Earlier selection':''}</p>
          <p>Current: ${current?(current.itemIds.length?esc(uniq(current.itemIds).map(id=>this.item(id)).join(', ')):'No selected items (withdrawal)'):'No current selection on this link.'}</p>
          ${previous?`<p>Previously applied: ${previous.participantId?esc(this.person(previous.participantId)):'Ignored'} · ${esc(previous.itemIds.map(id=>this.item(id)).join(', ')||'No items')}</p>`:''}
          ${obsolete?`<p>This unapplied saved choice is no longer available.</p>${this.button('Forget this obsolete choice','forget-source',key,!this.s.editable)}`:
          `<label>Guest choice<select ${this.inputAttrs('action',id,key)}>${this.options(choices,choice?.action)}</select></label>
          ${['APPLY','KEEP_PREVIOUS'].includes(choice?.action)?`<label>Assign to participant<select ${this.inputAttrs('target',id,key)}>${this.options([['','Choose a participant'],...this.people().map(p=>[p.id,this.person(p.id)]),['__new__','Create a new participant…']],target)}</select></label>`:''}
          ${newPerson?`<label>New participant name<input type="text" ${this.inputAttrs('name',id,`data-person="${esc(newPerson.id)}"`)} value="${esc(newPerson.name)}"></label>
          <label>Optional household person<select ${this.inputAttrs('linked',id,`data-person="${esc(newPerson.id)}"`)}>${this.options([['','No household link'],...(this.s.draft.baseline.owner.state.people||[]).map(p=>[p.id,p.name])],newPerson.linkedPersonId)}</select></label>`:''}
          ${choice?.action==='APPLY'&&missing.length?`<label class="review-check"><input type="checkbox" ${this.inputAttrs('removed',id,key)} ${choice.acceptRemovedItems?'checked':''}>Use the remaining items; ${esc(missing.join(', '))} were removed.</label>`:''}`}
        </section>`;}).join('');
    }
    items(){const c=this.s.draft.baseline.owner.state.checks.checks.find(c=>c.id===this.s.activeId),p=this.s.working;
      const obsolete=Object.keys(p.manualByItem).filter(id=>!c.items.some(i=>i.id===id)).map(id=>`<section class="host-review-card"><p>Saved manual review for removed item ${esc(id)}</p>${this.button('Forget removed item review','forget-item',`data-item="${esc(id)}"`,!this.s.editable)}</section>`).join('');
      return obsolete+c.items.map(item=>{const row=this.s.preview?.items.find(r=>r.id===item.id),manual=p.manualByItem[item.id]??row?.manual??item.sharedByParticipantIds??[],known=this.people().map(p=>p.id),ids=uniq([...known,...manual]);
        return `<section class="host-review-card"><h3>${esc(item.name||item.id)}</h3><p>Previous final assignments: ${esc((row?.previous||[]).map(id=>this.person(id)).join(', ')||'None')}</p><p>Manual participants remain even if a guest withdraws:</p>
          ${ids.map(id=>`<label class="review-check"><input type="checkbox" ${this.inputAttrs('manual',item.id+':'+id,`data-item="${esc(item.id)}" data-person="${esc(id)}"`)} ${manual.includes(id)?'checked':''}>${esc(this.person(id))}</label>`).join('')}
          ${this.button('Confirm shown manual participants','manual-confirm',`data-item="${esc(item.id)}"`,!this.s.editable||this.s.calculating)}
          <p>Guest contributions: ${esc((row?.contributed||[]).map(id=>this.person(id)).join(', ')||'None')}</p><p>Proposed final assignments: ${esc((row?.proposed||[]).map(id=>this.person(id)).join(', ')||'Assign at least one participant')}</p></section>`;
      }).join('');
    }
    money(value,digits,currency){return value==null?'Unavailable':R.formatUnits(value,digits,currency);}
    totals(){const v=this.s.preview,currency=this.s.draft.baseline.owner.state.settings?.currencyCode||'USD';if(!v)return '<p>The split preview is being calculated.</p>';
      const people=uniq([...Object.keys(v.before?.totals||{}),...Object.keys(v.after?.totals||{})]);
      return `<section class="host-review-card"><h3>Review participant totals</h3><table><thead><tr><th scope="col">Participant</th><th scope="col">Before</th><th scope="col">Proposed</th></tr></thead><tbody>${people.map(id=>`<tr><th scope="row">${esc(this.person(id))}</th><td>${esc(v.before?this.money(v.before.totals[id]||'0',v.before.digits,currency):'Unavailable')}</td><td>${esc(v.after?this.money(v.after.totals[id]||'0',v.after.digits,currency):'Resolve review items')}</td></tr>`).join('')}</tbody></table>
        <p>Proposed check total: ${esc(v.after?this.money(v.after.grandTotal,v.after.digits,currency):'Unavailable')}</p>
        ${v.clearedPaid.length||v.clearedRequests.length?`<p>Paid marks to clear: ${esc(v.clearedPaid.map(id=>this.person(id)).join(', ')||'None')}</p><p>Payment requests to clear: ${esc(v.clearedRequests.map(id=>this.person(id)).join(', ')||'None')}</p><label class="review-check"><input type="checkbox" data-review-field="payment-confirm" data-review-key="payment-confirm" ${this.s.confirmPaymentResets?'checked':''} ${this.s.busy||this.s.pending||this.s.comparison||this.s.dirty||this.s.calculating?'disabled':''}>I reviewed and confirm clearing these payment statuses because their balances change.</label>`:'<p>No payment statuses need to be cleared.</p>'}</section>`;
    }
    comparison(){const b=this.s.draft.baseline,f=this.s.comparison.fresh;
      const panel=(label,owner,sources)=>{const c=owner.state.checks?.checks.find(c=>c.id===this.s.activeId);return `<section class="host-review-card"><h3>${label}</h3><p>Household revision ${owner.revision} · ${esc(owner.state.settings?.currencyCode||'USD')}</p>${!c?'<p>Check removed.</p>':`<p>${esc(c.name)} · ${c.isCompleted?'Completed':'Open'} · ${esc(c.dateISO)}</p><p>${esc(c.notes||'No notes')}</p><p>Participants: ${esc((c.participants||[]).map(p=>p.name+' ['+p.id+']'+(p.linkedPersonId?' → '+p.linkedPersonId:'')).join(', '))}</p><ul>${(c.items||[]).map(i=>`<li>${esc(i.name)}: ${esc(i.price)} · ${esc(i.sharedByParticipantIds?.join(', ')||'Everyone')}</li>`).join('')}</ul><p>${['taxAmount','tipAmount','discountAmount','compAmount','serviceFeeAmount'].map(k=>esc(k.replace('Amount',''))+': '+esc(c[k]??0)).join(' · ')}</p><p>Paid: ${esc((c.paidParticipantIds||[]).join(', ')||'None')}</p><p>Requests: ${esc(Object.entries(c.paymentRequestDates||{}).map(([k,v])=>k+': '+v).join(', ')||'None')}</p>`}<p>Guest selections:</p><ul>${sources.map(s=>`<li>${esc(s.name)} · ${esc(R.sourceId(s).slice(-8))} · ${esc(s.itemIds.join(', ')||'No items')} · ${esc(s.claimedAt)}</li>`).join('')||'<li>None</li>'}</ul></section>`;};
      return `<p>The comparison preserves newer household fields when you keep your choices. It does not apply the split.</p><div class="host-review-comparison">${panel('Saved review',b.owner,b.sources)}${panel('Current server',f.owner,R.sources(f.sharing))}</div>${this.s.comparison.unavailable?'':this.button('Start a new review','restart','',this.s.busy)}`;
    }
    render({inputs=false}={}){if(!this.s.scope){this.hide();return;}if(!this.open)return;const s=this.s,focused=document.activeElement,hadFocus=this.dialog.contains(focused);
      const focusKey=focused.getAttribute('data-review-key'),selection=focused.matches('input[type="text"]')?[focused.selectionStart,focused.selectionEnd]:null,scroll=this.body.scrollTop;
      const message=s.error||s.storageError||s.message||(s.busy?'Working…':s.dirty?'Saving choices…':'');const status=this.dialog.querySelector('.host-review-status'),brief=s.error||s.storageError?'Needs attention':s.busy?'Working…':s.dirty?'Saving choices…':s.pending?'Pending save':!s.draft?'Confirmed':'Choices saved';if(status.textContent!==brief)status.textContent=brief;
      if(s.comparison)this.tab='compare';const tabs=[['guests','Guests'],['items','Items'],['totals','Totals'],...(s.comparison?[['compare','Compare']]:[])];
      this.dialog.querySelector('.host-review-nav').innerHTML=tabs.map(([key,label])=>`<button type="button" class="btn btn-ghost" data-review-tab="${key}" data-review-key="tab:${key}" ${this.tab===key?'aria-current="page"':''}>${label}</button>`).join('');
      const primary=this.dialog.querySelector('[data-review-action="primary"]');
      primary.textContent=s.comparison?'Keep choices and review again':s.pending?(s.pending.rejection?'Compare current selections':'Retry saved split'):this.tab==='totals'?'Apply reviewed split':'Review totals';
      primary.disabled=s.busy||s.dirty||s.calculating||!s.draft||!!s.storageError||!!s.comparison?.unavailable||(!s.pending&&!s.comparison&&this.tab==='totals'&&(!s.preview?.ready||((s.preview.clearedPaid.length||s.preview.clearedRequests.length)&&!s.confirmPaymentResets)));
      if(!s.draft){this.body.innerHTML=`<p>${esc(s.busy?'Opening saved review…':s.message||s.error||s.storageError||'No saved review is open.')}</p>`;return;}
      this.dialog.querySelector('#host-review-title').textContent='Review split · '+(s.draft.baseline.owner.state.checks.checks.find(c=>c.id===s.activeId)?.name||s.activeId);
      if(inputs&&focused.matches('[data-review-field="name"]')&&this.body.contains(focused))return;
      let content='';try{content=this.tab==='compare'&&s.comparison?this.comparison():this.tab==='items'?this.items():this.tab==='totals'?this.totals():this.guests();}catch(error){content=`<p role="alert">${esc(error.message)}</p>`;}
      const issues=s.preview?.issues||[];const actions=this.button('Refresh / compare','refresh','',s.busy||!!s.pending&&!s.pending.rejection)+this.button('Export recovery copy','export','',s.busy)+this.button('Reload saved choices','reload','',s.busy)+this.button('Discard saved review','discard','',s.busy||!!s.pending&&!s.pending.rejection)+(s.dirty?this.button('Retry saving choices','save-working','',s.busy):'');
      this.body.innerHTML=`${message?`<p class="host-review-detail" ${s.error||s.storageError?'role="alert"':''}>${esc(message)}</p>`:''}<div class="host-review-actions">${actions}</div>${this.confirm?`<section class="host-review-card" role="alert"><p>${esc(this.confirm==='reload'?'Replace unsaved on-screen choices with the saved review? Export first to keep a copy.':this.confirm==='restart'?'Start this review again using the current check? Existing choices will be replaced.':'Discard this saved review? An uncertain submitted request cannot be discarded.')}</p>${this.button('Confirm','confirm',`data-review-key="confirm"`,s.busy)} ${this.button('Cancel','cancel-confirm')}</section>`:''}${s.pending?`<p>Saved financial action: ${s.pending.rejection?'rejected; compare before retrying':'outcome uncertain; retry sends the original request'}. Editing is locked until this is resolved.</p>`:''}${content}${issues.length?`<section class="host-review-card"><h3>Resolve before applying</h3><ul>${issues.map(i=>`<li>${esc(i.message)}</li>`).join('')}</ul></section>`:''}`;
      this.body.scrollTop=scroll;
      if(focusKey&&hadFocus){const next=[...this.dialog.querySelectorAll('[data-review-key]')].find(e=>e.dataset.reviewKey===focusKey);if(next&&!next.disabled){next.focus({preventScroll:true});if(selection)next.setSelectionRange(...selection);}}
    }
    async click(event){const tab=event.target.closest('[data-review-tab]');if(tab){this.tab=tab.dataset.reviewTab;this.render();return;}
      const button=event.target.closest('[data-review-action]');if(!button||button.disabled)return;const action=button.dataset.reviewAction,s=this.s;event.preventDefault();
      if(action==='close'){this.close();return;}
      if(['reload','restart','discard'].includes(action)){this.confirm=action;this.render();return;}
      if(action==='cancel-confirm'){this.confirm=null;this.render();return;}
      if(action==='confirm'){const kind=this.confirm;this.confirm=null;if(kind==='reload')await s.reloadSaved();else if(kind==='restart')await s.adopt(false);else if(kind==='discard')await s.discard();this.render();return;}
      if(action==='refresh')await s.refresh();
      if(action==='save-working')await s.saveWorking();
      if(action==='primary'){if(s.comparison)await s.adopt(true);else if(s.pending){if(s.pending.rejection)await s.refresh();else await s.retry();}else if(this.tab!=='totals'){this.tab='totals';this.render();}else await s.apply();}
      if(action==='export'){try{const url=URL.createObjectURL(new Blob([s.export()],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='guest-split-review.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);s.message='Recovery copy downloaded without bearer links or credentials.';}catch(error){s.error=error.message;}}
      if(action==='forget-source')s.edit(p=>{delete p.choices[button.dataset.source];});
      if(action==='forget-item')s.edit(p=>{delete p.manualByItem[button.dataset.item];});
      if(action==='manual-confirm')s.edit(p=>{const row=s.preview?.items.find(i=>i.id===button.dataset.item);p.manualByItem[button.dataset.item]=copy(row?.manual||[]);});
      this.render();
    }
    input(event){const field=event.target.dataset.reviewField;if(!field)return;if(field==='name'&&event.type!=='input')return;const el=event.target,s=this.s,key=el.dataset.source;
      if(field==='payment-confirm'){if(!s.editable||s.dirty||s.calculating)return;s.confirmPaymentResets=el.checked;this.render();return;}
      s.edit(plan=>{
        if(field==='action')plan.choices[key]={action:el.value,...(el.value==='APPLY'?{participantId:null}:{})};
        if(field==='action'&&!el.value)delete plan.choices[key];
        if(field==='target'){let id=el.value||null;if(id==='__new__'){id='guest-'+Array.from(crypto.getRandomValues(new Uint8Array(16)),v=>v.toString(16).padStart(2,'0')).join('');plan.newParticipants.push({id,name:this.sources().find(s=>s.id===key)?.source.name||'',linkedPersonId:null});}plan.choices[key].participantId=id;}
        if(field==='name')plan.newParticipants.find(p=>p.id===el.dataset.person).name=el.value;
        if(field==='linked')plan.newParticipants.find(p=>p.id===el.dataset.person).linkedPersonId=el.value||null;
        if(field==='removed')plan.choices[key].acceptRemovedItems=el.checked;
        if(field==='manual'){const item=el.dataset.item,manual=copy(plan.manualByItem[item]??s.preview?.items.find(i=>i.id===item)?.manual??[]);plan.manualByItem[item]=el.checked?uniq([...manual,el.dataset.person]):manual.filter(id=>id!==el.dataset.person);}
      });if(field!=='name')this.render();
    }
  }
  root.BillHiveCheckReviewPage={Page,calculator};
})(globalThis);
