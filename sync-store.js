'use strict';

const crypto = require('node:crypto');
const Data = require('./public/data-contract');

class SyncError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new SyncError(status, code, message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !['__proto__','constructor','prototype'].includes(value);
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (record(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

/** One revision stream per authenticated household. Triggers cover every JSON writer, including guests and older clients. */
class SyncStore {
  constructor(db, {requirePreconditions = false} = {}) {
    this.db = db;
    this.requirePreconditions = requirePreconditions;
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_revisions (
          user_id TEXT PRIMARY KEY,
          household_id TEXT NOT NULL UNIQUE,
          revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0 AND revision <= 9007199254740991)
        );
        CREATE TABLE IF NOT EXISTS sync_receipts (
          user_id TEXT NOT NULL,
          mutation_id TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          revision INTEGER NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          PRIMARY KEY(user_id, mutation_id)
        );
      `);
      db.prepare('INSERT OR IGNORE INTO app_settings (key,value) VALUES (?,?)').run('syncInstanceId', crypto.randomUUID());
      // Revisions are opaque monotonically increasing tokens, not counts of API calls.
      // A multi-row transaction may advance several times; readers only see its final revision.
      for (const table of ['user_state', 'monthly_data']) for (const operation of ['INSERT','UPDATE','DELETE']) {
        const row = operation === 'DELETE' ? 'OLD' : 'NEW';
        db.exec(`CREATE TRIGGER IF NOT EXISTS sync_${table}_${operation.toLowerCase()}
          AFTER ${operation} ON ${table} BEGIN
            INSERT INTO sync_revisions(user_id,household_id,revision)
            VALUES (${row}.user_id,lower(hex(randomblob(16))),1)
            ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
          END;`);
      }
    }).immediate();
    this.instanceId = db.prepare('SELECT value FROM app_settings WHERE key=?').get('syncInstanceId').value;
    this.ensure = db.prepare('INSERT OR IGNORE INTO sync_revisions(user_id,household_id,revision) VALUES (?,lower(hex(randomblob(16))),0)');
    this.readRevision = db.prepare('SELECT household_id,revision FROM sync_revisions WHERE user_id=?');
    this.readState = db.prepare('SELECT key,value FROM user_state WHERE user_id=? ORDER BY key');
    this.readMonths = db.prepare('SELECT month_key,data FROM monthly_data WHERE user_id=? ORDER BY month_key');
    this.setState = db.prepare('INSERT INTO user_state(user_id,key,value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value,updated_at=unixepoch() WHERE value != excluded.value');
    this.setMonth = db.prepare('INSERT INTO monthly_data(user_id,month_key,data) VALUES (?,?,?) ON CONFLICT(user_id,month_key) DO UPDATE SET data=excluded.data,updated_at=unixepoch() WHERE data != excluded.data');
    this.deleteState = db.prepare('DELETE FROM user_state WHERE user_id=? AND key=?');
    this.deleteMonth = db.prepare('DELETE FROM monthly_data WHERE user_id=? AND month_key=?');
    this.receipt = db.prepare('SELECT request_hash,revision FROM sync_receipts WHERE user_id=? AND mutation_id=?');
    this.saveReceipt = db.prepare('INSERT INTO sync_receipts(user_id,mutation_id,request_hash,revision) VALUES (?,?,?,?)');
  }

  metadata(userId) {
    this.ensure.run(userId);
    const row = this.readRevision.get(userId);
    return {serverInstanceId:this.instanceId, householdId:row.household_id, revision:row.revision};
  }
  etag(metadata) { return `"bh1:${metadata.serverInstanceId}:${metadata.householdId}:${metadata.revision}"`; }
  snapshotInside(userId) {
    const state = Object.fromEntries(this.readState.all(userId).map(row => [row.key, JSON.parse(row.value)]));
    const monthly = Object.fromEntries(this.readMonths.all(userId).map(row => [row.month_key, JSON.parse(row.data)]));
    Data.state(state); Data.months(monthly);
    return {protocolVersion:1, userId, ...this.metadata(userId), state, monthly};
  }
  snapshot(userId) { return this.db.transaction(() => this.snapshotInside(userId)).immediate(); }

  /** Used by existing routes; check and write share a SQLite write transaction. */
  write(userId, ifMatch, operation) {
    return this.db.transaction(() => {
      const metadata = this.metadata(userId);
      if (!ifMatch && this.requirePreconditions) fail(428, 'PRECONDITION_REQUIRED', 'Refresh with a compatible client before saving.');
      if (ifMatch && ifMatch !== this.etag(metadata)) fail(409, 'REVISION_CONFLICT', 'The household changed. Your edits were not applied.');
      const value = operation();
      if (value && typeof value.then === 'function') throw new Error('Sync transactions must be synchronous');
      return {value, metadata:this.metadata(userId)};
    }).immediate();
  }

  validateCommit(body) {
    if (!record(body)) fail(400, 'INVALID_COMMIT', 'Expected a sync commit object.');
    const allowed = new Set(['serverInstanceId','householdId','baseRevision','mutationId','state','monthly','deleteStateKeys','deleteMonths']);
    if (Object.keys(body).some(key => !allowed.has(key))) fail(400, 'INVALID_COMMIT', 'Unknown sync commit field.');
    if (!identifier(body.serverInstanceId) || !identifier(body.householdId) || !identifier(body.mutationId) || body.mutationId.length < 16 ||
        !Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0) fail(400, 'INVALID_COMMIT', 'Invalid sync identity, revision or mutation ID.');
    try { Data.state(body.state); Data.months(body.monthly); }
    catch (_) { fail(400, 'INVALID_COMMIT', 'Invalid household state or monthly data.'); }
    const deleteStateKeys = body.deleteStateKeys ?? []; const deleteMonths = body.deleteMonths ?? [];
    if (!Array.isArray(deleteStateKeys) || !Array.isArray(deleteMonths) ||
        deleteStateKeys.some(key => !identifier(key) || Object.hasOwn(body.state, key)) ||
        deleteMonths.some(key => !Data.monthKey(key) || Object.hasOwn(body.monthly, key)) ||
        new Set(deleteStateKeys).size !== deleteStateKeys.length || new Set(deleteMonths).size !== deleteMonths.length) {
      fail(400, 'INVALID_COMMIT', 'Invalid or overlapping deleted keys.');
    }
    return {...body, deleteStateKeys, deleteMonths};
  }

  commit(userId, body) {
    const input = this.validateCommit(body);
    const hash = crypto.createHash('sha256').update(canonical(input)).digest('hex');
    return this.db.transaction(() => {
      const metadata = this.metadata(userId);
      if (input.serverInstanceId !== metadata.serverInstanceId || input.householdId !== metadata.householdId) {
        fail(409, 'HOUSEHOLD_CHANGED', 'The server or signed-in household changed. Reconnect before saving.');
      }
      const receipt = this.receipt.get(userId, input.mutationId);
      if (receipt) {
        if (receipt.request_hash !== hash) fail(409, 'MUTATION_ID_REUSED', 'This mutation ID was already used with different data.');
        return {...this.snapshotInside(userId), mutationId:input.mutationId, committedRevision:receipt.revision, replayed:true};
      }
      if (input.baseRevision !== metadata.revision) fail(409, 'REVISION_CONFLICT', 'The household changed. Your edits were not applied.');
      // Fail closed on corrupt persisted data before any overwrite, including unknown fields.
      this.snapshotInside(userId);
      for (const [key,value] of Object.entries(input.state)) this.setState.run(userId,key,JSON.stringify(value));
      for (const [key,value] of Object.entries(input.monthly)) this.setMonth.run(userId,key,JSON.stringify(value));
      for (const key of input.deleteStateKeys) this.deleteState.run(userId,key);
      for (const key of input.deleteMonths) this.deleteMonth.run(userId,key);
      const snapshot = this.snapshotInside(userId);
      this.saveReceipt.run(userId,input.mutationId,hash,snapshot.revision);
      return {...snapshot, mutationId:input.mutationId, committedRevision:snapshot.revision, replayed:false};
    }).immediate();
  }
}
module.exports = {SyncStore, SyncError};
