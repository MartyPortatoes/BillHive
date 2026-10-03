/* Revision-aware atomic snapshots. A request with an uncertain outcome keeps its original ID/body. */
(function(root) {
  'use strict';
  const Data = typeof module !== 'undefined' && module.exports ? require('./data-contract') : root.BHData;
  function uuid() {
    const bytes = root.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    return Array.from(bytes, value => value.toString(16).padStart(2,'0')).join('');
  }
  function failure(code, message) { const error = new Error(message);error.code = code;return error; }
  function validate(snapshot) {
    if (snapshot?.protocolVersion !== 1 || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 ||
        !snapshot.serverInstanceId || !snapshot.householdId || !snapshot.userId) throw failure('INVALID_SNAPSHOT','The server returned an incompatible snapshot.');
    if (snapshot.requiresDecimalClient === true) throw failure('DECIMAL_CLIENT_REQUIRED','This household contains precise amounts or rates that this web client cannot safely edit. Open it in an app with exact decimal support. Your server data has been kept.');
    Data.state(snapshot.state);Data.months(snapshot.monthly);return snapshot;
  }
  class RevisionClient {
    constructor(send, createId = uuid) { this.send = send;this.createId = createId;this.baseline = null;this.attempt = null;this.blocked = null; }
    load(snapshot) {
      validate(snapshot);
      if (this.attempt) throw failure('PENDING_COMMIT','Confirm the pending save before replacing the baseline.');
      this.baseline = structuredClone(snapshot);this.blocked = null;
    }
    get headers() {
      const b = this.baseline;
      return b ? {'If-Match':`"bh1:${b.serverInstanceId}:${b.householdId}:${b.revision}"`,'X-BillHive-User':b.userId} : {};
    }
    async sendSnapshot(document) {
      if (this.blocked) throw this.blocked;
      if (!this.baseline) throw failure('NOT_LOADED','Load the household before saving.');
      Data.state(document.state);Data.months(document.monthly);
      const serialized = JSON.stringify(document);
      // If a previous response was lost, resolve that exact attempt before considering newer input.
      if (this.attempt) {
        const previous = this.attempt.document;
        await this.confirmAttempt();
        if (previous === serialized) return;
      }
      const baseline = this.baseline;
      this.attempt = {document:serialized, request:{
        serverInstanceId:baseline.serverInstanceId, householdId:baseline.householdId,
        baseRevision:baseline.revision, mutationId:this.createId(),
        state:structuredClone(document.state), monthly:structuredClone(document.monthly),
        deleteStateKeys:Object.keys(baseline.state).filter(key => !Object.hasOwn(document.state,key)),
        deleteMonths:Object.keys(baseline.monthly).filter(key => !Object.hasOwn(document.monthly,key)),
      }};
      await this.confirmAttempt();
    }
    async confirmAttempt() {
      const request = this.attempt.request;
      const result = validate(await this.send(structuredClone(request)));
      if (result.serverInstanceId !== request.serverInstanceId || result.householdId !== request.householdId ||
          result.userId !== this.baseline.userId || result.mutationId !== request.mutationId ||
          !Number.isSafeInteger(result.committedRevision) || result.committedRevision < request.baseRevision || result.revision < result.committedRevision) {
        this.blocked = failure('INVALID_RECEIPT','The save response did not match this household and request. Your local edits are kept.');
        throw this.blocked;
      }
      if (result.revision !== result.committedRevision) {
        // Acknowledging an old save does not make a stale newer full snapshot safe to send.
        this.blocked = failure('REVIEW_REQUIRED','Your earlier save succeeded, then the household changed elsewhere. Download your unsaved copy and reload to review it.');
        throw this.blocked;
      }
      this.baseline = structuredClone(result);this.attempt = null;
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = RevisionClient;
  else root.RevisionClient = RevisionClient;
})(typeof globalThis !== 'undefined' ? globalThis : this);
