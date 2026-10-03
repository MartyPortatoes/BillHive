'use strict';

const crypto = require('node:crypto');
const Decimal = require('./decimal-json');
const Data = require('./public/data-contract');
const {SyncError} = require('./sync-store');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !['__proto__','prototype','constructor'].includes(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;
const fail = (status,code,message) => { throw new SyncError(status,code,message); };

/** Invitations are a separate revision stream. Accepting a link records access,
 * never a payment, and grants no household or monthly write authority. */
class BillsInviteSync {
  constructor(db,sync,project) {
    this.db=db; this.sync=sync; this.project=project;
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS bills_invite_revisions (
          user_id TEXT NOT NULL, person_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision>=0 AND revision<=9007199254740991), PRIMARY KEY(user_id,person_id));
        CREATE TABLE IF NOT EXISTS bills_invite_owner_receipts (
          user_id TEXT NOT NULL, mutation_id TEXT NOT NULL, person_id TEXT NOT NULL,
          request_hash TEXT NOT NULL, revision INTEGER NOT NULL, result_token TEXT,
          created_at INTEGER NOT NULL DEFAULT(unixepoch()), PRIMARY KEY(user_id,mutation_id));
        CREATE TABLE IF NOT EXISTS bills_invite_join_receipts (
          share_id TEXT NOT NULL, mutation_id TEXT NOT NULL, request_hash TEXT NOT NULL,
          revision INTEGER NOT NULL, joined_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL DEFAULT(unixepoch()), PRIMARY KEY(share_id,mutation_id));
        INSERT OR IGNORE INTO bills_invite_revisions(user_id,person_id,revision)
          SELECT owner_user_id,person_id,1 FROM bills_invites GROUP BY owner_user_id,person_id;
      `);
      for(const operation of ['INSERT','UPDATE','DELETE']) {
        const row=operation==='DELETE'?'OLD':'NEW';
        db.exec(`CREATE TRIGGER IF NOT EXISTS bills_invite_${operation.toLowerCase()} AFTER ${operation} ON bills_invites BEGIN
          INSERT INTO bills_invite_revisions(user_id,person_id,revision) VALUES(${row}.owner_user_id,${row}.person_id,1)
          ON CONFLICT(user_id,person_id) DO UPDATE SET revision=revision+1; END;`);
      }
      db.exec(`CREATE TRIGGER IF NOT EXISTS bills_invite_identity BEFORE UPDATE ON bills_invites
        WHEN NEW.token!=OLD.token OR NEW.owner_user_id!=OLD.owner_user_id OR NEW.person_id!=OLD.person_id
          OR NEW.created_at!=OLD.created_at OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
          OR (OLD.joined_at IS NOT NULL AND NEW.joined_at IS NOT OLD.joined_at)
        BEGIN SELECT RAISE(ABORT,'Invitation identity, acceptance and revocation are permanent'); END;`);
      for(const operation of ['INSERT','UPDATE']) db.exec(`
        CREATE TRIGGER IF NOT EXISTS bills_invite_parent_${operation.toLowerCase()} AFTER ${operation} ON user_state
        WHEN NEW.key='people' BEGIN
          UPDATE bills_invites SET revoked_at=unixepoch() WHERE owner_user_id=NEW.user_id AND revoked_at IS NULL
            AND NOT EXISTS(SELECT 1 FROM json_each(NEW.value) AS person WHERE json_extract(person.value,'$.id')=bills_invites.person_id);
        END;`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS bills_invite_parent_delete AFTER DELETE ON user_state WHEN OLD.key='people' BEGIN
        UPDATE bills_invites SET revoked_at=unixepoch() WHERE owner_user_id=OLD.user_id AND revoked_at IS NULL; END;
        UPDATE bills_invites SET revoked_at=unixepoch() WHERE revoked_at IS NULL AND NOT EXISTS(
          SELECT 1 FROM user_state AS state,json_each(state.value) AS person WHERE state.user_id=bills_invites.owner_user_id
            AND state.key='people' AND json_extract(person.value,'$.id')=bills_invites.person_id);
      `);
    }).immediate();
    this.find=db.prepare('SELECT * FROM bills_invites WHERE token=?');
    this.active=db.prepare('SELECT * FROM bills_invites WHERE owner_user_id=? AND person_id=? AND revoked_at IS NULL ORDER BY created_at DESC,rowid DESC LIMIT 1');
    this.readRevision=db.prepare('SELECT revision FROM bills_invite_revisions WHERE user_id=? AND person_id=?');
    this.people=db.prepare("SELECT value FROM user_state WHERE user_id=? AND key='people'");
    this.insert=db.prepare('INSERT INTO bills_invites(token,owner_user_id,person_id) VALUES(?,?,?)');
    this.revoke=db.prepare('UPDATE bills_invites SET revoked_at=unixepoch() WHERE owner_user_id=? AND person_id=? AND revoked_at IS NULL');
    this.join=db.prepare('UPDATE bills_invites SET joined_at=unixepoch() WHERE token=? AND joined_at IS NULL AND revoked_at IS NULL');
    this.ownerReceipt=db.prepare('SELECT * FROM bills_invite_owner_receipts WHERE user_id=? AND mutation_id=?');
    this.saveOwnerReceipt=db.prepare('INSERT INTO bills_invite_owner_receipts(user_id,mutation_id,person_id,request_hash,revision,result_token) VALUES(?,?,?,?,?,?)');
    this.joinReceipt=db.prepare('SELECT * FROM bills_invite_join_receipts WHERE share_id=? AND mutation_id=?');
    this.saveJoinReceipt=db.prepare('INSERT INTO bills_invite_join_receipts(share_id,mutation_id,request_hash,revision,joined_at) VALUES(?,?,?,?,?)');
  }
  version(userId,personId) { return this.readRevision.get(userId,personId)?.revision || 0; }
  person(userId,personId) {
    const people=Decimal.parse(this.people.get(userId)?.value || '[]'); Data.state({people});
    return people.find(person=>person.id===personId) || null;
  }
  invite(value) { return value ? {token:value.token,shareId:hash(value.token),createdAt:value.created_at,joinedAt:value.joined_at} : null; }
  ownerSnapshotInside(userId,personId) {
    if(!id(personId) || personId==='me') fail(400,'INVALID_BILLS_PERSON','Choose an invited household member.');
    const person=this.person(userId,personId);
    return {protocolVersion:1,userId,...this.sync.metadata(userId),personId,inviteRevision:this.version(userId,personId),
      revisionPreconditionsRequired:this.sync.requirePreconditions,personExists:person!==null,personName:person?.name || '',
      invite:this.invite(this.active.get(userId,personId))};
  }
  ownerSnapshot(userId,personId) { return this.db.transaction(()=>this.ownerSnapshotInside(userId,personId)).immediate(); }
  context(token) {
    const invite=this.find.get(token);
    if(!invite) fail(404,'INVITE_NOT_FOUND','This invitation was not found.');
    const person=this.person(invite.owner_user_id,invite.person_id);
    return {invite,access:invite.revoked_at!=null?'revoked':person?'active':'personRemoved'};
  }
  requireAccess(context) {
    if(context.access==='revoked') fail(410,'INVITE_REVOKED','This invitation was revoked.');
    if(context.access==='personRemoved') fail(410,'BILLS_PERSON_REMOVED','This household member was removed.');
  }
  publicSnapshotInside(context) {
    this.requireAccess(context); const invite=context.invite;
    const payload=this.project(invite.owner_user_id,invite.person_id);
    if(!payload) fail(410,'BILLS_PERSON_REMOVED','This household member was removed.');
    const {userId:ignored,...metadata}=this.sync.metadata(invite.owner_user_id);
    return {protocolVersion:1,decimalJSONProtocol:1,...metadata,personId:invite.person_id,shareId:hash(invite.token),
      inviteRevision:this.version(invite.owner_user_id,invite.person_id),revisionPreconditionsRequired:this.sync.requirePreconditions,
      createdAt:invite.created_at,joinedAt:invite.joined_at,...payload};
  }
  publicSnapshot(token) { return this.db.transaction(()=>this.publicSnapshotInside(this.context(token))).immediate(); }
  etag(snapshot) { return `"bhbi1:${snapshot.serverInstanceId}:${snapshot.householdId}:${snapshot.shareId || snapshot.personId}:${snapshot.revision}:${snapshot.inviteRevision}:${snapshot.monthKey || ''}"`; }
  identity(input,snapshot) {
    if(['serverInstanceId','householdId','personId'].some(key=>input[key]!==snapshot[key]) ||
        Object.hasOwn(input,'shareId') && input.shareId!==snapshot.shareId) fail(409,'HOUSEHOLD_CHANGED','The household or invitation changed.');
  }
  validate(input,extra) {
    const keys=['serverInstanceId','householdId','personId','baseRevision','baseInviteRevision','mutationId',...extra];
    if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).length!==keys.length || keys.some(key=>!Object.hasOwn(input,key)) ||
        !['serverInstanceId','householdId','personId','mutationId'].every(key=>id(input[key])) || input.personId==='me' || input.mutationId.length<16 ||
        !revision(input.baseRevision) || !revision(input.baseInviteRevision)) fail(400,'INVALID_BILLS_COMMAND','Invalid invitation command.');
    try { Data.tree(input); } catch { fail(400,'INVALID_BILLS_COMMAND','Invalid invitation command.'); }
  }
  current(input,snapshot) {
    if(!this.sync.requirePreconditions) fail(428,'PROTECTION_DISABLED','Enable revision protection before changing invitations.');
    if(input.baseRevision!==snapshot.revision || input.baseInviteRevision!==snapshot.inviteRevision ||
        Object.hasOwn(input,'monthKey') && input.monthKey!==snapshot.monthKey) fail(409,'BILLS_INVITE_CONFLICT','The household or invitation changed. Review it before continuing.');
  }
  changeLink(userId,personId,kind) {
    if(kind!=='revoke' && !this.person(userId,personId)) fail(404,'BILLS_PERSON_REMOVED','This household member was removed.');
    if(kind!=='create') this.revoke.run(userId,personId);
    if(kind==='revoke') return null;
    const existing=this.active.get(userId,personId); if(existing) return existing.token;
    const token=crypto.randomBytes(24).toString('base64url'); this.insert.run(token,userId,personId); return token;
  }
  ownerCommit(userId,personId,input) {
    this.validate(input,['kind']);
    if(input.personId!==personId || !['create','rotate','revoke'].includes(input.kind)) fail(400,'INVALID_BILLS_COMMAND','Invalid invitation operation.');
    const digest=hash(Decimal.canonical(input));
    return this.db.transaction(()=>{
      const before=this.ownerSnapshotInside(userId,personId); this.identity(input,before);
      const receipt=this.ownerReceipt.get(userId,input.mutationId);
      if(receipt && (receipt.request_hash!==digest || receipt.person_id!==personId)) fail(409,'MUTATION_ID_REUSED','This mutation ID belongs to another command.');
      if(receipt) return {...this.receiptIdentity(before,input),replayed:true,committedInviteRevision:receipt.revision,resultToken:receipt.result_token,snapshot:before};
      this.current(input,before);
      const token=this.changeLink(userId,personId,input.kind), snapshot=this.ownerSnapshotInside(userId,personId);
      this.saveOwnerReceipt.run(userId,input.mutationId,personId,digest,snapshot.inviteRevision,token);
      return {...this.receiptIdentity(snapshot,input),replayed:false,committedInviteRevision:snapshot.inviteRevision,resultToken:token,snapshot};
    }).immediate();
  }
  receiptIdentity(snapshot,input) {
    return {protocolVersion:1,...(snapshot.userId?{userId:snapshot.userId}:{}),serverInstanceId:snapshot.serverInstanceId,
      householdId:snapshot.householdId,personId:snapshot.personId,mutationId:input.mutationId};
  }
  accept(token,input) {
    this.validate(input,['shareId','monthKey']);
    if(input.shareId!==hash(token) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.monthKey)) fail(400,'INVALID_BILLS_COMMAND','Invalid invitation identity or month.');
    const digest=hash(Decimal.canonical(input));
    return this.db.transaction(()=>{
      const context=this.context(token), invite=context.invite, metadata=this.sync.metadata(invite.owner_user_id);
      const identity={...metadata,personId:invite.person_id,shareId:hash(token)}; this.identity(input,identity);
      const receipt=this.joinReceipt.get(hash(token),input.mutationId);
      if(receipt && receipt.request_hash!==digest) fail(409,'MUTATION_ID_REUSED','This mutation ID belongs to another command.');
      if(receipt) return {...this.receiptIdentity(identity,input),shareId:hash(token),replayed:true,committedInviteRevision:receipt.revision,
        joinedAt:receipt.joined_at,access:context.access,snapshot:context.access==='active'?this.publicSnapshotInside(context):null};
      const before=this.publicSnapshotInside(context); this.current(input,before);
      this.join.run(token); const snapshot=this.publicSnapshotInside(this.context(token));
      this.saveJoinReceipt.run(hash(token),input.mutationId,digest,snapshot.inviteRevision,snapshot.joinedAt);
      return {...this.receiptIdentity(snapshot,input),shareId:hash(token),replayed:false,committedInviteRevision:snapshot.inviteRevision,
        joinedAt:snapshot.joinedAt,access:'active',snapshot};
    }).immediate();
  }
  legacyPrecondition(snapshot,tag) {
    if(!tag && this.sync.requirePreconditions) fail(428,'PRECONDITION_REQUIRED','Refresh with a compatible invitation client before continuing.');
    if(tag && tag!==this.etag(snapshot)) fail(409,'BILLS_INVITE_CONFLICT','The household or invitation changed.');
  }
  ownerLegacy(userId,personId,kind,tag) {
    return this.db.transaction(()=>{
      this.legacyPrecondition(this.ownerSnapshotInside(userId,personId),tag);
      const token=this.changeLink(userId,personId,kind);
      return {invite:token?this.find.get(token):null,snapshot:this.ownerSnapshotInside(userId,personId)};
    }).immediate();
  }
  acceptLegacy(token,tag) {
    return this.db.transaction(()=>{
      this.legacyPrecondition(this.publicSnapshotInside(this.context(token)),tag);
      this.join.run(token); return this.publicSnapshotInside(this.context(token));
    }).immediate();
  }
}
module.exports={BillsInviteSync};
