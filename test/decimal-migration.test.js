'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {SyncStore} = require('../sync-store');
const {GuestTripSync} = require('../guest-sync-store');

test('old SQLite owner and guest receipt tables migrate without changing stored decimal tokens or hashes', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE user_state(user_id TEXT,key TEXT,value TEXT,updated_at INTEGER DEFAULT 0,PRIMARY KEY(user_id,key));
      CREATE TABLE monthly_data(user_id TEXT,month_key TEXT,data TEXT,updated_at INTEGER DEFAULT 0,PRIMARY KEY(user_id,month_key));
      CREATE TABLE trip_invites(token TEXT PRIMARY KEY);
      CREATE TABLE sync_receipts(user_id TEXT,mutation_id TEXT,request_hash TEXT,revision INTEGER,created_at INTEGER DEFAULT 0,PRIMARY KEY(user_id,mutation_id));
      CREATE TABLE sync_guest_receipts(token_hash TEXT,mutation_id TEXT,request_hash TEXT,user_id TEXT,trip_id TEXT,member_id TEXT,revision INTEGER,created_at INTEGER DEFAULT 0,PRIMARY KEY(token_hash,mutation_id));
      INSERT INTO sync_receipts VALUES ('owner','old-owner','old-owner-hash',7,123);
      INSERT INTO sync_guest_receipts VALUES ('invite','old-guest','old-guest-hash','owner','trip','guest',7,123);
    `);
    const source = '{"amount":999999999999.0003,"rate":1.333333333333333333333333333333}';
    db.prepare('INSERT INTO user_state VALUES (?,?,?,0)').run('owner','future',source);
    const sync = new SyncStore(db,{requirePreconditions:true});
    const guests = new GuestTripSync(db,sync,value => value);
    assert.deepEqual(sync.receipt.get('owner','old-owner'),{request_hash:'old-owner-hash',revision:7,hash_version:1});
    assert.equal(guests.findReceipt.get('invite','old-guest').hash_version,1);
    assert.equal(db.prepare("SELECT value FROM user_state WHERE user_id='owner'").get().value,source);
    assert.equal(JSON.stringify(sync.snapshot('owner').state.future),source);
    const baseline = sync.snapshot('owner');
    const committed = sync.commit('owner',{serverInstanceId:baseline.serverInstanceId,householdId:baseline.householdId,baseRevision:baseline.revision,
      mutationId:'new-owner-decimal-request',decimalJSONProtocol:1,state:{},monthly:{}},{decimalClient:true});
    assert.equal(sync.receipt.get('owner',committed.mutationId).hash_version,2);
    new SyncStore(db); new GuestTripSync(db,sync,value => value);
    assert.equal(sync.receipt.get('owner','old-owner').request_hash,'old-owner-hash');
    assert.equal(guests.findReceipt.get('invite','old-guest').request_hash,'old-guest-hash');
  } finally { db.close(); }
});
