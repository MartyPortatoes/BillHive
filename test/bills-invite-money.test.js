'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const Decimal = require('../decimal-json');
const {owes} = require('../bills-invite-money');
const people = [{id:'me',name:'Me'},{id:'guest',name:'Guest'}];
test('Bills invites retain large four-digit units and exact fixed remainders', () => {
  const bill = {id:'rent',name:'Rent',splitType:'fixed',paidById:'me',remainderLineId:'me-line',lines:[{id:'guest-line',personId:'guest'},{id:'me-line',personId:'me'}]};
  const month = Decimal.parse('{"totals":{"rent":999999999999.0003},"amounts":{"rent":{"guest-line":999999999999.0003}}}');
  const result = owes(people,[bill],month,'CLF');
  assert.equal(String(result.guest.total),'999999999999.0003');
  assert.equal(String(result.guest.bills[0].amount),'999999999999.0003');
});
test('Bills invites use the selected zero, three and four-digit currency', () => {
  const bill = {id:'rent',name:'Rent',splitType:'fixed',paidById:'me',remainderLineId:'guest-line',lines:[{id:'me-line',personId:'me'},{id:'guest-line',personId:'guest'}]};
  const month = {totals:{rent:1.2345},amounts:{rent:{'me-line':0}}};
  for (const [currency,expected] of [['JPY','1'],['KWD','1.235'],['CLF','1.2345']])
    assert.equal(String(owes(people,[bill],month,currency).guest.total),expected);
});
test('weighted invites allocate large totals with exact largest remainders and stable tie order', () => {
  const bill = Decimal.parse('{"id":"rent","name":"Rent","splitType":"pct","paidById":"me","lines":[{"id":"a","personId":"guest","value":1.00000000000000000001},{"id":"b","personId":"me","value":1}]}');
  const month = {totals:{rent:0.03},amounts:{}};
  assert.equal(owes(people,[bill],month,'USD').guest.total,0.02);
  const large = Decimal.parse('{"totals":{"rent":999999999999.0003},"amounts":{}}');
  assert.equal(String(owes(people,[bill],large,'CLF').guest.total),'499999999999.5002');
});
test('even shares keep the native last-line remainder convention and signed collection direction', () => {
  const bill = {id:'rent',name:'Rent',splitType:'pct',paidById:'guest',lines:[{id:'a',personId:'me',value:50},{id:'b',personId:'guest',value:50}]};
  assert.equal(owes(people,[bill],{totals:{rent:0.03},amounts:{}},'USD').guest.total,-0.01);
});
test('pathological imported exponents remain storable but cannot force an unbounded invite calculation', () => {
  const bill = Decimal.parse('{"id":"rent","splitType":"pct","lines":[{"id":"a","personId":"guest","value":1e-999999999},{"id":"b","personId":"me","value":1}]}');
  assert.throws(() => owes(people,[bill],{totals:{rent:1},amounts:{}},'USD'),error => error.code === 'BILL_PRECISION_UNSUPPORTED');
  assert.ok(JSON.stringify(bill).includes('1e-999999999'));
});
test('legacy numeric weight text remains usable without changing the saved records', () => {
  const bill = {id:'rent',name:'Rent',splitType:'pct',lines:[{id:'a',personId:'guest',value:'1.00000000000000000001'},{id:'b',personId:'me',value:'1'}]};
  assert.equal(owes(people,[bill],{totals:{rent:0.03},amounts:{}},'USD').guest.total,0.02);
  assert.equal(bill.lines[0].value,'1.00000000000000000001');
});
