// One retention policy for exact process, preparation and file cleanup leases.
// The referenced timer keeps entrypoints alive until every owner confirms release.
export class CleanupRetention {
  #entries = new Map();
  #timer;

  get size() {
    return this.#entries.size;
  }
  get(owner) {
    return this.#entries.get(owner);
  }
  values() {
    return this.#entries.values();
  }

  retain(owner, entry) {
    if (!this.#entries.has(owner)) this.#entries.set(owner, entry);
    this.#schedule();
    return this.#entries.get(owner);
  }

  async retry() {
    for (const [owner, { lease }] of this.#entries) {
      try {
        await lease.release();
        this.#entries.delete(owner);
      } catch {
        // Never forget authority or resolve an error after an unverified close.
      }
    }
    if (!this.size) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    return this.size;
  }

  #schedule() {
    if (this.#timer || !this.size) return;
    this.#timer = setTimeout(async () => {
      try {
        await this.retry();
      } finally {
        this.#timer = undefined;
        this.#schedule();
      }
    }, 1_000);
  }
}
