'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Decimal = require('./decimal-json');
const {SyncError} = require('./sync-store');
const fail = (status, code, message) => { throw new SyncError(status, code, message); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const segment = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const leaf = value => typeof value === 'string' && value.length <= 255 && value.length > 0 &&
  !/[\\/\0]/.test(value) && !['.','..'].includes(value);
const roots = {expenses:'trip-receipts', itinerary:'trip-itinerary-attachments'};
const missing = error => error.code === 'ENOENT';
const identity = stat => ({dev:String(stat.dev), ino:String(stat.ino), size:String(stat.size),
  mtime:String(stat.mtimeNs), ctime:String(stat.ctimeNs)});
const equal = (a,b) => Decimal.canonical(a) === Decimal.canonical(b);
const summaryKeys = ['stateKeys','months','checkLinks','tripLinks','billsLinks','managedFiles','managedBytes','legacyFiles','legacyBytes'];

/** Reset is an owner commit, not account erasure. Disk deletion uses durable, exact-file tasks. */
class HouseholdResetStore {
  constructor(db, sync, attachments, dataDir) {
    this.db=db; this.sync=sync; this.attachments=attachments;
    this.dataDir=fs.realpathSync(dataDir);
    db.exec(`
      CREATE TABLE IF NOT EXISTS household_reset_receipts (
        user_id TEXT NOT NULL, mutation_id TEXT NOT NULL, report TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT(unixepoch()), PRIMARY KEY(user_id,mutation_id));
      CREATE TABLE IF NOT EXISTS household_reset_files (
        user_id TEXT NOT NULL, mutation_id TEXT NOT NULL, kind TEXT NOT NULL,
        record_id TEXT NOT NULL, filename TEXT NOT NULL, proof TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','removed','retained','failed')),
        PRIMARY KEY(user_id,mutation_id,kind,record_id,filename));
    `);
    this.find=db.prepare('SELECT report FROM household_reset_receipts WHERE user_id=? AND mutation_id=?');
    this.hasReset=db.prepare('SELECT 1 FROM household_reset_receipts WHERE user_id=? LIMIT 1');
    this.tasks=db.prepare('SELECT * FROM household_reset_files WHERE user_id=? AND mutation_id=? ORDER BY kind,record_id,filename');
    this.saveTask=db.prepare('INSERT INTO household_reset_files(user_id,mutation_id,kind,record_id,filename,proof) VALUES (?,?,?,?,?,?)');
    this.setTask=db.prepare('UPDATE household_reset_files SET status=? WHERE user_id=? AND mutation_id=? AND kind=? AND record_id=? AND filename=?');
    attachments.requiresResetRevision=userId=>!!this.hasReset.get(userId);
    sync.householdReset=this;
  }
  validateInput(input) {
    const marker=input.householdReset;
    if (!Decimal.record(marker) || Object.keys(marker).length!==3 || marker.protocolVersion!==1 ||
        !/^[a-f0-9]{64}$/.test(marker.guard || '') || Object.keys(input.state).length || Object.keys(input.monthly).length ||
        !Decimal.record(marker.summary) || !equal(Object.keys(marker.summary).sort(),[...summaryKeys].sort()) ||
        summaryKeys.some(key=>!Number.isSafeInteger(marker.summary[key]) || marker.summary[key]<0) ||
        Object.hasOwn(input,'checkSharePreconditions'))
      fail(400,'INVALID_RESET','A reset must explicitly clear the reviewed household with one reset guard.');
  }
  requireProtection() {
    if (!this.sync.requirePreconditions) fail(428,'PROTECTION_DISABLED','Enable revision protection before reviewing or resetting a household.');
  }
  user(userId) {
    if (typeof userId!=='string' || !/^[A-Za-z0-9._@-]{1,128}$/.test(userId) || /^\.+$/.test(userId))
      fail(400,'INVALID_RESET_SCOPE','Invalid household file scope.');
  }
  directory(parts, create=false) {
    let current=this.dataDir;
    const base=fs.lstatSync(current);
    if (!base.isDirectory() || base.isSymbolicLink()) fail(409,'UNSAFE_ATTACHMENT_PATH','Repair the attachment directory before continuing.');
    // Never follow a user-directory or record-directory symlink. All app writes
    // are synchronous and serialize with cleanup on this database's write lock.
    for (const part of parts) {
      current=path.join(current,part);
      let stat;
      try { stat=fs.lstatSync(current); }
      catch (error) {
        if (!missing(error)) throw error;
        if (!create) return null;
        fs.mkdirSync(current); stat=fs.lstatSync(current);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail(409,'UNSAFE_ATTACHMENT_PATH','Repair the attachment directory before continuing.');
    }
    return current;
  }
  filePath(userId,kind,recordId,name,create=false) {
    this.user(userId);
    if (!Object.hasOwn(roots,kind) || !segment(recordId) || !leaf(name)) fail(400,'INVALID_RESET_SCOPE','Invalid attachment file scope.');
    const directory=this.directory([roots[kind],userId,recordId],create);
    return directory && path.join(directory,name);
  }
  proof(file, limit) {
    const before=fs.lstatSync(file,{bigint:true});
    if (!before.isFile() || before.isSymbolicLink() || before.size>BigInt(limit))
      fail(409,'UNSAFE_ATTACHMENT_FILE','Review the unsupported attachment file before resetting.');
    const fd=fs.openSync(file,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (!equal(identity(before),identity(fs.fstatSync(fd,{bigint:true})))) fail(409,'RESET_REVIEW_CHANGED','An attachment changed during review.');
      const digest=crypto.createHash('sha256'); const buffer=Buffer.alloc(64*1024); let total=0, read;
      while ((read=fs.readSync(fd,buffer,0,buffer.length,null))>0) {
        total+=read;
        if (total>limit) fail(409,'RESET_REVIEW_CHANGED','An attachment changed during review.');
        digest.update(buffer.subarray(0,read));
      }
      const result={...identity(before),sha256:digest.digest('hex')};
      if (String(total)!==result.size || !equal(identity(before),identity(fs.fstatSync(fd,{bigint:true}))))
        fail(409,'RESET_REVIEW_CHANGED','An attachment changed during review.');
      return result;
    } finally { fs.closeSync(fd); }
  }
  scan(userId) {
    this.user(userId); const files=[]; let bytes=0, directories=0;
    for (const kind of Object.keys(roots)) {
      const root=this.directory([roots[kind],userId]);
      if (!root) continue;
      for (const recordId of fs.readdirSync(root).sort()) {
        if (++directories>10000) fail(413,'RESET_FILE_LIMIT','Review the large attachment collection before resetting.');
        if (!segment(recordId)) fail(409,'UNSAFE_ATTACHMENT_PATH','Review the unsupported attachment directory before resetting.');
        const directory=this.directory([roots[kind],userId,recordId]);
        for (const name of fs.readdirSync(directory).sort()) {
          if (files.length>=10000) fail(413,'RESET_FILE_LIMIT','Review the large attachment collection before resetting.');
          const file=this.filePath(userId,kind,recordId,name);
          const proof=this.proof(file,(kind==='expenses'?2:10)*1024*1024);
          bytes+=Number(proof.size);
          if (bytes>256*1024*1024) fail(413,'RESET_FILE_LIMIT','Review the large attachment collection before resetting.');
          files.push({kind,recordId,filename:name,proof});
        }
      }
    }
    return files;
  }
  reviewInside(userId, snapshot) {
    const checkLinks=this.db.prepare('SELECT * FROM share_checks WHERE user_id=? ORDER BY token').all(userId);
    const tripLinks=this.db.prepare('SELECT * FROM trip_invites WHERE owner_user_id=? ORDER BY token').all(userId);
    const billsLinks=this.db.prepare('SELECT * FROM bills_invites WHERE owner_user_id=? ORDER BY token').all(userId);
    const checkRevisions=this.db.prepare('SELECT * FROM check_share_revisions WHERE user_id=? ORDER BY check_id').all(userId);
    const billsRevisions=this.db.prepare('SELECT * FROM bills_invite_revisions WHERE user_id=? ORDER BY person_id').all(userId);
    const managed=this.db.prepare(`SELECT kind,trip_id,record_id,filename,attachment_id,mime_type,sha256,size_bytes,purged_at,length(bytes) AS stored_bytes
      FROM trip_attachment_blobs WHERE user_id=? ORDER BY kind,trip_id,record_id,filename`).all(userId);
    const files=this.scan(userId);
    const summary={stateKeys:Object.keys(snapshot.state).length,months:Object.keys(snapshot.monthly).length,
      checkLinks:checkLinks.filter(row=>row.revoked_at==null).length,tripLinks:tripLinks.filter(row=>row.revoked_at==null).length,
      billsLinks:billsLinks.filter(row=>row.revoked_at==null).length,managedFiles:managed.filter(row=>row.purged_at==null).length,
      managedBytes:managed.filter(row=>row.purged_at==null).reduce((sum,row)=>sum+row.stored_bytes,0),
      legacyFiles:files.length,legacyBytes:files.reduce((sum,row)=>sum+Number(row.proof.size),0)};
    const guard=hash(Decimal.canonical({snapshot,checkLinks,tripLinks,billsLinks,checkRevisions,billsRevisions,managed,files}));
    return {protocolVersion:1,guard,summary,files};
  }
  preview(userId) {
    return this.db.transaction(()=>{
      this.requireProtection(); const snapshot=this.sync.snapshotInside(userId);
      const {files:_,...review}=this.reviewInside(userId,snapshot);
      return {...snapshot,householdReset:review};
    }).immediate();
  }
  prepare(userId,input,current) {
    this.requireProtection();
    for (const [before,deleted] of [[current.state,input.deleteStateKeys],[current.monthly,input.deleteMonths]])
      if (!equal(Object.keys(before).sort(),[...deleted].sort())) fail(400,'INVALID_RESET','A reset must explicitly delete every reviewed record and history key.');
    const review=this.reviewInside(userId,current);
    if (review.guard!==input.householdReset.guard) fail(409,'RESET_REVIEW_CHANGED','The household, invitation access or attachments changed. Review the reset again.');
    if (!equal(review.summary,input.householdReset.summary)) fail(400,'INVALID_RESET','The reset counts did not match their original review.');
    return review;
  }
  apply(userId,input,review) {
    this.db.prepare('UPDATE share_checks SET revoked_at=unixepoch() WHERE user_id=? AND revoked_at IS NULL').run(userId);
    this.db.prepare('UPDATE trip_invites SET revoked_at=unixepoch() WHERE owner_user_id=? AND revoked_at IS NULL').run(userId);
    this.db.prepare('UPDATE bills_invites SET revoked_at=unixepoch() WHERE owner_user_id=? AND revoked_at IS NULL').run(userId);
    this.attachments.purge.run(userId);
    for (const file of review.files) this.saveTask.run(userId,input.mutationId,file.kind,file.recordId,file.filename,JSON.stringify(file.proof));
    // Even an already empty household invalidates older upload/review requests.
    this.db.prepare('UPDATE sync_revisions SET revision=revision+1 WHERE user_id=?').run(userId);
    const {files:_,...report}=review;
    this.db.prepare('INSERT INTO household_reset_receipts(user_id,mutation_id,report) VALUES (?,?,?)').run(userId,input.mutationId,JSON.stringify(report));
  }
  receipt(userId,mutationId) {
    const row=this.find.get(userId,mutationId);
    if (!row) fail(404,'RESET_RECEIPT_NOT_FOUND','This reset receipt was not found for the signed-in household.');
    const cleanup={pending:0,removed:0,retained:0,failed:0};
    for (const task of this.tasks.all(userId,mutationId)) cleanup[task.status]++;
    return {...JSON.parse(row.report),cleanup};
  }
  referenced(userId,kind,recordId,name) {
    return this.attachments.trips(userId).some(trip=>(trip[kind] || []).some(record=>record.id===recordId &&
      Array.isArray(record.attachments) && record.attachments.some(item=>item?.filename===name)));
  }
  cleanup(userId,mutationId,expected) {
    return this.db.transaction(()=>{
      this.attachments.identity(userId,expected);
      this.receipt(userId,mutationId);
      if (!this.sync.receipt.get(userId,mutationId)) fail(409,'RESET_RECEIPT_INCOMPLETE','The reset acknowledgement is unavailable.');
      for (const task of this.tasks.all(userId,mutationId)) {
        if (!['pending','failed'].includes(task.status)) continue;
        let status;
        try {
          // A newer restored reference always wins, even for identical bytes.
          if (this.referenced(userId,task.kind,task.record_id,task.filename)) status='retained';
          else {
            const file=this.filePath(userId,task.kind,task.record_id,task.filename);
            if (!file) status='removed';
            else {
              const original=JSON.parse(task.proof);
              const current=this.proof(file,(task.kind==='expenses'?2:10)*1024*1024);
              if (!equal(original,current)) status='retained';
              else { fs.unlinkSync(file); status='removed'; }
            }
          }
        } catch (error) { status=missing(error)?'removed':'failed'; }
        this.setTask.run(status,userId,mutationId,task.kind,task.record_id,task.filename);
      }
      return {...this.attachments.identity(userId,expected),mutationId,householdReset:this.receipt(userId,mutationId)};
    }).immediate();
  }
  legacyWrite(userId,kind,tripId,recordId,name,ifMatch,operation) {
    return this.db.transaction(()=>{
      if (this.hasReset.get(userId)) {
        if (!ifMatch) fail(428,'PRECONDITION_REQUIRED','Refresh with a compatible client before uploading after household reset.');
        if (ifMatch!==this.sync.etag(this.sync.metadata(userId))) fail(409,'REVISION_CONFLICT','The household changed. This file action was not applied.');
        const {trip}=this.attachments.parent(userId,[kind,tripId,recordId,name]);
        if (trip.isArchived) fail(409,'TRIP_ARCHIVED','Archived trips cannot change attachments.');
      }
      return operation();
    }).immediate();
  }
  legacyReadPath(userId,kind,tripId,recordId,name) {
    if (this.hasReset.get(userId)) {
      this.attachments.parent(userId,[kind,tripId,recordId,name]);
      if (!this.referenced(userId,kind,recordId,name)) fail(404,'ATTACHMENT_NOT_FOUND','This file is no longer referenced.');
    }
    const file=this.filePath(userId,kind,recordId,name);
    if (!file) return null;
    try { if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) fail(409,'UNSAFE_ATTACHMENT_FILE','This attachment path is unsafe.'); }
    catch(error) { if (missing(error)) return null; throw error; }
    return file;
  }
  writeLegacy(userId,kind,recordId,name,bytes) {
    const file=this.filePath(userId,kind,recordId,name,true);
    try { const stat=fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) fail(409,'UNSAFE_ATTACHMENT_FILE','This attachment path is unsafe.'); }
    catch(error) { if (!missing(error)) throw error; }
    const temporary=path.join(path.dirname(file),'.upload-'+crypto.randomUUID()); let fd;
    try {
      fd=fs.openSync(temporary,'wx',0o600); fs.writeFileSync(fd,bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd=undefined;
      this.filePath(userId,kind,recordId,name); fs.renameSync(temporary,file);
    } finally { if (fd!==undefined) fs.closeSync(fd); fs.rmSync(temporary,{force:true}); }
  }
  deleteLegacy(userId,kind,recordId,name) {
    const file=this.filePath(userId,kind,recordId,name);
    if (!file) return;
    try { const stat=fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) fail(409,'UNSAFE_ATTACHMENT_FILE','This attachment path is unsafe.'); fs.unlinkSync(file); }
    catch(error) { if (!missing(error)) throw error; }
  }
}
module.exports={HouseholdResetStore};
