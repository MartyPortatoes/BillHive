'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),R=require('../public/check-claim-review');
const fixtures=require('./fixtures/check-claim-review-parity.json');
const copy=structuredClone,base=copy(fixtures.cases[0].check),guest=copy(fixtures.cases[0].sources[0]);
const plan=(sources=[guest],targets=['a'],manualByItem={})=>({choices:Object.fromEntries(sources.map((s,i)=>[R.sourceId(s),{action:'APPLY',participantId:targets[i]}])),manualByItem,newParticipants:[]});
const preview=(check=base,sources=[guest],choices=plan())=>R.preview(check,'USD',sources,choices);
for(const f of fixtures.cases)test('shared Android/browser fixture: '+f.name,()=>{
  assert.deepEqual(f.sources.map(R.sourceId),f.sourceIds);const before=copy(f.check),v=R.preview(f.check,f.currency,f.sources,f.plan);
  assert.equal(v.ready,true,JSON.stringify(v.issues));assert.deepEqual(v.after.totals,f.expected.totals);assert.equal(v.after.grandTotal,f.expected.grandTotal);
  assert.deepEqual(Object.fromEntries(v.proposal.items.map(i=>[i.id,i.sharedByParticipantIds])),f.expected.assignments);
  assert.deepEqual(v.clearedPaid,f.expected.clearedPaid);assert.deepEqual(v.clearedRequests,f.expected.clearedRequests);assert.deepEqual(f.check,before);
  assert.deepEqual(v.proposal.futureField,before.futureField);R.ledger(v.proposal);
});
test('names never map automatically; payment reset confirmation is mandatory',()=>{
  const f=fixtures.cases[0];assert.equal(preview(base,[guest],R.seed(base)).ready,false);
  const view=preview(base,[guest],f.plan);assert.throws(()=>R.confirmed(view),/payment statuses/);assert.deepEqual(R.confirmed(view,true).paidParticipantIds,[]);
});
test('withdrawal retains overlapping manual and other-guest contributions',()=>{
  const second={...guest,claimantId:'b'.repeat(64)},sources=[guest,second],old=R.confirmed(preview(base,sources,plan(sources,['a','a'],{meal:[]})),true);
  const withdrawal={...guest,itemIds:[]},choices=R.seed(old);choices.choices[R.sourceId(guest)]={action:'APPLY',participantId:'a'};
  const result=R.confirmed(preview(old,[withdrawal,second],choices),true);assert.deepEqual(result.items[0].sharedByParticipantIds,['a']);
  const manual=R.confirmed(preview(),true),next=R.confirmed(preview(manual,[withdrawal]),true);assert.deepEqual(next.items[0].sharedByParticipantIds,['a','b']);
});
test('withdrawal cannot turn an empty explicit split into everyone',()=>{
  const old=R.confirmed(preview(base,[guest],plan([guest],['a'],{meal:[]})),true),withdrawal={...guest,itemIds:[]};
  assert.equal(preview(old,[withdrawal]).ready,false);assert.equal(preview(old,[withdrawal],plan([withdrawal],['a'],{meal:['b']})).ready,true);
});
test('new rotated identities need choices while prior contributions persist',()=>{
  const old=R.confirmed(preview(base,[guest],plan([guest],['a'],{meal:[]})),true),newGuest={...guest,shareId:'2'.repeat(64)},choices=R.seed(old);
  assert.notEqual(R.sourceId(guest),R.sourceId(newGuest));assert.equal(preview(old,[newGuest],choices).ready,false);
  choices.choices[R.sourceId(newGuest)]={action:'REMOVE'};assert.deepEqual(R.confirmed(preview(old,[newGuest],choices),true).items,old.items);
  choices.choices[R.sourceId(guest)]={action:'REMOVE'};choices.choices[R.sourceId(newGuest)]={action:'APPLY',participantId:'b'};
  assert.deepEqual(R.confirmed(preview(old,[newGuest],choices),true).items[0].sharedByParticipantIds,['b']);
});
test('changed manual assignments and removed participants require scoped review',()=>{
  const old=R.confirmed(preview(),true);old.items[0].sharedByParticipantIds=['b'];const choices=R.seed(old);
  assert.equal(preview(old,[guest],choices).ready,false);choices.manualByItem.meal=['b'];assert.equal(preview(old,[guest],choices).ready,true);
  old.participants=old.participants.filter(p=>p.id!=='a');assert.equal(preview(old,[guest],choices).ready,false);
});
test('removed selected items need acknowledgement and cannot return through stale provenance',()=>{
  const removed={...guest,itemIds:['meal','missing','meal']},choices=plan([removed]);assert.equal(preview(base,[removed],choices).ready,false);
  choices.choices[R.sourceId(removed)].acceptRemovedItems=true;const old=R.confirmed(preview(base,[removed],choices),true);
  old.items=old.items.filter(i=>i.id!=='meal');const pruned=R.confirmed(preview(old,[],R.seed(old)),true);assert.deepEqual(pruned.claimApplications.selections[0].itemIds,[]);
  pruned.items.push({id:'meal',name:'Restored',price:9,sharedByParticipantIds:['b']});assert.deepEqual(R.confirmed(preview(pruned,[],R.seed(pruned)),true).items[1].sharedByParticipantIds,['b']);
});
test('legacy names and occurrences use separate identities, native renames do not',()=>{
  const legacy={...guest,claimantId:null};assert.notEqual(R.sourceId(legacy),R.sourceId({...legacy,legacyOccurrence:1}));
  assert.notEqual(R.sourceId(legacy),R.sourceId({...legacy,name:'Renamed'}));assert.equal(R.sourceId(guest),R.sourceId({...guest,name:'Renamed',itemIds:[]}));
  const snapshot={share:{shareId:guest.shareId,claims:[1,2].map(()=>({claimerName:'Alex',itemIds:['meal'],claimedAt:'2026-09-27T12:00:00.000Z'}))}};
  assert.deepEqual(R.sources(snapshot).map(s=>s.legacyOccurrence),[0,1]);assert.equal(R.sourceId(R.sources(snapshot)[0]),R.sourceId(legacy));
  assert.equal(R.instant('2026-09-27T08:00:00.1234567-04:00'),'2026-09-27T12:00:00.123456700Z');assert.throws(()=>R.instant('2026-02-30T12:00:00Z'));
});
test('unsupported or forged provenance cannot erase manual assignments',()=>{
  const old=R.confirmed(preview(),true);old.claimApplications.manualByItem.meal=[];assert.throws(()=>R.seed(old),/manual and guest/);
  for(const value of [{version:2},{...R.confirmed(preview(),true).claimApplications,futureMeaning:true}])assert.throws(()=>R.seed({...base,claimApplications:value}),/unsupported/);
});
test('linked people and unused additions are explicitly validated',()=>{
  const p=copy(fixtures.cases[0].plan);p.newParticipants[0].linkedPersonId='person';assert.equal(preview(base,[guest],p).ready,false);
  assert.equal(R.preview(base,'USD',[guest],p,[{id:'person',name:'Different'}]).ready,true);
  p.newParticipants[0].linkedPersonId=null;p.newParticipants.push({id:'unused',name:'Unused'});assert.equal(preview(base,[guest],p).proposal.participants.length,3);
});
test('money stays exact across tiny values, adjustment ties and large four-decimal amounts',()=>{
  const c={...base,items:[{id:'meal',price:'0.005',sharedByParticipantIds:[]}]};assert.equal(R.breakdown(c).grandTotal,'1');
  c.items[0].price='0.0000000000000000001';assert.equal(R.breakdown(c).grandTotal,'0');
  c.items[0].price='200000000';assert.equal(R.breakdown(c,'CLF').grandTotal,'2000000000000');
  c.items[0].price='200000000.0001';assert.throws(()=>R.breakdown(c,'CLF'),/out of range/);
  c.items[0].price='1000000000000';c.taxAmount='1';assert.throws(()=>R.breakdown(c),/out of range/);c.items[0].price=-1;assert.throws(()=>R.breakdown(c));
});
test('claim order cannot move a remainder penny on repeated application',()=>{
  const f=fixtures.cases.find(f=>f.name==='stable penny recipient'),old=R.confirmed(R.preview(f.check,f.currency,f.sources,f.plan),true);
  assert.deepEqual(R.confirmed(R.preview(old,f.currency,[...f.sources].reverse(),R.seed(old)),true),old);
});
test('exact minor-unit labels preserve cents and four decimal places without Number conversion',()=>{
  assert.equal(R.formatUnits('1',2,'USD','en-US'),'USD 0.01');assert.equal(R.formatUnits('10000000000000001',4,'CLF','en-US'),'CLF 1,000,000,000,000.0001');assert.equal(R.formatUnits('10001',3,'KWD','de-DE'),'KWD 10,001');
});

