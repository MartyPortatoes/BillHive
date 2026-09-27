'use strict';

const crypto = require('node:crypto');
const Data = require('./public/data-contract');
const {SyncError} = require('./sync-store');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !['__proto__','constructor','prototype'].includes(value);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (status, code, message) => { throw new SyncError(status, code, message); };
const revision = value => Number.isSafeInteger(value) && value >= 0;
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (record(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function only(value, keys) { return record(value) && Object.keys(value).every(key => keys.includes(key)); }

/** Claims are declarations for host review. They never mutate the household's financial assignments. */
class CheckShareSync {
  constructor(db, sync, projectCheck) {
    this.db = db; this.sync = sync; this.projectCheck = projectCheck;
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS check_share_revisions (
          user_id TEXT NOT NULL, check_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision >= 0 AND revision <= 9007199254740991),
          PRIMARY KEY(user_id,check_id)
        );
        CREATE TABLE IF NOT EXISTS check_share_owner_receipts (
          user_id TEXT NOT NULL, mutation_id TEXT NOT NULL, check_id TEXT NOT NULL,
          request_hash TEXT NOT NULL, revision INTEGER NOT NULL, result_token TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY(user_id,mutation_id)
        );
        CREATE TABLE IF NOT EXISTS check_claim_receipts (
          share_id TEXT NOT NULL, claimant_id TEXT NOT NULL, mutation_id TEXT NOT NULL,
          request_hash TEXT NOT NULL, revision INTEGER NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY(share_id,claimant_id,mutation_id)
        );
        INSERT OR IGNORE INTO check_share_revisions(user_id,check_id,revision)
          SELECT user_id,check_id,1 FROM share_checks GROUP BY user_id,check_id;
      `);
      // Separate-resource revisions cover legacy writers and other SQLite connections too.
      for (const operation of ['INSERT','UPDATE','DELETE']) {
        const row = operation === 'DELETE' ? 'OLD' : 'NEW';
        db.exec(`CREATE TRIGGER IF NOT EXISTS check_share_${operation.toLowerCase()} AFTER ${operation} ON share_checks BEGIN
          INSERT INTO check_share_revisions(user_id,check_id,revision) VALUES (${row}.user_id,${row}.check_id,1)
          ON CONFLICT(user_id,check_id) DO UPDATE SET revision=revision+1;
        END;`);
      }
      db.exec(`CREATE TRIGGER IF NOT EXISTS check_share_identity BEFORE UPDATE ON share_checks
        WHEN NEW.token != OLD.token OR NEW.user_id != OLD.user_id OR NEW.check_id != OLD.check_id
          OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL) BEGIN
          SELECT RAISE(ABORT,'Share identity and revocation are permanent');
        END;`);
      // Deletion revokes the bearer link in the same transaction. Reintroducing an
      // identical check ID through restore must not resurrect an old public link.
      for (const operation of ['INSERT','UPDATE']) db.exec(`
        CREATE TRIGGER IF NOT EXISTS check_share_parent_${operation.toLowerCase()} AFTER ${operation} ON user_state
        WHEN NEW.key='checks' BEGIN
          UPDATE share_checks SET revoked_at=unixepoch()
          WHERE user_id=NEW.user_id AND revoked_at IS NULL AND NOT EXISTS (
            SELECT 1 FROM json_each(NEW.value,'$.checks') AS item WHERE json_extract(item.value,'$.id')=share_checks.check_id
          );
        END;`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS check_share_parent_delete AFTER DELETE ON user_state
        WHEN OLD.key='checks' BEGIN
          UPDATE share_checks SET revoked_at=unixepoch() WHERE user_id=OLD.user_id AND revoked_at IS NULL;
        END;`);
      // Upgrade old databases too: restoring an already absent check must never
      // reactivate a bearer link left behind by a legacy deletion.
      db.exec(`UPDATE share_checks SET revoked_at=unixepoch() WHERE revoked_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM user_state AS state, json_each(state.value,'$.checks') AS item
        WHERE state.user_id=share_checks.user_id AND state.key='checks'
          AND json_extract(item.value,'$.id')=share_checks.check_id
      );`);
    }).immediate();
    this.find = db.prepare('SELECT * FROM share_checks WHERE token=?');
    this.active = db.prepare('SELECT * FROM share_checks WHERE user_id=? AND check_id=? AND revoked_at IS NULL ORDER BY created_at DESC,rowid DESC LIMIT 1');
    this.readRevision = db.prepare('SELECT revision FROM check_share_revisions WHERE user_id=? AND check_id=?');
    this.readState = db.prepare('SELECT value FROM user_state WHERE user_id=? AND key=?');
    this.insert = db.prepare("INSERT INTO share_checks(token,user_id,check_id,claims) VALUES (?,?,?,'[]')");
    this.revoke = db.prepare('UPDATE share_checks SET revoked_at=unixepoch() WHERE user_id=? AND check_id=? AND revoked_at IS NULL');
    this.saveClaims = db.prepare('UPDATE share_checks SET claims=? WHERE token=? AND revoked_at IS NULL');
    this.ownerReceipt = db.prepare('SELECT * FROM check_share_owner_receipts WHERE user_id=? AND mutation_id=?');
    this.saveOwnerReceipt = db.prepare('INSERT INTO check_share_owner_receipts(user_id,mutation_id,check_id,request_hash,revision,result_token) VALUES (?,?,?,?,?,?)');
    this.claimReceipt = db.prepare('SELECT * FROM check_claim_receipts WHERE share_id=? AND claimant_id=? AND mutation_id=?');
    this.saveClaimReceipt = db.prepare('INSERT INTO check_claim_receipts(share_id,claimant_id,mutation_id,request_hash,revision) VALUES (?,?,?,?,?)');
  }
  version(userId, checkId) { return this.readRevision.get(userId,checkId)?.revision || 0; }
  check(userId, checkId) {
    const row = this.readState.get(userId,'checks');
    if (!row) return null;
    const value = JSON.parse(row.value); Data.state({checks:value});
    return (value.checks || []).find(check => check.id === checkId) || null;
  }
  currency(userId) {
    const row = this.readState.get(userId,'settings');
    const value = row ? JSON.parse(row.value) : {};
    Data.state({settings:value}); return value.currencyCode || 'USD';
  }
  claims(share) {
    const values = JSON.parse(share.claims); Data.tree(values);
    if (!Array.isArray(values) || values.some(c => !record(c) || typeof c.claimerName !== 'string' ||
        !Array.isArray(c.itemIds) || c.itemIds.some(id => typeof id !== 'string') || typeof c.claimedAt !== 'string')) {
      fail(409,'INVALID_STORED_CLAIMS','Repair the stored claims before changing this share.');
    }
    return values;
  }
  publicClaims(share) {
    return this.claims(share).map(c => ({claimerName:c.claimerName,itemIds:c.itemIds,claimedAt:c.claimedAt,
      ...(typeof c.claimantId === 'string' ? {claimantId:c.claimantId} : {})}));
  }
  share(share) {
    return share ? {token:share.token,shareId:hash(share.token),createdAt:share.created_at,claims:this.publicClaims(share)} : null;
  }
  ownerSnapshotInside(userId,checkId) {
    if (!identifier(checkId)) fail(400,'INVALID_CHECK_ID','Invalid check ID.');
    const check = this.check(userId,checkId);
    return {protocolVersion:1,userId,...this.sync.metadata(userId),checkId,shareRevision:this.version(userId,checkId),
      checkExists:check !== null,isCompleted:check?.isCompleted === true,
      revisionPreconditionsRequired:this.sync.requirePreconditions,share:this.share(this.active.get(userId,checkId))};
  }
  ownerSnapshot(userId,checkId) { return this.db.transaction(() => this.ownerSnapshotInside(userId,checkId)).immediate(); }
  context(token) {
    const share = this.find.get(token);
    if (!share) fail(404,'SHARE_NOT_FOUND','Share not found.');
    if (share.revoked_at != null) return {share,access:'revoked'};
    const check = this.check(share.user_id,share.check_id);
    return {share,check,access:check ? 'active' : 'checkRemoved'};
  }
  requireAccess(context) {
    if (context.access === 'revoked') fail(410,'SHARE_REVOKED','This share link was revoked.');
    if (context.access === 'checkRemoved') fail(404,'CHECK_NOT_FOUND','This check was removed.');
  }
  publicSnapshotInside(context) {
    this.requireAccess(context); const {share,check} = context;
    return {protocolVersion:1,...this.sync.metadata(share.user_id),checkId:share.check_id,shareId:hash(share.token),
      shareRevision:this.version(share.user_id,share.check_id),revisionPreconditionsRequired:this.sync.requirePreconditions,
      currencyCode:this.currency(share.user_id),check:{...this.projectCheck(check),isCompleted:check.isCompleted === true},
      claims:this.publicClaims(share),createdAt:share.created_at};
  }
  publicSnapshot(token) { return this.db.transaction(() => this.publicSnapshotInside(this.context(token))).immediate(); }
  etag(snapshot) { return `"bhcs1:${snapshot.serverInstanceId}:${snapshot.householdId}:${snapshot.shareId || snapshot.checkId}:${snapshot.revision}:${snapshot.shareRevision}"`; }
  precondition(snapshot, tag) {
    if (!tag && this.sync.requirePreconditions) fail(428,'PRECONDITION_REQUIRED','Refresh with a compatible sharing client before saving.');
    if (tag && tag !== this.etag(snapshot)) fail(409,'SHARE_CONFLICT','The check or share changed. Refresh and review before saving.');
  }
  identity(input,snapshot) {
    if (input.serverInstanceId !== snapshot.serverInstanceId || input.householdId !== snapshot.householdId || input.checkId !== snapshot.checkId ||
        ('shareId' in input && input.shareId !== snapshot.shareId)) fail(409,'HOUSEHOLD_CHANGED','The check, household or share changed.');
  }
  validate(input, extraKeys) {
    const keys = ['serverInstanceId','householdId','checkId','baseRevision','baseShareRevision','mutationId',...extraKeys];
    if (!only(input,keys) || keys.some(k => !Object.hasOwn(input,k)) ||
        !['serverInstanceId','householdId','checkId','mutationId'].every(k => identifier(input[k])) || input.mutationId.length < 16 ||
        !revision(input.baseRevision) || !revision(input.baseShareRevision)) fail(400,'INVALID_SHARE_COMMAND','Invalid sharing command.');
    try { Data.tree(input); } catch (_) { fail(400,'INVALID_SHARE_COMMAND','Invalid sharing command.'); }
  }
  current(input,snapshot,requireProtection) {
    if (requireProtection && !this.sync.requirePreconditions) fail(428,'PROTECTION_DISABLED','Enable revision protection before changing sharing.');
    if (input.baseRevision !== snapshot.revision || input.baseShareRevision !== snapshot.shareRevision)
      fail(409,'SHARE_CONFLICT','The check or share changed. Your command was not applied.');
  }
  changeLink(userId,checkId,kind) {
    const check = this.check(userId,checkId);
    if (kind !== 'revoke' && !check) fail(404,'CHECK_NOT_FOUND','This check was removed.');
    if (kind !== 'revoke' && check.isCompleted) fail(409,'CHECK_COMPLETED','Reopen this check before sharing it.');
    if (kind !== 'create') this.revoke.run(userId,checkId);
    if (kind === 'revoke') return null;
    const existing = this.active.get(userId,checkId);
    if (existing) return existing.token;
    const token = crypto.randomBytes(24).toString('base64url'); this.insert.run(token,userId,checkId); return token;
  }
  ownerCommit(userId,checkId,input,{requireProtection=false}={}) {
    this.validate(input,['kind']);
    if (input.checkId !== checkId || !['create','rotate','revoke'].includes(input.kind)) fail(400,'INVALID_SHARE_COMMAND','Invalid share operation.');
    const requestHash = hash(canonical(input));
    return this.db.transaction(() => {
      const before = this.ownerSnapshotInside(userId,checkId); this.identity(input,before);
      const receipt = this.ownerReceipt.get(userId,input.mutationId);
      if (receipt && (receipt.request_hash !== requestHash || receipt.check_id !== checkId)) fail(409,'MUTATION_ID_REUSED','This mutation ID was used for another command.');
      if (receipt) return {protocolVersion:1,userId,serverInstanceId:before.serverInstanceId,householdId:before.householdId,checkId,
        mutationId:input.mutationId,replayed:true,committedShareRevision:receipt.revision,resultToken:receipt.result_token,snapshot:before};
      this.current(input,before,requireProtection);
      const token = this.changeLink(userId,checkId,input.kind); const snapshot = this.ownerSnapshotInside(userId,checkId);
      this.saveOwnerReceipt.run(userId,input.mutationId,checkId,requestHash,snapshot.shareRevision,token);
      return {protocolVersion:1,userId,serverInstanceId:snapshot.serverInstanceId,householdId:snapshot.householdId,checkId,
        mutationId:input.mutationId,replayed:false,committedShareRevision:snapshot.shareRevision,resultToken:token,snapshot};
    }).immediate();
  }
  ownerLegacy(userId,checkId,kind,tag) {
    return this.db.transaction(() => {
      this.precondition(this.ownerSnapshotInside(userId,checkId),tag);
      const token = this.changeLink(userId,checkId,kind);
      return {share:token ? this.find.get(token) : null,snapshot:this.ownerSnapshotInside(userId,checkId)};
    }).immediate();
  }
  validateClaim(input) {
    if (!only(input,['claimerName','itemIds']) || typeof input.claimerName !== 'string' || !input.claimerName.trim() || input.claimerName.trim().length > 80 ||
        !Array.isArray(input.itemIds) || input.itemIds.length > 200 || input.itemIds.some(v => !identifier(v)) || new Set(input.itemIds).size !== input.itemIds.length)
      fail(400,'INVALID_CLAIM','Enter a name and valid unique item IDs.');
    return {claimerName:input.claimerName.trim(),itemIds:input.itemIds};
  }
  applyClaim(context,input,claimantId=null) {
    this.requireAccess(context);
    if (context.check.isCompleted) fail(409,'CHECK_COMPLETED','This check is completed.');
    if (input.itemIds.some(id => !(context.check.items || []).some(item => item.id === id))) fail(409,'ITEM_REMOVED','A selected item was removed. Refresh the check.');
    const claims = this.claims(context.share); const index = claimantId ? claims.findIndex(c => c.claimantId === claimantId) : -1;
    if (index < 0 && claims.length >= 500) fail(429,'CLAIM_LIMIT','This share has reached its claim limit. Ask the host to review it.');
    const claim = {...(index < 0 ? {} : claims[index]),...input,claimedAt:new Date().toISOString().replace(/\.\d{3}Z$/,'Z'),...(claimantId ? {claimantId} : {})};
    if (index < 0) claims.push(claim); else claims[index] = claim;
    this.saveClaims.run(JSON.stringify(claims),context.share.token);
  }
  claimCommit(token,key,input,{requireProtection=false}={}) {
    this.validate(input,['shareId','claimantId','claim']);
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) fail(400,'INVALID_CLAIMANT','A private claim credential is required.');
    const shareId = hash(token); const claimantId = hash('check-claimant\0'+token+'\0'+key);
    if (input.shareId !== shareId || input.claimantId !== claimantId) fail(409,'CLAIMANT_CHANGED','The share or claim credential changed.');
    const claim = this.validateClaim(input.claim); const requestHash = hash(canonical(input));
    return this.db.transaction(() => {
      const context = this.context(token); const metadata = this.sync.metadata(context.share.user_id);
      this.identity(input,{...metadata,checkId:context.share.check_id,shareId});
      const receipt = this.claimReceipt.get(shareId,claimantId,input.mutationId);
      if (receipt && receipt.request_hash !== requestHash) fail(409,'MUTATION_ID_REUSED','This mutation ID was used with different claim data.');
      const envelope = {protocolVersion:1,serverInstanceId:metadata.serverInstanceId,householdId:metadata.householdId,checkId:context.share.check_id,
        shareId,claimantId,mutationId:input.mutationId};
      if (receipt) return {userId:context.share.user_id,response:{...envelope,replayed:true,committedShareRevision:receipt.revision,
        access:context.access,snapshot:context.access === 'active' ? this.publicSnapshotInside(context) : null}};
      const before = this.publicSnapshotInside(context); this.current(input,before,requireProtection);
      this.applyClaim(context,claim,claimantId);
      const snapshot = this.publicSnapshotInside(this.context(token));
      this.saveClaimReceipt.run(shareId,claimantId,input.mutationId,requestHash,snapshot.shareRevision);
      return {userId:context.share.user_id,response:{...envelope,replayed:false,committedShareRevision:snapshot.shareRevision,access:'active',snapshot}};
    }).immediate();
  }
  claimLegacy(token,input,tag) {
    const claim = this.validateClaim(input);
    return this.db.transaction(() => {
      const context = this.context(token); this.precondition(this.publicSnapshotInside(context),tag);
      this.applyClaim(context,claim); return {userId:context.share.user_id,snapshot:this.publicSnapshotInside(this.context(token))};
    }).immediate();
  }
}
module.exports = {CheckShareSync};
