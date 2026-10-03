'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const Decimal = require('../decimal-json');
const Data = require('../public/data-contract');

test('large CLF amounts, exact rates, weights and unknown numbers retain JSON numeric literals', () => {
  const source = '{"total":999999999999.0003,"rate":1.333333333333333333333333333333,"weight":9007199254740993,"future":[0.00000000000000000000000000000000000123456789]}';
  const data = Decimal.parse(source);
  const encoded = JSON.stringify(data);
  for (const token of ['999999999999.0003','1.333333333333333333333333333333','9007199254740993']) assert.ok(encoded.includes(token));
  assert.equal(Decimal.canonical(Decimal.parse(encoded)), Decimal.canonical(Decimal.parse(source)));
  assert.equal(Decimal.exact(data.total), true);
  assert.equal(Decimal.record(data.total), false);
  assert.equal(Decimal.number(data.total), true);
  assert.throws(() => data.total * 100, /exact decimal operations/);
});
test('ordinary browser numbers keep their type and harmless trailing zeros do not require a new client', () => {
  const data = Decimal.parse('{"a":1.23000,"b":1200,"c":1e-7,"d":-0}');
  assert.deepEqual(data, {a:1.23,b:1200,c:1e-7,d:-0});
  assert.equal(Decimal.containsExact(data), false);
});
test('hashes distinguish adjacent large decimals but normalize equivalent number notation', () => {
  const a = Decimal.parse('{"amount":999999999999.0003}');
  const b = Decimal.parse('{"amount":999999999999.0002}');
  const c = Decimal.parse('{"amount":999999999999000300e-6}');
  assert.notEqual(Decimal.canonical(a), Decimal.canonical(b));
  assert.equal(Decimal.canonical(a), Decimal.canonical(c));
  assert.equal(Decimal.legacyCanonical(a), Decimal.legacyCanonical(b));
});
test('range validation checks exact boundaries and positive underflowing rates', () => {
  assert.equal(Decimal.amount(Decimal.parse('1000000000000')), true);
  assert.equal(Decimal.amount(Decimal.parse('1000000000000.00000000000000000001')), false);
  assert.equal(Decimal.amount(Decimal.parse('-1e-400')), false);
  assert.equal(Decimal.compare(Decimal.parse('1e-400'), 0), 1);
  assert.equal(Decimal.compare(Decimal.parse('-999999999999.0003'), Decimal.parse('-999999999999.0002')), -1);
  assert.equal(Decimal.compare(Decimal.parse('999999999999.000300'), Decimal.parse('9999999999990003e-4')), 0);
});
test('currency activity formatting rounds once in decimal space and never truncates large units', () => {
  for (const [source,digits,expected] of [
    ['999999999999.0003',4,'999999999999.0003'], ['999999999999.99995',4,'1000000000000.0000'],
    ['1.005',2,'1.01'], ['1.2345',3,'1.235'], ['-1.005',2,'-1.01'], ['1.5',0,'2'],
    ['1e-400',4,'0.0000'], ['5e-5',4,'0.0001'], ['4e-5',4,'0.0000']
  ]) assert.equal(Decimal.fixed(Decimal.parse(source),digits),expected);
});
test('data validation treats exact numbers as scalar values while retaining unsafe-key checks', () => {
  const data = Decimal.parse('{"2026-10":{"totals":{"rent":999999999999.0003},"amounts":{"rent":{"line":0.123456789012345678901}}}}');
  assert.equal(Data.months(data), data);
  assert.throws(() => Data.state(Decimal.parse('{"future":{"__proto__":1}}')), /Unsafe data key/);
  assert.throws(() => Data.month({totals:{rent:'999999999999.0003'}}), /Invalid bill amount/);
  assert.throws(() => Data.state(Decimal.parse('999999999999.0003')), /State must be an object/);
});
test('malformed and non-finite JSON cannot become money or bypass validation', () => {
  for (const source of ['NaN','Infinity','1e400','{"amount":01}','{"amount":1.}','{"amount":1e}'])
    assert.throws(() => Decimal.parse(source));
  assert.equal(Decimal.number(NaN), false);
  assert.equal(Decimal.number('1.23'), false);
  assert.equal(Decimal.number({source:'1.23',toJSON:()=>1.23}), false);
});