test('receipt totals use exact half-up currency units before participants exist',()=>{
  const check={items:[{id:'meal',price:'1.005'}],participants:[]};
  assert.deepEqual(R.receipt(check,'USD'),{digits:2,grandTotal:'101'});
  assert.throws(()=>R.breakdown(check,'USD'),/participant/);
  for(const [currency,price,units] of [['JPY','10.5','11'],['KWD','0.003','3'],['CLF','0.0003','3']]) {
    check.items[0].price=price;assert.equal(R.receipt(check,currency).grandTotal,units);
  }
  check.items[0].price='1000000000001';assert.throws(()=>R.receipt(check,'USD'),/range/);
});
test('ordinary page resolves automatic currency consistently with sharing regardless of device locale',()=>{
  const fs=require('node:fs'),vm=require('node:vm'),page=fs.readFileSync(require.resolve('../index.html'),'utf8');
  const names=['getResolvedCurrency','checkExactReceipt','checkReceiptAmount','checkExactAmounts','checkShareAmount'];
  const code=names.map(name=>{const start=page.indexOf('function '+name+'(');assert.ok(start>=0);const end=page.indexOf('\n}',start);assert.ok(end>start);return page.slice(start,end+2);}).join('\n');
  const context=vm.createContext({S:{settings:{currencyCode:''}},BillHiveCheckReview:R,navigator:{language:'ja-JP'},detectCurrency:()=> 'JPY'});
  vm.runInContext(code,context);assert.equal(context.getResolvedCurrency(),'USD');
  const check={items:[{id:'meal',price:'10.005',sharedByParticipantIds:[]}],participants:[{id:'a'},{id:'b'}]};
  assert.equal(context.checkReceiptAmount(context.checkExactReceipt(check)),'USD 10.01');
  context.S.settings.currencyCode='KWD';check.items[0].price='0.003';
  const split=context.checkExactAmounts(check);assert.equal(context.checkShareAmount(split,'b'),'KWD 0.001');
  assert.equal(context.checkReceiptAmount(context.checkExactReceipt(check)),'KWD 0.003');
  assert.equal(context.S.settings.currencyCode,'KWD');
});
