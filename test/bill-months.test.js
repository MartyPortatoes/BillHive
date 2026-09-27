const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the browser's actual carry-forward function without booting the DOM.
const page = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const start = page.indexOf('function autoFillPreservedBills()');
const end = page.indexOf('function toast(', start);
assert.ok(start >= 0 && end > start);
const source = page.slice(start, end);
function fixture(monthly, { key = '2026-01', preserve = true } = {}) {
  const writes = [];
  const S = { bills: [{ id: 'rent', preserve, lines: [{ id: 'active' }] }], monthly,
    checklist: { '2026-01': { paid_rent: true } },
    requestDates: { '2026-01': { alice: '2026-01-02T00:00:00Z' } } };
  const context = vm.createContext({ S, monthKey: () => key,
    saveMonthNow: (month, data) => writes.push({ month, data: structuredClone(data) }) });
  vm.runInContext(source, context);
  return { S, writes, carry: () => context.autoFillPreservedBills() };
}

test('carry-forward protects zero totals and zero active or retired share amounts', () => {
  for (const destination of [
    { totals: { rent: 0 } },
    { amounts: { rent: { active: 0 } } },
    { amounts: { rent: { retired: 0 } } },
  ]) {
    const f = fixture({ '2025-12': { totals: { rent: 100 }, amounts: { rent: { active: 50 } } },
      '2026-01': destination });
    const before = structuredClone(f.S);
    f.carry();
    assert.deepEqual(f.S, before);
    assert.deepEqual(f.writes, []);
  }
});

test('carry-forward copies zero and all source lines across January once, preserving metadata', () => {
  const previous = { totals: { rent: 0 }, amounts: { rent: { active: 0, retired: 12 } }, _myTotal: 123 };
  const f = fixture({ '2025-12': previous,
    '2026-01': { totals: { other: 7 }, amounts: {}, _myTotal: 7, payReceived: { alice: true }, future: 'keep' } });
  const before = structuredClone(f.S);
  f.carry();
  const expected = { totals: { rent: 0, other: 7 }, amounts: { rent: { active: 0, retired: 12 } },
    _myTotal: 7, payReceived: { alice: true }, future: 'keep' };
  assert.deepEqual(structuredClone(f.S.monthly['2026-01']), expected);
  assert.deepEqual(f.S.monthly['2025-12'], before.monthly['2025-12']);
  assert.deepEqual(f.S.checklist, before.checklist);
  assert.deepEqual(f.S.requestDates, before.requestDates);
  assert.deepEqual(f.writes, [{ month: '2026-01', data: expected }]);
  f.carry();
  assert.equal(f.writes.length, 1);
  f.S.monthly['2026-01'].amounts.rent.active = 10;
  assert.equal(previous.amounts.rent.active, 0, 'source shares must not alias the destination');
});

test('fixed-only zero source fills an empty share map without inventing a total', () => {
  const f = fixture({ '2025-12': { amounts: { rent: { active: 0 } } },
    '2026-01': { amounts: { rent: {} } } });
  f.carry();
  assert.deepEqual(structuredClone(f.S.monthly['2026-01']), { amounts: { rent: { active: 0 } } });
  assert.equal(f.writes.length, 1);
});

test('empty or disabled sources do not create or persist an empty destination month', () => {
  for (const previous of [{}, { totals: {}, amounts: { rent: {} } }]) {
    const f = fixture({ '2025-12': previous });
    f.carry();
    assert.equal(f.S.monthly['2026-01'], undefined);
    assert.deepEqual(f.writes, []);
  }
  const disabled = fixture({ '2025-12': { totals: { rent: 100 } } }, { preserve: false });
  disabled.carry();
  assert.equal(disabled.S.monthly['2026-01'], undefined);
  assert.deepEqual(disabled.writes, []);
});

test('only the preceding calendar month supplies carry-forward', () => {
  const f = fixture({ '2025-11': { totals: { rent: 200 } }, '2026-01': { totals: { rent: 90 } } },
    { key: '2026-03' });
  f.carry();
  assert.equal(f.S.monthly['2026-03'], undefined);
  assert.deepEqual(f.writes, []);
  f.S.monthly['2026-02'] = { totals: { rent: 0 } };
  f.carry();
  assert.equal(f.S.monthly['2026-03'].totals.rent, 0);
});

test('a destination with omitted totals or amounts accepts the corresponding source fields', () => {
  const f = fixture({ '2025-12': { totals: { rent: 10 }, amounts: { rent: { active: 4 } } },
    '2026-01': { future: 'keep' } });
  f.carry();
  assert.deepEqual(structuredClone(f.S.monthly['2026-01']),
    { future: 'keep', totals: { rent: 10 }, amounts: { rent: { active: 4 } } });
  assert.equal(f.writes.length, 1);
});
