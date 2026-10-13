'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Decimal=require('../decimal-json');
const {mergeChanges,validateTrip}=require('../tripSharing');

test('trip merges keep exact decimal tokens when another field changes',()=>{
  const base=Decimal.parse('{"id":"trip","notes":"old","expenses":[{"id":"e","amount":1234567890.123456789,"name":"Hotel"}]}');
  const edited=Decimal.parse(JSON.stringify(base));edited.notes='new';
  const latest=Decimal.parse(JSON.stringify(base));latest.expenses[0].name='Renamed';
  const result=mergeChanges(base,edited,latest);
  assert.equal(String(result.expenses[0].amount),'1234567890.123456789');assert.equal(result.expenses[0].name,'Renamed');assert.equal(result.notes,'new');
  const changed=Decimal.parse(JSON.stringify(edited).replace('1234567890.123456789','1234567890.123456788'));
  assert.equal(String(mergeChanges(base,changed,latest).expenses[0].amount),'1234567890.123456788');
});

test('trip validation rejects malformed payer, split and settlement amounts before merging',()=>{
  const base={id:'trip',members:[{id:'host',name:'Host'}],expenses:[{id:'e',name:'Hotel',amount:10,paidByAmounts:{host:10},splitBetweenIds:[]}],settlements:[]};
  for(const change of [t=>t.expenses[0].paidByAmounts.host='10',t=>t.expenses[0].amount=-1,
    t=>t.expenses[0].splitBetweenIds=['missing'],t=>t.settlements=[{id:'s',fromMemberId:'host',toMemberId:'host',amount:10}]]) {
    const edited=structuredClone(base);change(edited);assert.throws(()=>validateTrip(edited,'trip'));
  }
});
