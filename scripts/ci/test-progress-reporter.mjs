/** @typedef {import("vitest/node").Reporter} Reporter */
/** @typedef {import("vitest/node").TestModule} TestModule */

const REPORT_INTERVAL_MS = 30_000;
const ACTIVE_SAMPLE_SIZE = 5;

/** @implements {Reporter} */
export default class TestProgressReporter {
  /** @type {Map<string, { file: string, since: number }>} */
  #active = new Map();
  #total = 0;
  #completed = 0;
  /** @type {NodeJS.Timeout | undefined} */
  #timer;

  /** @param {import("vitest/node").Vitest} context */
  onInit(context) {
    context.onClose(() => this.#stop());
  }

  /** @param {ReadonlyArray<unknown>} specifications */
  onTestRunStart(specifications) {
    this.#stop();
    this.#active.clear();
    this.#completed = 0;
    this.#total = specifications.length;
    this.#timer = setInterval(() => this.#logProgress(), REPORT_INTERVAL_MS);
    this.#timer.unref();
  }

  /** @param {Pick<TestModule, "id" | "relativeModuleId">} module */
  onTestModuleQueued(module) {
    // Enqueue precedes collection, so a stuck import appears in the log too.
    const first = this.#active.size === 0 && this.#completed === 0;
    this.#active.set(module.id, {
      file: module.relativeModuleId,
      since: performance.now(),
    });
    if (first) this.#logProgress();
  }

  /** @param {Pick<TestModule, "id">} module */
  onTestModuleEnd(module) {
    if (this.#active.delete(module.id)) this.#completed += 1;
  }

  onTestRunEnd() {
    this.#stop();
  }

  #stop() {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #logProgress() {
    const now = performance.now();
    const oldestActive = [
      ...this.#active.values().take(ACTIVE_SAMPLE_SIZE),
    ].map(({ file, since }) => ({
      file,
      seconds: Math.floor((now - since) / 1_000),
    }));
    // Keep each snapshot on one line even when a path contains control characters.
    console.log(
      `[test-shard] ${this.#completed}/${this.#total} modules completed, ${this.#active.size} active. Oldest active: ${JSON.stringify(oldestActive)}`,
    );
  }
}
