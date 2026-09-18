/* Serial immutable writes; failures stay queued until an explicit retry/edit. */
(function(root) {
  class SnapshotWriter {
    constructor(send, changed = () => {}) { this.send = send; this.changed = changed; this.pending = new Map(); this.running = null; this.error = null; }
    get dirty() { return this.pending.size > 0 || this.running !== null; }
    enqueue(path, value) { this.pending.set(path, JSON.stringify(value)); this.changed(); return this.flush(); }
    flush() {
      if (this.running) return this.running;
      this.error = null;
      this.running = Promise.resolve().then(async () => {
        while (this.pending.size) {
          const [path, body] = this.pending.entries().next().value;
          await this.send(path, body);
          // Acknowledging an older snapshot must never erase a newer edit.
          if (this.pending.get(path) === body) this.pending.delete(path);
        }
      }).catch(error => { this.error = error; throw error; }).finally(() => { this.running = null; this.changed(); });
      return this.running;
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = SnapshotWriter;
  else root.SnapshotWriter = SnapshotWriter;
})(typeof globalThis !== 'undefined' ? globalThis : this);
