'use strict';

const crypto = require('node:crypto');
const {SyncError} = require('./sync-store');
const fail = (status, code, message) => { throw new SyncError(status, code, message); };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const segment = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !['__proto__','constructor','prototype'].includes(value);
const filename = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes('..');

/** Immutable bytes are separate from household JSON, in the same crash-safe SQLite database. */
class AttachmentStore {
  constructor(db, sync) {
    this.db = db; this.sync = sync;
    db.exec(`CREATE TABLE IF NOT EXISTS trip_attachment_blobs (
      user_id TEXT NOT NULL, kind TEXT NOT NULL, trip_id TEXT NOT NULL, record_id TEXT NOT NULL,
      filename TEXT NOT NULL, attachment_id TEXT NOT NULL, mime_type TEXT NOT NULL,
      sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL, bytes BLOB NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY(user_id, kind, trip_id, record_id, filename),
      UNIQUE(user_id, kind, trip_id, record_id, attachment_id)
    )`);
    this.find = db.prepare('SELECT * FROM trip_attachment_blobs WHERE user_id=? AND kind=? AND trip_id=? AND record_id=? AND filename=?');
    this.findMetadata = db.prepare('SELECT attachment_id,filename,mime_type,sha256,size_bytes FROM trip_attachment_blobs WHERE user_id=? AND kind=? AND trip_id=? AND record_id=? AND filename=?');
    this.readTrips = db.prepare("SELECT value FROM user_state WHERE user_id=? AND key='trips'");
    this.findId = db.prepare('SELECT filename FROM trip_attachment_blobs WHERE user_id=? AND kind=? AND trip_id=? AND record_id=? AND attachment_id=?');
    this.legacyPath = db.prepare('SELECT 1 FROM trip_attachment_blobs WHERE user_id=? AND kind=? AND record_id=? AND filename=? LIMIT 1');
    this.insert = db.prepare('INSERT INTO trip_attachment_blobs(user_id,kind,trip_id,record_id,filename,attachment_id,mime_type,sha256,size_bytes,bytes) VALUES (?,?,?,?,?,?,?,?,?,?)');
    this.usage = db.prepare('SELECT COALESCE(SUM(size_bytes),0) AS bytes FROM trip_attachment_blobs WHERE user_id=?');
  }
  scope(kind, tripId, recordId, name) {
    if (!['expenses','itinerary'].includes(kind) || !segment(tripId) || !segment(recordId) || !filename(name)) fail(400,'INVALID_ATTACHMENT','Invalid attachment location.');
    return [kind, tripId, recordId, name];
  }
  identity(userId, expected) {
    const current = this.sync.metadata(userId);
    if (!expected || expected.userId !== userId || expected.serverInstanceId !== current.serverInstanceId || expected.householdId !== current.householdId) {
      fail(409,'HOUSEHOLD_CHANGED','The server or signed-in household changed.');
    }
    return {protocolVersion:1, userId, serverInstanceId:current.serverInstanceId, householdId:current.householdId};
  }
  trips(userId) {
    const row = this.readTrips.get(userId);
    return row ? JSON.parse(row.value).trips : [];
  }
  parent(userId, scope) {
    const trip = this.trips(userId).find(trip => trip.id === scope[1]);
    const record = trip?.[scope[0]]?.find(record => record.id === scope[2]);
    if (!trip || !record) fail(404,'ATTACHMENT_PARENT_REMOVED','The trip or attachment record is unavailable.');
    return {trip, record};
  }
  descriptor(row) {
    return {id:row.attachment_id, filename:row.filename, mimeType:row.mime_type, storageVersion:1, sha256:row.sha256, sizeBytes:row.size_bytes};
  }
  matches(row, descriptor) {
    return row.attachment_id === descriptor.id && row.mime_type === descriptor.mimeType &&
      (descriptor.storageVersion == null && descriptor.sha256 == null && descriptor.sizeBytes == null ||
        descriptor.storageVersion === 1 && descriptor.sha256 === row.sha256 && descriptor.sizeBytes === row.size_bytes);
  }
  upload(userId, scope, expected, descriptor, bytes) {
    const limit = scope[0] === 'expenses' ? 2 * 1024 * 1024 : 10 * 1024 * 1024;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > limit || !segment(descriptor.id) ||
        !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(descriptor.mimeType || '') || descriptor.mimeType.length > 128 ||
        !/^[a-f0-9]{64}$/.test(descriptor.sha256 || '') || descriptor.sha256 !== hash(bytes)) {
      fail(400,'INVALID_ATTACHMENT','Invalid attachment content, type, size or digest.');
    }
    if (scope[0] === 'expenses' && (descriptor.mimeType !== 'image/jpeg' || !scope[3].endsWith('.jpg') ||
        bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)) fail(400,'INVALID_ATTACHMENT','Receipts must be JPEG images.');
    return this.db.transaction(() => {
      const identity = this.identity(userId, expected);
      if (!this.sync.requirePreconditions) fail(428,'PROTECTION_DISABLED','Enable revision protection before uploading.');
      const old = this.find.get(userId,...scope);
      if (old) {
        if (old.attachment_id !== descriptor.id || old.mime_type !== descriptor.mimeType || old.sha256 !== descriptor.sha256 || !old.bytes.equals(bytes)) {
          fail(409,'ATTACHMENT_ID_REUSED','This attachment name already identifies different content.');
        }
        return {...identity,...this.descriptor(old),kind:scope[0],tripId:scope[1],recordId:scope[2],replayed:true};
      }
      const {trip,record} = this.parent(userId,scope);
      if (trip.isArchived) fail(409,'TRIP_ARCHIVED','Reopen the trip before adding attachments.');
      if (Array.isArray(record.attachments) && record.attachments.some(item => item?.filename === scope[3] || item?.id === descriptor.id) ||
          this.findId.get(userId,scope[0],scope[1],scope[2],descriptor.id)) fail(409,'ATTACHMENT_ID_REUSED','This attachment identity is already in use.');
      if (this.usage.get(userId).bytes + bytes.length > 256 * 1024 * 1024) fail(413,'ATTACHMENT_QUOTA','The household attachment storage limit has been reached.');
      this.insert.run(userId,...scope,descriptor.id,descriptor.mimeType,descriptor.sha256,bytes.length,bytes);
      return {...identity,...this.descriptor(this.find.get(userId,...scope)),kind:scope[0],tripId:scope[1],recordId:scope[2],replayed:false};
    }).immediate();
  }
  /** Called after JSON writes but before their transaction commits, including legacy and guest writers. */
  validateReferences(userId) {
    for (const trip of this.trips(userId)) for (const kind of ['expenses','itinerary']) for (const record of trip[kind] || []) {
      if (record.attachments == null) continue;
      // Opaque legacy values remain untouched. This contract governs registered
      // immutable files and explicitly versioned descriptors, not older imports.
      if (!Array.isArray(record.attachments)) continue;
      const ids = new Set(); const names = new Set();
      for (const item of record.attachments) {
        const object = item && typeof item === 'object' && !Array.isArray(item);
        const declared = object && ['storageVersion','sha256','sizeBytes'].some(key => Object.hasOwn(item,key));
        const row = object && typeof item.filename === 'string' ? this.findMetadata.get(userId,kind,trip.id,record.id,item.filename) : null;
        const registeredId = object && typeof item.id === 'string' ? this.findId.get(userId,kind,trip.id,record.id,item.id) : null;
        if (!row && !declared && !registeredId) { if (object) {ids.add(item.id); names.add(item.filename);} continue; }
        if (!object || !segment(item.id) || !filename(item.filename) || ids.has(item.id) || names.has(item.filename)) {
          fail(400,'INVALID_ATTACHMENT','Invalid or repeated attachment reference.');
        }
        ids.add(item.id); names.add(item.filename);
        if (!row || !this.matches(row,item)) {
          fail(409,'ATTACHMENT_NOT_READY','Upload the exact attachment content before saving its reference.');
        }
      }
    }
  }
  download(userId, scope, expected = null) {
    return this.db.transaction(() => {
      if (expected) this.identity(userId,expected);
      const row = this.find.get(userId,...scope);
      if (!row) fail(404,'ATTACHMENT_NOT_FOUND','The attachment is unavailable.');
      const {record} = this.parent(userId,scope);
      if (!Array.isArray(record.attachments) || !record.attachments.some(item => item?.filename === scope[3] && this.matches(row,item))) fail(404,'ATTACHMENT_NOT_FOUND','The attachment is no longer referenced.');
      if (hash(row.bytes) !== row.sha256 || row.bytes.length !== row.size_bytes) fail(500,'ATTACHMENT_CORRUPT','Stored attachment verification failed.');
      return row;
    }).immediate();
  }
  isManagedLegacyPath(userId,kind,recordId,name) { return !!this.legacyPath.get(userId,kind,recordId,name); }
}
module.exports = {AttachmentStore};
