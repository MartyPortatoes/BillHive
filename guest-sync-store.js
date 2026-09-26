'use strict';

const crypto = require('node:crypto');
const Data = require('./public/data-contract');
const {SyncError} = require('./sync-store');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !['__proto__','constructor','prototype'].includes(value);
const fail = (status, code, message) => { throw new SyncError(status, code, message); };
const expenseFields = new Set(['id','name','amount','paidByAmounts','splitBetweenIds','dateISO','category',
  'customCategoryName','customCategoryIconName','sourceAmount','sourceCurrency','exchangeRate',
  'exchangeRateTargetCurrency','exchangeRateIsLocked','exchangeRateDateISO','exchangeRateSource','notes']);
const settlementFields = new Set(['id','fromMemberId','toMemberId','amount','settledAtISO','notes','sourceActionId']);
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (record(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function fields(value, allowed) { return record(value) && Object.keys(value).every(key => allowed.has(key)); }
function amountText(amount, currency) {
  if (!amount) return '';
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return String(amount);
  try {
    const digits = new Intl.NumberFormat('en', {style:'currency', currency}).resolvedOptions().maximumFractionDigits;
    return currency + ' ' + Number(amount).toFixed(digits);
  } catch (_) { return String(amount); }
}

// The owner history stays private: public trip projection deliberately omits it.
function recordGuestActivity(trip, change, invite, mutationId, now = new Date()) {
  if (!change) return;
  const actor = (trip.members || []).find(member => member.id === invite.member_id);
  const eventId = 'activity-' + crypto.createHash('sha256').update(invite.token + ':' + mutationId).digest('hex');
  const events = Array.isArray(trip.activity) ? trip.activity : [];
  if (events.some(event => event?.id === eventId)) return;
  const event = {id:eventId, ...change, actorName:actor?.name || 'Trip guest', actorMemberId:invite.member_id,
    createdAtISO:now.toISOString().replace(/\.\d{3}Z$/, 'Z')}; // Apple's trip activity decoder expects whole seconds.
  // Keep this confirmed change even if imported events contain future dates.
  const timestamp = event => { const value=Date.parse(event?.createdAtISO);return Number.isFinite(value)?value:Number.NEGATIVE_INFINITY; };
  const ordered = events.slice().sort((a,b) => timestamp(b) - timestamp(a));
  trip.activity = [event, ...ordered.slice(0,99)];
}

/** Invite-scoped receipts share the owner's revision but never return an owner's household snapshot. */
class GuestTripSync {
  constructor(db, sync, projectTrip) {
    this.db = db; this.sync = sync; this.projectTrip = projectTrip;
    db.exec(`CREATE TABLE IF NOT EXISTS sync_guest_receipts (
      token_hash TEXT NOT NULL, mutation_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      user_id TEXT NOT NULL, trip_id TEXT NOT NULL, member_id TEXT NOT NULL,
      revision INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY(token_hash, mutation_id)
    )`);
    this.findInvite = db.prepare('SELECT * FROM trip_invites WHERE token=?');
    this.readTrips = db.prepare("SELECT value FROM user_state WHERE user_id=? AND key='trips'");
    this.findReceipt = db.prepare('SELECT * FROM sync_guest_receipts WHERE token_hash=? AND mutation_id=?');
    this.saveReceipt = db.prepare('INSERT INTO sync_guest_receipts(token_hash,mutation_id,request_hash,user_id,trip_id,member_id,revision) VALUES (?,?,?,?,?,?,?)');
  }

  invite(token) {
    const invite = this.findInvite.get(token);
    if (!invite) fail(404, 'INVITE_NOT_FOUND', 'Invite not found.');
    return invite;
  }
  context(invite) {
    if (invite.revoked_at) return {access:'revoked'};
    if (!invite.joined_at) return {access:'notJoined'};
    const row = this.readTrips.get(invite.owner_user_id);
    if (!row) return {access:'tripRemoved'};
    const trips = JSON.parse(row.value);
    Data.state({trips});
    const trip = trips.trips.find(item => item.id === invite.trip_id);
    if (!trip) return {access:'tripRemoved'};
    if (!(trip.members || []).some(member => member.id === invite.member_id)) return {access:'memberRemoved'};
    return {access:'active', trips, trip};
  }
  requireAccess(context) {
    const errors = {
      revoked:[410,'INVITE_REVOKED','This invite has been revoked.'],
      notJoined:[403,'INVITE_NOT_JOINED','Accept this invite before editing.'],
      tripRemoved:[404,'TRIP_NOT_FOUND','Trip not found.'],
      memberRemoved:[410,'MEMBER_REMOVED','This trip member was removed.'],
    };
    if (context.access !== 'active') fail(...errors[context.access]);
  }
  snapshotInside(invite, context) {
    this.requireAccess(context);
    return {protocolVersion:1, ...this.sync.metadata(invite.owner_user_id),
      invitationId:crypto.createHash('sha256').update(invite.token).digest('hex'),
      tripId:invite.trip_id, memberId:invite.member_id,
      revisionPreconditionsRequired:this.sync.requirePreconditions, trip:this.projectTrip(context.trip)};
  }
  snapshot(token) {
    return this.db.transaction(() => {
      const invite = this.invite(token);
      return this.snapshotInside(invite, this.context(invite));
    }).immediate();
  }

  validate(body) {
    const allowed = new Set(['serverInstanceId','householdId','invitationId','tripId','memberId','baseRevision','mutationId','operation']);
    if (!fields(body, allowed) || !['serverInstanceId','householdId','invitationId','tripId','memberId','mutationId'].every(key => id(body[key])) ||
        body.mutationId.length < 16 || !Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0) {
      fail(400, 'INVALID_GUEST_COMMIT', 'Invalid guest identity, revision or mutation ID.');
    }
    try { Data.tree(body); } catch (_) { fail(400, 'INVALID_GUEST_COMMIT', 'Invalid guest commit.'); }
    const operation = body.operation;
    if (!record(operation)) fail(400, 'INVALID_GUEST_COMMIT', 'Expected a guest operation.');
    if (operation.kind === 'upsertExpense') {
      const expense = operation.expense;
      if (!fields(operation, new Set(['kind','expense'])) || !fields(expense, expenseFields) || !id(expense.id) ||
          typeof expense.name !== 'string' || expense.name.length > 512 ||
          typeof expense.amount !== 'number' || !Number.isFinite(expense.amount) || expense.amount < 0 || expense.amount > 1e12 ||
          !record(expense.paidByAmounts) || !Array.isArray(expense.splitBetweenIds) ||
          expense.splitBetweenIds.some(member => !id(member)) || new Set(expense.splitBetweenIds).size !== expense.splitBetweenIds.length ||
          Object.entries(expense.paidByAmounts).some(([member, amount]) => !id(member) || typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 1e12)) {
        fail(400, 'INVALID_GUEST_COMMIT', 'Invalid guest expense.');
      }
      for (const key of ['dateISO','category','customCategoryName','customCategoryIconName','sourceCurrency',
        'exchangeRateTargetCurrency','exchangeRateDateISO','exchangeRateSource','notes']) {
        if (key in expense && (typeof expense[key] !== 'string' || expense[key].length > 10000)) fail(400, 'INVALID_GUEST_COMMIT', 'Invalid expense text.');
      }
      for (const key of ['sourceAmount','exchangeRate']) {
        if (key in expense && (typeof expense[key] !== 'number' || !Number.isFinite(expense[key]) || expense[key] < 0 || (key === 'exchangeRate' && expense[key] === 0))) fail(400, 'INVALID_GUEST_COMMIT', 'Invalid conversion amount.');
      }
      if ('exchangeRateIsLocked' in expense && typeof expense.exchangeRateIsLocked !== 'boolean') fail(400, 'INVALID_GUEST_COMMIT', 'Invalid conversion lock.');
    } else if (operation.kind === 'deleteExpense') {
      if (!fields(operation, new Set(['kind','expenseId'])) || !id(operation.expenseId)) fail(400, 'INVALID_GUEST_COMMIT', 'Invalid expense deletion.');
    } else if (operation.kind === 'recordSettlement') {
      const settlement = operation.settlement;
      if (!fields(operation, new Set(['kind','settlement'])) || !fields(settlement, settlementFields) ||
          !['id','fromMemberId','toMemberId'].every(key => id(settlement[key])) || settlement.fromMemberId === settlement.toMemberId ||
          typeof settlement.amount !== 'number' || !Number.isFinite(settlement.amount) || settlement.amount <= 0 || settlement.amount > 1e12) fail(400, 'INVALID_GUEST_COMMIT', 'Invalid settlement.');
      for (const key of ['settledAtISO','notes']) {
        if (key in settlement && (typeof settlement[key] !== 'string' || settlement[key].length > 10000)) fail(400, 'INVALID_GUEST_COMMIT', 'Invalid settlement text.');
      }
      if (settlement.sourceActionId != null && !id(settlement.sourceActionId)) fail(400, 'INVALID_GUEST_COMMIT', 'Invalid settlement action ID.');
    } else fail(400, 'INVALID_GUEST_COMMIT', 'Unsupported guest operation.');
    return body;
  }

  apply(trip, operation) {
    const members = new Set((trip.members || []).map(member => member.id));
    if (operation.kind === 'upsertExpense') {
      const expense = operation.expense;
      if (Object.keys(expense.paidByAmounts).some(member => !members.has(member)) || expense.splitBetweenIds.some(member => !members.has(member)) ||
          !expense.splitBetweenIds.length || !Object.values(expense.paidByAmounts).some(amount => amount > 0) && expense.amount > 0) {
        fail(400, 'INVALID_GUEST_EXPENSE', 'Choose current payers and split members.');
      }
      const expenses = trip.expenses || [];
      const index = expenses.findIndex(item => item.id === expense.id);
      const before = index >= 0 ? expenses[index] : null;
      // Public clients cannot replace host attachments/import metadata or future private fields.
      if (index >= 0) expenses[index] = {...expenses[index], ...expense}; else expenses.unshift(expense);
      trip.expenses = expenses;
      if (before && canonical(before) === canonical(expenses[index])) return null;
      return {kind:before ? 'expenseUpdated' : 'expenseAdded', subjectId:expense.id, subjectName:expense.name,
        amountText:amountText(expense.amount, trip.currency), detail:''};
    } else if (operation.kind === 'deleteExpense') {
      const removed = (trip.expenses || []).find(item => item.id === operation.expenseId);
      trip.expenses = (trip.expenses || []).filter(item => item.id !== operation.expenseId);
      return removed ? {kind:'expenseDeleted', subjectId:removed.id, subjectName:removed.name || '',
        amountText:amountText(removed.amount, trip.currency), detail:''} : null;
    } else {
      const settlement = operation.settlement;
      if (!members.has(settlement.fromMemberId) || !members.has(settlement.toMemberId)) fail(400, 'INVALID_GUEST_SETTLEMENT', 'Choose current trip members.');
      const settlements = trip.settlements || [];
      const existing = settlements.find(item => item.id === settlement.id);
      if (existing && canonical(existing) !== canonical(settlement)) fail(409, 'SETTLEMENT_ID_REUSED', 'This settlement ID already exists.');
      if (!existing) settlements.push(settlement);
      trip.settlements = settlements;
      const from = trip.members.find(member => member.id === settlement.fromMemberId).name || 'Trip member';
      const to = trip.members.find(member => member.id === settlement.toMemberId).name || 'Trip member';
      return existing ? null : {kind:'settlementRecorded', subjectId:settlement.id, subjectName:'', amountText:'',
        detail:from + ' → ' + to + ' · ' + amountText(settlement.amount, trip.currency)};
    }
  }

  commit(token, body, {requireProtection = false} = {}) {
    const input = this.validate(body);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const requestHash = crypto.createHash('sha256').update(canonical(input)).digest('hex');
    return this.db.transaction(() => {
      const invite = this.invite(token);
      const metadata = this.sync.metadata(invite.owner_user_id);
      if (input.serverInstanceId !== metadata.serverInstanceId || input.householdId !== metadata.householdId || input.invitationId !== tokenHash ||
          input.tripId !== invite.trip_id || input.memberId !== invite.member_id) {
        fail(409, 'HOUSEHOLD_CHANGED', 'The server, household or invitation changed.');
      }
      const receipt = this.findReceipt.get(tokenHash, input.mutationId);
      if (receipt && receipt.request_hash !== requestHash) fail(409, 'MUTATION_ID_REUSED', 'This mutation ID was used with different data.');
      const context = this.context(invite);
      const envelope = {protocolVersion:1, serverInstanceId:metadata.serverInstanceId, householdId:metadata.householdId,
        invitationId:tokenHash, tripId:invite.trip_id, memberId:invite.member_id, mutationId:input.mutationId};
      if (receipt) {
        // A revoked token can acknowledge only its own prior request; it cannot see current trip data.
        return {userId:invite.owner_user_id, response:{...envelope, committedRevision:receipt.revision, replayed:true,
          access:context.access, snapshot:context.access === 'active' ? this.snapshotInside(invite, context) : null}};
      }
      this.requireAccess(context);
      if (requireProtection && !this.sync.requirePreconditions) fail(428, 'PROTECTION_DISABLED', 'Enable server revision protection before editing.');
      if (input.baseRevision !== metadata.revision) fail(409, 'REVISION_CONFLICT', 'The household changed. Your guest edit was not applied.');
      if (context.trip.isArchived) fail(409, 'TRIP_ARCHIVED', 'This trip is archived.');
      const change = this.apply(context.trip, input.operation);
      recordGuestActivity(context.trip, change, invite, input.mutationId);
      Data.state({trips:context.trips});
      this.sync.setState.run(invite.owner_user_id, 'trips', JSON.stringify(context.trips));
      this.sync.validateReferences(invite.owner_user_id);
      const snapshot = this.snapshotInside(invite, context);
      this.saveReceipt.run(tokenHash,input.mutationId,requestHash,invite.owner_user_id,invite.trip_id,invite.member_id,snapshot.revision);
      return {userId:invite.owner_user_id, response:{...envelope, committedRevision:snapshot.revision, replayed:false, access:'active', snapshot}};
    }).immediate();
  }
}
module.exports = {GuestTripSync};
