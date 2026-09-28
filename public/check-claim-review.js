/* Financial review compatible with Android CheckClaimReview. Names are never identities. */
(function(root,factory){
  const api=factory(typeof module==='object'&&module.exports?require('./check-claim-client'):root.BillHiveCheckClaims);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.BillHiveCheckReview=api;
})(globalThis,function(Shared){
  'use strict';
  const copy=structuredClone, same=(a,b)=>Shared.canonical(a)===Shared.canonical(b);
  const requireValue=(ok,message)=>{if(!ok)throw new Error(message);};
  const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
  const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
  const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
  const unique=values=>[...new Set(values)];
  const list=(v,f)=>Array.isArray(v)&&v.every(f);
  const ids=v=>list(v,id)&&unique(v).length===v.length;
  const recordEntries=(v,f)=>object(v)&&Object.entries(v).every(([key,value])=>id(key)&&f(value));
  const only=(v,keys)=>object(v)&&Object.keys(v).every(k=>keys.includes(k));
  function instant(value) {
    // Instant.toString uses groups of three fractional digits; retain micro/nanoseconds.
    const m=typeof value==='string'&&value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/);
    requireValue(m&&Number.isFinite(Date.parse(m[1]+m[3])),'A selection has an invalid date. Its saved record is kept.');
    requireValue(new Date(m[1]+'Z').toISOString().slice(0,19)===m[1],'A selection has an invalid calendar date.');
    let fraction=(m[2]||'').padEnd(9,'0');while(fraction.endsWith('000'))fraction=fraction.slice(0,-3);
    return new Date(m[1]+m[3]).toISOString().slice(0,-5)+(fraction?'.'+fraction:'')+'Z';
  }
  function validateSource(s) {
    const occurrence=s?.legacyOccurrence??0;
    requireValue(only(s,['shareId','claimantId','name','itemIds','claimedAt','legacyOccurrence'])&&hash(s.shareId)&&(s.claimantId===null||hash(s.claimantId))&&typeof s.name==='string'&&list(s.itemIds,id)&&
      Number.isSafeInteger(occurrence)&&occurrence>=0&&(s.claimantId===null||occurrence===0),'Invalid saved guest identity.');
    instant(s.claimedAt);return s;
  }
  function sourceId(source) {
    const s=validateSource(source);
    return Shared.sha256(s.shareId+'\0'+(s.claimantId!==null?'native\0'+s.claimantId:
      'legacy\0'+JSON.stringify([s.name,s.claimedAt,JSON.stringify(s.itemIds),String(s.legacyOccurrence??0)])));
  }
  function sources(snapshot) {
    const seen=new Map();
    return (snapshot.share?.claims||[]).map(c=>{
      const source={shareId:snapshot.share.shareId,claimantId:c.claimantId??null,name:c.claimerName,itemIds:copy(c.itemIds),claimedAt:instant(c.claimedAt),legacyOccurrence:0};
      if(source.claimantId===null){const key=sourceId(source),occurrence=seen.get(key)||0;seen.set(key,occurrence+1);source.legacyOccurrence=occurrence;}
      validateSource(source);return source;
    });
  }
  function ledger(check) {
    const value=check.claimApplications;if(value==null)return null;
    requireValue(only(value,['version','checkId','manualByItem','appliedByItem','selections'])&&value.version===1&&value.checkId===check.id&&recordEntries(value.manualByItem,ids)&&recordEntries(value.appliedByItem,ids)&&
      same(Object.keys(value.manualByItem).sort(),Object.keys(value.appliedByItem).sort())&&Array.isArray(value.selections),'This check uses an unsupported guest-assignment history. Its saved data is kept.');
    for(const s of value.selections){validateSource(s.source);requireValue(only(s,['source','participantId','itemIds'])&&(s.participantId===null||id(s.participantId))&&ids(s.itemIds)&&
      (s.participantId!==null||!s.itemIds.length)&&s.itemIds.every(i=>Object.hasOwn(value.appliedByItem,i)),'Invalid saved guest contribution.');}
    requireValue(unique(value.selections.map(s=>sourceId(s.source))).length===value.selections.length,'Repeated saved guest identities.');
    for(const [item,people]of Object.entries(value.appliedByItem)){
      const contributors=value.selections.filter(s=>s.itemIds.includes(item)).map(s=>s.participantId).filter(Boolean);
      requireValue(people.length&&same([...people].sort(),unique([...value.manualByItem[item],...contributors]).sort()),'Saved manual and guest assignments do not match. Review the original record.');
    }
    return value;
  }
  function validatePlan(plan) {
    requireValue(only(plan,['choices','manualByItem','newParticipants'])&&object(plan.choices)&&recordEntries(plan.manualByItem,ids)&&Array.isArray(plan.newParticipants),'Invalid saved review choices.');
    for(const [key,c]of Object.entries(plan.choices))requireValue(hash(key)&&only(c,['action','participantId','acceptRemovedItems'])&&['APPLY','KEEP_PREVIOUS','REMOVE'].includes(c.action)&&
      (c.participantId==null||id(c.participantId))&&(c.acceptRemovedItems===undefined||typeof c.acceptRemovedItems==='boolean')&&(c.action!=='REMOVE'||c.participantId==null),'Invalid guest assignment choice.');
    for(const p of plan.newParticipants)requireValue(only(p,['id','name','linkedPersonId'])&&id(p.id)&&typeof p.name==='string'&&(p.linkedPersonId==null||id(p.linkedPersonId)),'Invalid new participant choice.');
    return plan;
  }
  function seed(check) {const prior=ledger(check);return {choices:Object.fromEntries((prior?.selections||[]).map(s=>[sourceId(s.source),{action:'KEEP_PREVIOUS'}])),manualByItem:{},newParticipants:[]};}

  // Fixed decimal parsing and BigInt allocation avoid binary rounding in previews.
  function decimal(value) {
    requireValue(typeof value==='number'||typeof value==='string','Invalid check amount.');
    const m=String(value).match(/^\+?(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
    requireValue(m&&m[1].length+(m[2]||'').length<=1000,'Invalid check amount.');
    const power=Number(m[3]||0)-(m[2]||'').length;
    requireValue(Number.isSafeInteger(power)&&Math.abs(power)<=1000,'Check amount is out of range.');
    const raw=BigInt(m[1]+(m[2]||''));
    const result=power<0?{value:raw,places:-power}:{value:raw*10n**BigInt(power),places:0};
    requireValue(result.value<=1000000000000n*10n**BigInt(result.places),'Check amount is out of range.');return result;
  }
  function digits(currency) {
    requireValue(typeof currency==='string'&&/^[A-Z]{3}$/.test(currency),'Invalid check currency.');
    const count=new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits;
    return count>=0&&count<=4?count:2;
  }
  function allocate(total,keys,weights=null) {
    requireValue(ids(keys),'Duplicate or invalid split participants.');
    if(!keys.length){requireValue(total===0n,'Assign a participant before splitting this item.');return {};}
    const sign=total<0n?-1n:1n,magnitude=total*sign,values=keys.map(k=>weights?.[k]||0n),sum=values.reduce((a,b)=>a+b,0n);
    requireValue(values.every(v=>v>=0n&&v<=1000000000000n),'Split weights are out of range.');
    if(sum===0n)return Object.fromEntries(keys.map((k,i)=>[k,sign*(magnitude/BigInt(keys.length)+(BigInt(i)<magnitude%BigInt(keys.length)?1n:0n))]));
    const bases=values.map(v=>v*magnitude/sum),remainders=values.map(v=>v*magnitude%sum);
    const remaining=Number(magnitude-bases.reduce((a,b)=>a+b,0n));
    keys.map((_,i)=>i).sort((a,b)=>remainders[a]===remainders[b]?a-b:remainders[a]>remainders[b]?-1:1).slice(0,remaining).forEach(i=>bases[i]++);
    return Object.fromEntries(keys.map((k,i)=>[k,bases[i]*sign]));
  }
  function effective(check,item) {const known=check.participants.map(p=>p.id),explicit=unique((item.sharedByParticipantIds||[]).filter(k=>known.includes(k)));return explicit.length?explicit:known;}
  function breakdown(check,currency='USD') {
    const places=digits(currency),amounts=[...check.items.map(item=>decimal(item.price??0)),...['taxAmount','tipAmount','serviceFeeAmount','discountAmount','compAmount'].map(k=>decimal(check[k]??0))];
    const precision=Math.max(places,...amounts.map(v=>v.places)),maximum=1000000000000n*10n**BigInt(precision),divisor=10n**BigInt(precision-places);
    const units=v=>(v+divisor/2n)/divisor,scaled=amounts.map(v=>v.value*10n**BigInt(precision-v.places));
    const people=check.participants.map(p=>p.id);requireValue(ids(people),'Invalid check participants.');
    const subtotals=Object.fromEntries(people.map(k=>[k,0n]));let subtotal=0n;
    for(const [index,item]of check.items.entries()){const price=scaled[index];subtotal+=price;
      for(const [k,v]of Object.entries(allocate(units(price),effective(check,item))))subtotals[k]+=v;}
    const [tax,tip,fee,discount,comp]=scaled.slice(check.items.length);
    requireValue(subtotal+tax+tip+fee+discount+comp<=maximum,'Check amounts are out of range.');
    const credit=discount+comp<subtotal?discount+comp:subtotal,grandTotal=units(subtotal-credit+tax+tip+fee),sum=Object.values(subtotals).reduce((a,b)=>a+b,0n);
    requireValue(sum!==0n||grandTotal===0n,'Add items before tax, tip or fees.');
    const adjustments=allocate(grandTotal-sum,[...people].sort(),subtotals);
    // Strings retain exact minor units even for four-decimal currencies beyond Number's safe range.
    return {digits:places,subtotals:Object.fromEntries(people.map(k=>[k,String(subtotals[k])])),totals:Object.fromEntries(people.map(k=>[k,String(subtotals[k]+adjustments[k])])),grandTotal:String(grandTotal)};
  }
  function preview(check,currency,current,plan,people=[]) {
    validatePlan(plan);requireValue(!check.isCompleted,'Reopen this check before applying guest selections.');
    requireValue(ids(check.items.map(i=>i.id))&&ids(check.participants.map(p=>p.id)),'Invalid check items or participants.');
    current.forEach(validateSource);requireValue(unique(current.map(s=>s.shareId)).length<=1&&unique(current.map(sourceId)).length===current.length,'Repeated or mixed guest identities.');
    const prior=ledger(check),incoming=new Map(current.map(s=>[sourceId(s),s])),previous=new Map((prior?.selections||[]).map(s=>[sourceId(s.source),s]));
    const sourceIds=unique([...previous.keys(),...[...incoming.keys()].sort()]),itemIds=check.items.map(i=>i.id),existing=new Map(check.participants.map(p=>[p.id,p])),additions=new Map(plan.newParticipants.map(p=>[p.id,p]));
    const issues=[],issue=(subject,message)=>issues.push({subject,message});
    if(Object.keys(plan.choices).some(k=>!sourceIds.includes(k)))issue('choices','A reviewed selection is no longer available. Review the current selections.');
    if(Object.keys(plan.manualByItem).some(k=>!itemIds.includes(k)))issue('items','An item with a reviewed assignment was removed. Review the remaining items.');
    if(additions.size!==plan.newParticipants.length||[...additions.keys()].some(k=>existing.has(k)))issue('participants','New participant identities conflict with this check.');
    const used=new Set(),retained=[],removedSelections={};
    function participant(key,subject){if(!key||!existing.has(key)&&!additions.has(key)){issue(subject,'Choose a current participant or explicitly create one for this selection.');return false;}if(additions.has(key))used.add(key);return true;}
    for(const key of sourceIds){const fresh=incoming.get(key),old=previous.get(key),choice=plan.choices[key],subject='claim:'+key;
      if(!choice){issue(subject,`Choose how to handle ${fresh?.name??old?.source.name??''}. Names do not identify participants.`);continue;}
      if(choice.action==='REMOVE'){retained.push({source:copy(fresh||old.source),participantId:null,itemIds:[]});continue;}
      if(choice.action==='KEEP_PREVIOUS'){
        if(!old){issue(subject,'This selection has no previously applied assignment. Choose a participant or ignore it.');continue;}
        const target=choice.participantId??old.participantId;if(target!==null&&!participant(target,subject))continue;
        const missing=old.itemIds.filter(k=>!itemIds.includes(k));if(missing.length)removedSelections[key]=missing;
        retained.push({...copy(old),participantId:target,itemIds:old.itemIds.filter(k=>itemIds.includes(k))});continue;
      }
      if(!fresh){issue(subject,'This selection belongs to an older or unavailable link. Keep or remove its previous assignment.');continue;}
      if(!participant(choice.participantId,subject))continue;
      const missing=unique(fresh.itemIds).filter(k=>!itemIds.includes(k));if(missing.length)removedSelections[key]=missing;
      if(missing.length&&!choice.acceptRemovedItems)issue(subject,'Some selected items were removed. Confirm using only the remaining items.');
      retained.push({source:copy(fresh),participantId:choice.participantId,itemIds:unique(fresh.itemIds).filter(k=>itemIds.includes(k))});
    }
    const manualByItem={},appliedByItem={};
    const items=check.items.map(item=>{
      const before=effective(check,item),last=prior?.appliedByItem[item.id],raw=item.sharedByParticipantIds||[];
      if((raw.some(k=>!existing.has(k))||last&&(!same(last,before)||!raw.length))&&!Object.hasOwn(plan.manualByItem,item.id))issue('item:'+item.id,`${item.name} has changed assignments. Explicitly review its manual participants before applying selections.`);
      const manual=plan.manualByItem[item.id]??prior?.manualByItem[item.id]??before;
      if(manual.some(k=>!existing.has(k)&&!additions.has(k)))issue('item:'+item.id,`Choose valid manual participants for ${item.name}.`);
      manual.filter(k=>additions.has(k)).forEach(k=>used.add(k));
      const contributed=new Set(retained.filter(s=>s.itemIds.includes(item.id)).map(s=>s.participantId).filter(Boolean));
      const contributions=unique([...before,...existing.keys(),...additions.keys()]).filter(k=>contributed.has(k)),proposed=unique([...manual,...contributions]);
      if(!proposed.length)issue('item:'+item.id,`Assign at least one participant to ${item.name}; an empty split would charge everyone.`);
      manualByItem[item.id]=copy(manual);appliedByItem[item.id]=proposed;
      return {id:item.id,previous:before,manual:copy(manual),contributed:contributions,proposed};
    });
    const fresh=plan.newParticipants.filter(p=>used.has(p.id));
    for(const p of fresh){if(!p.name.trim())issue('participant:'+p.id,'Enter a name for the new participant.');
      if(p.linkedPersonId!=null&&(!people.some(person=>person.id===p.linkedPersonId)||check.participants.some(person=>person.linkedPersonId===p.linkedPersonId)||fresh.filter(person=>person.linkedPersonId===p.linkedPersonId).length>1))issue('participant:'+p.id,'This household person is unavailable or already linked to a participant.');}
    let before=null;try{before=breakdown(check,currency);}catch{}
    const view={original:copy(check),proposal:null,before,after:null,items,issues,changedBalances:[],clearedPaid:[],clearedRequests:[],removedSelections,ready:false};
    if(issues.length)return view;
    const proposal=copy(check);proposal.participants.push(...fresh.map(p=>({...copy(p),name:p.name.trim(),linkedPersonId:p.linkedPersonId??null})));
    proposal.items=proposal.items.map(item=>({...item,sharedByParticipantIds:appliedByItem[item.id]}));
    proposal.claimApplications={checkId:check.id,manualByItem,appliedByItem,selections:retained,version:1};ledger(proposal);
    let after;try{after=breakdown(proposal,currency);}catch(error){issue('amounts',error.message);return view;}
    const changed=proposal.participants.map(p=>p.id).filter(k=>before===null||(before.totals[k]||'0')!==(after.totals[k]||'0'));
    const clearedPaid=(check.paidParticipantIds||[]).filter(k=>changed.includes(k)),clearedRequests=Object.keys(check.paymentRequestDates||{}).filter(k=>changed.includes(k));
    if(proposal.paidParticipantIds)proposal.paidParticipantIds=proposal.paidParticipantIds.filter(k=>!changed.includes(k));
    if(proposal.paymentRequestDates)for(const k of changed)delete proposal.paymentRequestDates[k];
    return {...view,proposal,after,changedBalances:changed,clearedPaid,clearedRequests,ready:true};
  }
  function confirmed(view,confirmPaymentResets=false){requireValue(view.ready&&view.proposal,'Review the selections before applying them.');requireValue(confirmPaymentResets||!view.clearedPaid.length&&!view.clearedRequests.length,'Confirm the payment statuses that will be cleared after these balance changes.');return copy(view.proposal);}
  function formatUnits(value,places,currency,locale){const units=BigInt(value),negative=units<0n,absolute=negative?-units:units,divisor=10n**BigInt(places),whole=new Intl.NumberFormat(locale).format(absolute/divisor),decimal=new Intl.NumberFormat(locale).formatToParts(1.1).find(p=>p.type==='decimal')?.value||'.';return `${currency} ${negative?'-':''}${whole}${places?decimal+String(absolute%divisor).padStart(places,'0'):''}`;}
  return {instant,sourceId,sources,validateSource,ledger,validatePlan,seed,breakdown,preview,confirmed,formatUnits};
});
