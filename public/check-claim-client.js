/* Public check claims: private per-link identity, durable intent, and exact retry. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BillHiveCheckClaims = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
  const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
  const hashPattern = /^[a-f0-9]{64}$/;
  const revision = value => Number.isSafeInteger(value) && value >= 0;
  const rejections = ['SHARE_CONFLICT','CHECK_COMPLETED','ITEM_REMOVED','CLAIM_LIMIT','PROTECTION_DISABLED'];
  const equal = (a, b) => canonical(a) === canonical(b);
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    return JSON.stringify(value);
  }
  // Hashing remains available on ordinary LAN HTTP origins, where SubtleCrypto
  // is absent. Identity randomness still requires crypto.getRandomValues.
  function sha256(value) {
    const input = new TextEncoder().encode(value);
    const length = Math.ceil((input.length + 9) / 64) * 64;
    const bytes = new Uint8Array(length); bytes.set(input); bytes[input.length] = 128;
    const data = new DataView(bytes.buffer); const bits = input.length * 8;
    data.setUint32(length - 8, Math.floor(bits / 4294967296)); data.setUint32(length - 4, bits >>> 0);
    const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    let h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    const rotate = (n, b) => (n >>> b) | (n << (32 - b)); const w = new Uint32Array(64);
    for (let offset = 0; offset < length; offset += 64) {
      for (let i = 0; i < 16; i++) w[i] = data.getUint32(offset + i * 4);
      for (let i = 16; i < 64; i++) {
        const a = w[i - 15], b = w[i - 2];
        w[i] = w[i - 16] + (rotate(a,7) ^ rotate(a,18) ^ (a >>> 3)) + w[i - 7] + (rotate(b,17) ^ rotate(b,19) ^ (b >>> 10));
      }
      let [a,b,c,d,e,f,g,j] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (j + (rotate(e,6) ^ rotate(e,11) ^ rotate(e,25)) + ((e & f) ^ (~e & g)) + k[i] + w[i]) | 0;
        const t2 = ((rotate(a,2) ^ rotate(a,13) ^ rotate(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        j = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h = h.map((n, i) => (n + [a,b,c,d,e,f,g,j][i]) >>> 0);
    }
    return h.map(n => n.toString(16).padStart(8, '0')).join('');
  }
  function randomKey(crypto = globalThis.crypto) {
    requireValue(crypto && typeof crypto.getRandomValues === 'function', 'Private guest identity is unavailable in this browser.');
    return Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
  }
  const identityKeys = ['serverInstanceId', 'householdId', 'checkId', 'shareId'];
  function sameIdentity(a, b) {
    requireValue(identityKeys.every(key => a[key] === b[key]), 'The server, household or check link changed. Your original selection is kept.');
  }
  function validateSnapshot(value, shareId) {
    requireValue(object(value) && value.protocolVersion === 1 && value.shareId === shareId && hashPattern.test(shareId), 'Unsupported check-sharing response.');
    requireValue(identityKeys.slice(0, 3).every(key => identifier(value[key])) && revision(value.revision) && revision(value.shareRevision) && value.shareRevision > 0 && revision(value.createdAt), 'Invalid check-sharing identity or revision.');
    requireValue(!['state','monthly','userId','token','claimantKey'].some(key => Object.hasOwn(value, key)), 'Unexpected private data in the public response.');
    requireValue(typeof value.revisionPreconditionsRequired === 'boolean' && /^[A-Z]{3}$/.test(value.currencyCode), 'Invalid check settings.');
    const check = value.check;
    requireValue(object(check) && check.id === value.checkId && typeof check.name === 'string' && typeof check.isCompleted === 'boolean' && Array.isArray(check.items), 'Invalid shared check.');
    requireValue(check.items.length <= 10000 && check.items.every(item => object(item) && identifier(item.id) && typeof item.name === 'string' && Number.isFinite(item.price) && item.price >= 0) && new Set(check.items.map(i => i.id)).size === check.items.length, 'Invalid receipt items.');
    requireValue(['taxAmount','tipAmount','discountAmount','compAmount','serviceFeeAmount'].every(key => Number.isFinite(check[key]) && check[key] >= 0), 'Invalid receipt adjustments.');
    requireValue(Array.isArray(value.claims) && value.claims.length <= 500 && value.claims.every(c => object(c) && typeof c.claimerName === 'string' &&
      typeof c.claimedAt === 'string' && Array.isArray(c.itemIds) && c.itemIds.every(identifier) && (c.claimantId === undefined || hashPattern.test(c.claimantId))), 'Invalid guest selections.');
    const identities = value.claims.flatMap(c => c.claimantId ? [c.claimantId] : []);
    requireValue(new Set(identities).size === identities.length, 'Duplicate guest identities.');
    return value;
  }
  function following(next, old) {
    sameIdentity(next, old);
    requireValue(next.revision >= old.revision && next.shareRevision >= old.shareRevision, 'The shared check revision moved backwards. Your saved data is kept.');
    requireValue(next.revision !== old.revision || equal(next.check, old.check) && next.currencyCode === old.currencyCode, 'The check changed without a new revision.');
    requireValue(next.shareRevision !== old.shareRevision || equal(next.claims, old.claims) && next.createdAt === old.createdAt, 'The selections changed without a new revision.');
  }
  function reviewed(a, b) {
    sameIdentity(a, b);
    return equal(a.check, b.check) && a.currencyCode === b.currencyCode && equal(a.claims, b.claims);
  }
  function validateDraft(draft, shareId) {
    requireValue(object(draft) && typeof draft.name === 'string' && draft.name.length <= 1000 && Array.isArray(draft.itemIds) &&
      draft.itemIds.length <= 200 && draft.itemIds.every(identifier) && new Set(draft.itemIds).size === draft.itemIds.length, 'The saved selection is invalid. It has been kept for recovery.');
    validateSnapshot(draft.baseline, shareId);
  }
  class IndexedStore {
    constructor(indexedDB = globalThis.indexedDB, name = 'billhive-public-checks-v1') { this.indexedDB = indexedDB; this.name = name; }
    async database() {
      requireValue(this.indexedDB, 'This browser cannot save a recoverable selection. Enable site storage before sending.');
      if (!this.opening) this.opening = new Promise((resolve, reject) => {
        let failed = false;
        const request = this.indexedDB.open(this.name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('links');
        request.onsuccess = () => {
          const db = request.result;
          if (failed) { db.close(); return; }
          db.onversionchange = () => { db.close(); this.opening = null; }; resolve(db);
        };
        request.onerror = () => reject(new Error('Saved selections could not be opened. Existing data is kept.'));
        request.onblocked = () => { failed = true; reject(new Error('Close other BillHive claim tabs and reopen this page.')); };
      }).catch(error => { this.opening = null; throw error; });
      return this.opening;
    }
    async transact(id, transform) {
      const db = await this.database();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('links', 'readwrite'); const store = tx.objectStore('links'); let result, failure;
        tx.oncomplete = () => resolve(clone(result));
        tx.onabort = () => reject(failure || new Error('The selection could not be saved. Keep this page open and export your choices.'));
        tx.onerror = () => {};
        const request = store.get(id);
        request.onsuccess = () => {
          try { result = transform(clone(request.result)); if (result !== undefined) store.put(result, id); }
          catch (error) { failure = error; tx.abort(); }
        };
      });
    }
  }
  class Transport {
    constructor(token, prefix = '', fetcher = globalThis.fetch.bind(globalThis)) {
      requireValue(prefix === '' || /^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+$/.test(prefix) && !prefix.split('/').some(p => p === '.' || p === '..'), 'Invalid server path.');
      this.path = prefix + '/public/share/check/' + encodeURIComponent(token) + '/sync/'; this.fetcher = fetcher;
    }
    async request(path, options = {}) {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await this.fetcher(this.path + path, {credentials:'omit', cache:'no-store', redirect:'error', ...options, signal:controller.signal});
        const limit = response.ok ? 16 * 1024 * 1024 : 8192;
        if (Number(response.headers.get('content-length') || 0) > limit) {
          await response.body?.cancel(); throw new Error('The server response is too large.');
        }
        requireValue(response.body, 'The server returned an empty response. Your saved request is kept.');
        const reader = response.body.getReader(); const chunks = []; let size = 0;
        try {
          while (true) { const {done,value} = await reader.read(); if (done) break; size += value.length; requireValue(size <= limit, 'The server response is too large.'); chunks.push(value); }
        } catch (error) { await reader.cancel(); throw error; }
        const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        let body; try { body = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes)); } catch (_) { throw new Error('The server returned an unreadable response. Your saved request is kept.'); }
        if (!response.ok) {
          const known = new Set(['SHARE_CONFLICT','CHECK_COMPLETED','ITEM_REMOVED','CLAIM_LIMIT','PROTECTION_DISABLED','SHARE_NOT_FOUND','SHARE_REVOKED','CHECK_NOT_FOUND']);
          const error = new Error(response.status === 429 ? 'Too many requests. Wait before retrying your saved selection.' : 'The selection could not be confirmed. Refresh or retry the saved request.');
          if ([400,403,404,409,410,428,429].includes(response.status) && known.has(body?.code)) error.code = body.code;
          throw error;
        }
        return body;
      } finally { clearTimeout(timer); }
    }
    load() { return this.request('snapshot'); }
    send(payload, key) { return this.request('claim', {method:'POST', headers:{'Content-Type':'application/json','X-BillHive-Claimant-Key':key,'X-BillHive-Require-Protection':'1'}, body:payload}); }
  }
  class Client {
    constructor({token, prefix = '', store = new IndexedStore(), transport, crypto = globalThis.crypto}) {
      requireValue(typeof token === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(token), 'This check link is invalid.');
      this.token = token; this.id = sha256(token); this.storageId = sha256('browser-check\0' + prefix + '\0' + token); this.crypto = crypto; this.store = store;
      this.transport = transport || new Transport(token, prefix); this.row = null;
    }
    validate(row) {
      requireValue(object(row) && row.version === 1 && row.shareId === this.id && hashPattern.test(row.key) && revision(row.generation) &&
        ['active','revoked','checkRemoved'].includes(row.access), 'Saved guest identity could not be opened. It has not been replaced.');
      requireValue(row.claimantId === sha256('check-claimant\0' + this.token + '\0' + row.key), 'The saved guest identity does not match this link.');
      if (row.snapshot) validateSnapshot(row.snapshot, this.id);
      if (row.draft) { validateDraft(row.draft, this.id); sameIdentity(row.draft.baseline, requireValueSnapshot(row)); }
      if (row.pending) {
        requireValue(typeof row.pending.payload === 'string' && object(row.pending.draft) && revision(row.pending.generation) && row.pending.generation <= row.generation &&
          (row.pending.rejection === null || rejections.includes(row.pending.rejection)), 'The saved request is invalid.');
        const request = JSON.parse(row.pending.payload); sameIdentity(request, requireValueSnapshot(row));
        requireValue(equal(Object.keys(request).sort(), [...identityKeys,'claimantId','mutationId','baseRevision','baseShareRevision','claim'].sort()), 'Unexpected saved request fields.');
        requireValue(request.claimantId === row.claimantId && identifier(request.mutationId) && request.mutationId.length >= 16 && revision(request.baseRevision) && revision(request.baseShareRevision), 'The pending request identity is invalid.');
        validateDraft(row.pending.draft, this.id);
        sameIdentity(request, row.pending.draft.baseline);
        requireValue(request.baseRevision === row.pending.draft.baseline.revision && request.baseShareRevision === row.pending.draft.baseline.shareRevision,
          'The saved request does not match its reviewed revisions.');
        requireValue(row.pending.draft.name.trim().length > 0 && row.pending.draft.name.trim().length <= 80, 'The saved request name is invalid.');
        requireValue(equal(request.claim, {claimerName:row.pending.draft.name.trim(),itemIds:row.pending.draft.itemIds}), 'The saved request does not match its selection.');
      }
      if (row.receipt) {
        requireValue(object(row.receipt) && typeof row.receipt.payload === 'string' && revision(row.receipt.committedShareRevision) && typeof row.receipt.replayed === 'boolean', 'The saved confirmation is invalid.');
        const request = JSON.parse(row.receipt.payload); sameIdentity(request, requireValueSnapshot(row));
        requireValue(request.claimantId === row.claimantId && revision(request.baseShareRevision) && row.receipt.committedShareRevision > request.baseShareRevision && object(request.claim), 'The saved confirmation belongs to a different selection.');
        validateDraft({baseline:row.snapshot,name:request.claim.claimerName,itemIds:request.claim.itemIds}, this.id);
      }
      return row;
    }
    async open() {
      this.row = await this.store.transact(this.storageId, saved => {
        if (saved !== undefined) return this.validate(saved);
        const key = randomKey(this.crypto);
        return {version:1,shareId:this.id,key,claimantId:sha256('check-claimant\0' + this.token + '\0' + key),generation:0,
          access:'active',snapshot:null,draft:null,pending:null,receipt:null};
      }); return clone(this.row);
    }
    async update(transform) {
      const expected = clone(this.row); requireValue(expected, 'Open this link before editing.');
      this.row = await this.store.transact(this.storageId, saved => {
        this.validate(saved); requireValue(equal(saved, expected), 'This selection changed in another tab. Export your unsaved choices, then reopen the saved selection.');
        const result = transform(clone(saved)); result.generation = saved.generation + 1;
        requireValue(revision(result.generation), 'The saved selection generation is invalid.'); return this.validate(result);
      }); return clone(this.row);
    }
    form() {
      if (this.row?.draft) return clone(this.row.draft);
      const snapshot = this.row?.snapshot; if (!snapshot) return null;
      // A revoked-link replay can acknowledge a later selection without exposing
      // a new public snapshot. Show that confirmed intent, not an older cached claim.
      if (this.row.receipt?.committedShareRevision > snapshot.shareRevision) {
        const claim = JSON.parse(this.row.receipt.payload).claim;
        return {baseline:clone(snapshot),name:claim.claimerName,itemIds:clone(claim.itemIds)};
      }
      const own = snapshot.claims.find(c => c.claimantId === this.row.claimantId);
      return {baseline:clone(snapshot), name:own?.claimerName || '', itemIds:clone(own?.itemIds || [])};
    }
    needsReview() { return !!(this.row?.pending?.rejection || this.row?.draft && this.row.snapshot && !reviewed(this.row.draft.baseline, this.row.snapshot)); }
    async edit(form) {
      return this.update(row => {
        requireValue((!row.pending || row.pending.rejection) && row.access === 'active', 'Retry the saved selection before editing.');
        const draft = {...clone(form),baseline:clone(row.draft?.baseline || requireValueSnapshot(row))}; validateDraft(draft, this.id);
        row.draft = draft; return row;
      });
    }
    async refresh() {
      let snapshot;
      try { snapshot = validateSnapshot(await this.transport.load(), this.id); }
      catch (error) {
        if (['SHARE_REVOKED','SHARE_NOT_FOUND','CHECK_NOT_FOUND'].includes(error.code)) await this.update(row => {
          row.access = error.code === 'CHECK_NOT_FOUND' ? 'checkRemoved' : 'revoked'; return row;
        });
        throw error;
      }
      return this.update(row => { if (row.snapshot) following(snapshot, row.snapshot); row.snapshot = clone(snapshot); return row; });
    }
    async review(form) {
      return this.update(row => {
        requireValue(!row.pending || row.pending.rejection, 'Retry the original selection before changing its review.');
        const snapshot = requireValueSnapshot(row);
        requireValue(row.access === 'active' && !snapshot.check.isCompleted && snapshot.revisionPreconditionsRequired, 'This check is unavailable for new selections. Your draft is kept.');
        requireValue(form.itemIds.every(id => snapshot.check.items.some(i => i.id === id)), 'Remove unavailable items from your selection before continuing.');
        row.draft = {...clone(form),baseline:clone(snapshot)}; validateDraft(row.draft, this.id); row.pending = null; return row;
      });
    }
    async prepare() {
      return this.update(row => {
        requireValue(!row.pending, 'Retry or review the original saved selection.');
        const snapshot = requireValueSnapshot(row); const draft = row.draft;
        requireValue(draft && reviewed(draft.baseline, snapshot), 'The check or guest selections changed. Review them before sending.');
        requireValue(row.access === 'active' && !snapshot.check.isCompleted && snapshot.revisionPreconditionsRequired, 'This check needs an open, protected server before sending selections.');
        const name = draft.name.trim(); requireValue(name.length > 0 && name.length <= 80, 'Enter a name of up to 80 characters.');
        requireValue(draft.itemIds.every(id => snapshot.check.items.some(i => i.id === id)), 'Review items that were removed from this check.');
        const request = Object.fromEntries(identityKeys.map(key => [key,snapshot[key]]));
        Object.assign(request, {claimantId:row.claimantId,baseRevision:snapshot.revision,baseShareRevision:snapshot.shareRevision,
          mutationId:'claim-' + randomKey(this.crypto),claim:{claimerName:name,itemIds:clone(draft.itemIds)}});
        // The current snapshot may include unrelated household revisions since
        // review. Pin the pending copy to exactly the revisions sent to the server.
        row.draft = {...clone(draft),baseline:clone(snapshot)};
        row.pending = {payload:JSON.stringify(request),draft:clone(row.draft),generation:row.generation,rejection:null}; return row;
      });
    }
    async submit() {
      const expected = clone(this.row);
      requireValue(expected?.pending && !expected.pending.rejection, 'There is no pending selection to retry.');
      const sent = await this.store.transact(this.storageId, current => {
        this.validate(current);
        requireValue(current.key === expected.key && current.pending?.payload === expected.pending.payload && !current.pending.rejection,
          'The saved request changed in another tab. Reopen the saved selection before retrying.');
        return current;
      });
      this.row = clone(sent); const pending = sent.pending;
      let receipt;
      try { receipt = await this.transport.send(pending.payload, sent.key); }
      catch (error) {
        if (rejections.includes(error.code)) {
          this.row = await this.store.transact(this.storageId, current => {
            this.validate(current);
            if (current.pending?.payload !== pending.payload || current.key !== sent.key) return current;
            current.pending.rejection = error.code; current.generation++; return this.validate(current);
          });
        }
        throw error;
      }
      this.validateReceipt(pending.payload, receipt);
      this.row = await this.store.transact(this.storageId, current => {
        this.validate(current); requireValue(current.key === sent.key, 'The guest identity changed. Keep the original saved request.');
        if (!current.pending) {
          requireValue(current.receipt?.payload === pending.payload && current.receipt.committedShareRevision === receipt.committedShareRevision, 'This selection is no longer awaiting confirmation.'); return current;
        }
        requireValue(current.pending.payload === pending.payload, 'A different selection is pending. Its saved request is kept.');
        if (receipt.snapshot) {
          const old = requireValueSnapshot(current), next = receipt.snapshot;
          if (next.revision >= old.revision && next.shareRevision >= old.shareRevision) { following(next, old); current.snapshot = clone(next); }
          else { requireValue(next.revision <= old.revision && next.shareRevision <= old.shareRevision, 'The sharing revision streams disagree. Keep the saved request.'); following(old, next); }
        } else current.access = receipt.access;
        if (equal(current.draft, pending.draft)) current.draft = null;
        current.receipt = {payload:pending.payload,committedShareRevision:receipt.committedShareRevision,replayed:receipt.replayed};
        current.pending = null; current.generation++; return this.validate(current);
      });
      return clone(receipt);
    }
    validateReceipt(payload, receipt) {
      const request = JSON.parse(payload);
      requireValue(object(receipt) && receipt.protocolVersion === 1 && typeof receipt.replayed === 'boolean' && revision(receipt.committedShareRevision), 'Invalid selection receipt.');
      sameIdentity(receipt, request);
      requireValue(receipt.claimantId === request.claimantId && receipt.mutationId === request.mutationId && receipt.committedShareRevision > request.baseShareRevision, 'The receipt does not match the saved request.');
      if (receipt.snapshot == null) {
        requireValue(receipt.replayed && ['revoked','checkRemoved'].includes(receipt.access), 'Missing confirmed selection snapshot.'); return;
      }
      const s = validateSnapshot(receipt.snapshot, this.id); sameIdentity(s, request);
      requireValue(receipt.access === 'active' && s.revision >= request.baseRevision && s.shareRevision >= receipt.committedShareRevision, 'The receipt snapshot moved backwards.');
      if (!receipt.replayed) {
        requireValue(s.revisionPreconditionsRequired && s.revision === request.baseRevision && s.shareRevision === receipt.committedShareRevision, 'Invalid committed selection revision.');
        const own = s.claims.find(c => c.claimantId === request.claimantId);
        requireValue(own && own.claimerName === request.claim.claimerName && equal(own.itemIds, request.claim.itemIds), 'The saved selection differs from the request.');
      }
    }
    async discard() { return this.update(row => { requireValue(!row.pending || row.pending.rejection, 'Retry the unknown selection before discarding it.'); row.draft = null; row.pending = null; return row; }); }
    recovery(working = null) {
      const row = this.row;
      return JSON.stringify({format:'billhive-browser-check-claim-recovery',version:1,access:row?.access || 'unavailable',snapshot:row?.snapshot || null,
        draft:row?.draft || null,working, pendingRequest:row?.pending ? JSON.parse(row.pending.payload) : null,pendingRejection:row?.pending?.rejection || null}, null, 2);
    }
  }
  function requireValueSnapshot(row) { requireValue(row.snapshot, 'Refresh this check before sending a selection.'); return row.snapshot; }
  return {Client, IndexedStore, Transport, sha256, validateSnapshot, following, reviewed, canonical};
});
