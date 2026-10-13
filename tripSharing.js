'use strict';

const {isDeepStrictEqual: equal} = require('node:util');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keyed = value => Array.isArray(value) && value.every(row => record(row) && typeof row.id === 'string');

// Apply only the participant's changes since their last read. Records created
// by other devices, and edits to unrelated fields, must survive a stale save.
function mergeChanges(base, edited, latest) {
  if (equal(base, edited)) return structuredClone(latest);
  if (record(base) && record(edited) && record(latest)) {
    const result = structuredClone(latest);
    for (const key of new Set([...Object.keys(base), ...Object.keys(edited)])) {
      if (!Object.hasOwn(edited, key)) delete result[key];
      else if (Object.hasOwn(base, key) && Object.hasOwn(latest, key)) {
        result[key] = mergeChanges(base[key], edited[key], latest[key]);
      } else if (!Object.hasOwn(base, key)) result[key] = structuredClone(edited[key]);
    }
    return result;
  }
  if (keyed(base) && keyed(edited) && keyed(latest)) {
    const original = new Map(base.map(row => [row.id, row]));
    const changes = new Map(edited.map(row => [row.id, row]));
    const result = structuredClone(latest.filter(row => !original.has(row.id) || changes.has(row.id)));
    for (const row of edited) {
      const index = result.findIndex(current => current.id === row.id);
      if (index >= 0) result[index] = mergeChanges(original.get(row.id) || {}, row, result[index]);
      else if (!original.has(row.id)) result.push(structuredClone(row));
    }
    return result;
  }
  return structuredClone(edited);
}

module.exports = {mergeChanges};
