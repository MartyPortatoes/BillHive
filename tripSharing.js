'use strict';

const Decimal = require('./decimal-json');
const Data = require('./public/data-contract');
const equal = (a, b) => Decimal.canonical(a) === Decimal.canonical(b);
const clone = value => value === undefined ? undefined : Decimal.parse(JSON.stringify(value));
const record = Decimal.record;
const keyed = value => Array.isArray(value) && value.every(row => record(row) && typeof row.id === 'string');

// Apply only the participant's changes since their last read. Records created
// by other devices, and edits to unrelated fields, must survive a stale save.
function mergeChanges(base, edited, latest) {
  if (equal(base, edited)) return clone(latest);
  if (record(base) && record(edited) && record(latest)) {
    const result = clone(latest);
    for (const key of new Set([...Object.keys(base), ...Object.keys(edited)])) {
      if (!Object.hasOwn(edited, key)) delete result[key];
      else if (Object.hasOwn(base, key) && Object.hasOwn(latest, key)) {
        result[key] = mergeChanges(base[key], edited[key], latest[key]);
      } else if (!Object.hasOwn(base, key)) result[key] = clone(edited[key]);
    }
    return result;
  }
  if (keyed(base) && keyed(edited) && keyed(latest)) {
    const original = new Map(base.map(row => [row.id, row]));
    const changes = new Map(edited.map(row => [row.id, row]));
    const result = clone(latest.filter(row => !original.has(row.id) || changes.has(row.id)));
    for (const row of edited) {
      const index = result.findIndex(current => current.id === row.id);
      if (index >= 0) result[index] = mergeChanges(original.get(row.id) || {}, row, result[index]);
      else if (!original.has(row.id)) result.push(clone(row));
    }
    return result;
  }
  return clone(edited);
}

function validateTrip(trip, tripId) {
  if (!record(trip) || trip.id !== tripId) throw new Error('Trip does not match invite');
  Data.state({trips:{trips:[trip]}});
  for (const key of ['name','icon','startDateISO','endDateISO','currency','notes']) {
    if (trip[key] !== undefined && (typeof trip[key] !== 'string' || trip[key].length > 10000)) throw new Error('Invalid trip text');
  }
  if (trip.isArchived !== undefined && typeof trip.isArchived !== 'boolean') throw new Error('Invalid archive flag');
  if (!Array.isArray(trip.members) || !Array.isArray(trip.expenses)) throw new Error('Expected members and expenses');
  for (const member of trip.members) if (typeof member.name !== 'string') throw new Error('Invalid member');
  const members = new Set(trip.members.map(member => member.id));
  for (const expense of trip.expenses) {
    if (typeof expense.name !== 'string' || !Decimal.amount(expense.amount) || !record(expense.paidByAmounts) ||
        !Array.isArray(expense.splitBetweenIds || []) || new Set(expense.splitBetweenIds || []).size !== (expense.splitBetweenIds || []).length ||
        (expense.splitBetweenIds || []).some(id => !members.has(id)) ||
        Object.entries(expense.paidByAmounts).some(([id, amount]) => !members.has(id) || !Decimal.amount(amount))) throw new Error('Invalid expense');
    for (const key of ['sourceAmount','exchangeRate']) if (expense[key] !== undefined &&
        (!Decimal.number(expense[key]) || Decimal.compare(expense[key],0) < 0 || (key === 'exchangeRate' && Decimal.compare(expense[key],0) === 0))) throw new Error('Invalid conversion');
  }
  for (const settlement of trip.settlements || []) {
    if (!Decimal.amount(settlement.amount) || !members.has(settlement.fromMemberId) || !members.has(settlement.toMemberId) ||
        settlement.fromMemberId === settlement.toMemberId) throw new Error('Invalid settlement');
  }
  if (trip.paymentRequestDates !== undefined && (!record(trip.paymentRequestDates) ||
      Object.values(trip.paymentRequestDates).some(value => typeof value !== 'string'))) throw new Error('Invalid payment request dates');
}

// Persist deleted IDs so retrying a previously accepted addition after another
// participant deleted it cannot bring it back. Writes run in the owner's sync transaction.
class TripDeletionHistory {
  constructor(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS trip_collaboration_deletions (
      owner_id TEXT NOT NULL, trip_id TEXT NOT NULL, collection TEXT NOT NULL, record_id TEXT NOT NULL,
      PRIMARY KEY(owner_id,trip_id,collection,record_id))`);
    this.read = db.prepare('SELECT record_id FROM trip_collaboration_deletions WHERE owner_id=? AND trip_id=? AND collection=?');
    this.remember = db.prepare('INSERT OR IGNORE INTO trip_collaboration_deletions VALUES(?,?,?,?)');
  }
  apply(owner, tripId, original, merged) {
    for (const key of ['expenses','settlements','itinerary','members','checklistItems']) {
      const current = new Set((original[key] || []).map(row => row.id));
      const deleted = new Set(this.read.all(owner,tripId,key).map(row => row.record_id));
      merged[key] = (merged[key] || []).filter(row => current.has(row.id) || !deleted.has(row.id));
      const remaining = new Set(merged[key].map(row => row.id));
      for (const id of current) if (!remaining.has(id)) this.remember.run(owner,tripId,key,id);
    }
  }
}

module.exports = {mergeChanges, validateTrip, TripDeletionHistory};
