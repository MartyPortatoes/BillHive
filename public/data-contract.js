/* Shared, fail-closed validation for editable web state and server writes. */
(function (root) {
  'use strict';
  const Decimal = typeof module !== 'undefined' && module.exports ? require('../decimal-json') : null;
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && !Decimal?.exact(value);
  const number = value => Decimal ? Decimal.number(value) : typeof value === 'number' && Number.isFinite(value);
  const monthKey = key => /^\d{4}-(0[1-9]|1[0-2])$/.test(key);
  const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
  function assert(ok, message) { if (!ok) throw new Error(message); }
  function tree(value, depth = 0) {
    assert(depth < 40, 'Data is nested too deeply');
    if (!value || typeof value !== 'object' || Decimal?.exact(value)) return;
    for (const [key, item] of Object.entries(value)) {
      assert(!['__proto__', 'constructor', 'prototype'].includes(key), 'Unsafe data key');
      if (key === 'id' || ['personId','coveredById','paidById','remainderLineId','memberId','tripId','expenseId','eventId','linkedPersonId','fromId','toId','participantId','fromMemberId','toMemberId'].includes(key)) {
        if (item !== null && item !== '') assert(id(item), 'Invalid identifier: ' + key);
      }
      if (key === 'color' && item != null) assert(typeof item === 'string' && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(item), 'Invalid color');
      tree(item, depth + 1);
    }
  }
  function rows(value, name) {
    assert(Array.isArray(value), name + ' must be a list');
    const seen = new Set();
    value.forEach(row => {
      assert(record(row) && id(row.id) && !seen.has(row.id), name + ' contains an invalid or duplicate record');
      seen.add(row.id);
    });
  }
  function refs(value, name) {
    assert(Array.isArray(value), name + ' must be a list');
    for (const ref of value) assert(record(ref) && typeof ref.token === 'string' && /^[A-Za-z0-9_-]+$/.test(ref.token), 'Invalid shared reference');
  }
  function state(value) {
    assert(record(value), 'State must be an object'); tree(value);
    for (const key of ['settings', 'checklist', 'requestDates']) if (key in value) assert(record(value[key]), key + ' must be an object');
    for (const key of ['people', 'bills']) if (key in value) rows(value[key], key);
    if ('sharedBills' in value) refs(value.sharedBills, 'Shared bills');
    for (const bill of value.bills || []) rows(bill.lines, 'Bill lines');
    if ('checks' in value) {
      assert(record(value.checks), 'Invalid checks state'); rows(value.checks.checks, 'Checks');
      for (const check of value.checks.checks) for (const key of ['items', 'participants']) if (key in check) rows(check[key], key);
    }
    if ('trips' in value) {
      assert(record(value.trips), 'Invalid trips state'); rows(value.trips.trips, 'Trips');
      if ('sharedTrips' in value.trips) refs(value.trips.sharedTrips, 'Shared trips');
      for (const trip of value.trips.trips) for (const key of ['members', 'expenses', 'itinerary', 'settlements', 'settledTransfers']) if (key in trip) rows(trip[key], key);
    }
    return value;
  }
  function month(value) {
    assert(record(value), 'Month must be an object'); tree(value);
    for (const key of ['totals', 'amounts']) if (key in value) assert(record(value[key]), key + ' must be an object');
    for (const n of Object.values(value.totals || {})) assert(number(n), 'Invalid bill amount');
    for (const amounts of Object.values(value.amounts || {})) {
      assert(record(amounts), 'Invalid line amounts');
      for (const n of Object.values(amounts)) assert(number(n), 'Invalid line amount');
    }
    return value;
  }
  function months(value) {
    assert(record(value), 'Monthly history must be an object'); tree(value);
    for (const [key, data] of Object.entries(value)) { assert(monthKey(key), 'Invalid month key'); month(data); }
    return value;
  }
  function backup(value) {
    assert(record(value) && record(value.state) && record(value.monthly), 'Expected a backup with state and monthly history');
    assert(value.version == null || [1, 2].includes(value.version), 'Unsupported backup version');
    assert(!value.attachments || (Array.isArray(value.attachments) && value.attachments.length === 0), 'This server cannot restore embedded attachments. Restore server files separately.');
    state(value.state); months(value.monthly); return value;
  }
  const contract = { state, month, months, backup, tree, monthKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = contract;
  else root.BHData = contract;
})(typeof globalThis !== 'undefined' ? globalThis : this);
