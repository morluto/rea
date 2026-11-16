import { rm } from "node:fs/promises";

import { createCanonicalTemporaryDirectory } from "./canonical-temporary-directory.mjs";
import { withVerifierCleanup } from "./verifier-cleanup.mjs";
import { importVerifierSource } from "./verifier-source-loader.mjs";

// Named types come from the declaration file TypeScript consumers import.
/** @typedef {import("./verifier-fixture.mjs").VerifierFixtureRoot} VerifierFixtureRoot */
/**
 * One cleanup that must confirm; a rejection or throw means it did not.
 * @typedef {() => unknown} VerifierCleanupTask
 */
/** @typedef {typeof import("../../src/process/PrivateRuntimeRoot.js")} PrivateRuntimeRootModule */

/**
 * One verifier fixture root and everything that may still use files under it.
 *
 * The root is a `PrivateRuntimeRoot` from `src/process`. MCP clients and
 * transports, sessions, sentinels and checks that need the files register
 * with `releaseAfter`. `release` attempts each one in registration order and
 * removes the root only when all of them have confirmed. If any fails, the
 * root stays, the failure names it and carries the fixture as its
 * `cleanupLeases`. A later `release` retries only the cleanups that have not
 * confirmed, then the root.
 */
export class VerifierFixture {
  /** @type {VerifierFixtureRoot} */
  #root;
  /** @type {VerifierCleanupTask[]} */
  #pending = [];
  #released = false;
  /** @type {Promise<void> | undefined} */
  #releasing;
  // Closed when the first release starts and never reopened: a resource that
  // joined after others had closed would be released out of order.
  #registrationClosed = false;

  /**
   * Take ownership of a root that is already allocated: `{ path, close() }`.
   * @param {VerifierFixtureRoot} root
   */
  constructor(root) {
    this.#root = root;
  }

  /**
   * Allocate a private root under `parent` (default: the OS temporary
   * directory). `private: false` allocates a plain temporary directory for
   * child scratch space: on Windows a private root keeps a DELETE handle that
   * blocks children from creating temporary directories beneath it. Its
   * removal retries Windows sharing violations (`EBUSY`, `EPERM`) while a
   * child that has exited still holds a handle on a file beneath it.
   * @param {{ readonly prefix?: string; readonly parent?: string; readonly private?: boolean }} [options]
   */
  static async open({ prefix, parent, private: owned = true } = {}) {
    if (!owned) {
      const { path } = await createCanonicalTemporaryDirectory(
        prefix ?? "rea-verifier-",
        ...(parent === undefined ? [] : [parent]),
      );
      return new VerifierFixture({
        path,
        close: () =>
          rm(path, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 25,
          }),
      });
    }
    // The loader imports the TypeScript source this module type describes.
    const { PrivateRuntimeRoot } = /** @type {PrivateRuntimeRootModule} */ (
      await importVerifierSource(
        new URL("../../src/process/PrivateRuntimeRoot.ts", import.meta.url)
          .href,
        import.meta.url,
      )
    );
    return new VerifierFixture(
      await PrivateRuntimeRoot.create({
        prefix: prefix ?? "rea-verifier-",
        ...(parent === undefined ? {} : { parent }),
      }),
    );
  }

  /**
   * Allocate a directory a verifier keeps for the artifacts a reviewer reads
   * after the run: receipts, transcripts, client profiles and Evidence. It is
   * never removed. Allocation names it on stderr, so a run that fails before
   * writing its receipt still reports where its artifacts are.
   * @param {{ readonly prefix?: string; readonly parent?: string }} [options]
   */
  static async keepArtifacts({ prefix, parent } = {}) {
    const { path } = await createCanonicalTemporaryDirectory(
      prefix ?? "rea-verifier-artifacts-",
      ...(parent === undefined ? [] : [parent]),
    );
    process.stderr.write(`Keeping verifier artifacts at ${path}\n`);
    return Object.freeze({ path, kept: true });
  }

  get path() {
    return this.#root.path;
  }

  /** True once every registered cleanup and the root removal have confirmed. */
  get released() {
    return this.#released;
  }

  /**
   * Register a cleanup that must confirm before the root may be removed.
   * @template {VerifierCleanupTask} T
   * @param {T} cleanup
   * @returns {T}
   */
  releaseAfter(cleanup) {
    if (this.#registrationClosed)
      throw new Error(
        `Verifier fixture ${this.path} is already being released; register its cleanups before release.`,
      );
    this.#pending.push(cleanup);
    return cleanup;
  }

  /**
   * Close resources the verifier is done with before the fixture is released,
   * such as an auxiliary MCP client. Each cleanup runs now, in order, even
   * after an earlier one fails. One that fails stays registered, so `release`
   * retries it and keeps the root until it confirms; the failures are thrown.
   * @param {Iterable<VerifierCleanupTask>} cleanups
   */
  async closeEarly(cleanups) {
    /** @type {unknown[]} */
    const failures = [];
    for (const cleanup of cleanups) {
      const once = this.releaseAfter(onceConfirmed(cleanup));
      try {
        await once();
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Verifier cleanup failed");
  }

  /**
   * Keep the root for good: something that may still use its files cannot be
   * confirmed stopped and has no cleanup this fixture could retry (an owned
   * command whose cleanup is incomplete). Every release then fails, naming
   * `reason` and the root.
   * @param {string} reason
   */
  retain(reason) {
    this.releaseAfter(() => {
      throw new Error(reason);
    });
  }

  /** Concurrent callers share one attempt; a failed attempt can be retried. */
  release() {
    return this.#settle(true);
  }

  /**
   * Run every registered cleanup as `release` does, then keep the root for a
   * reviewer instead of removing it, and name it and `reason` on stderr. A
   * run keeps its fixture this way only on request; a cleanup that fails
   * retains the root as `release` would, and a later `keep` retries it.
   * @param {string} reason
   */
  async keep(reason) {
    await this.#settle(false);
    process.stderr.write(`Keeping verifier fixture ${this.path}: ${reason}\n`);
  }

  /**
   * @param {boolean} removeRoot
   * @returns {Promise<void>}
   */
  #settle(removeRoot) {
    if (this.#released) return Promise.resolve();
    this.#registrationClosed = true;
    this.#releasing ??= this.#attemptRelease(removeRoot).finally(() => {
      this.#releasing = undefined;
    });
    return this.#releasing;
  }

  /** @param {boolean} removeRoot */
  async #attemptRelease(removeRoot) {
    /** @type {unknown[]} */
    const failures = [];
    /** @type {VerifierCleanupTask[]} */
    const unconfirmed = [];
    for (const cleanup of this.#pending) {
      try {
        await cleanup();
      } catch (cause) {
        failures.push(cause);
        unconfirmed.push(cleanup);
      }
    }
    this.#pending = unconfirmed;
    if (failures.length > 0)
      throw this.#retained([
        ...failures,
        new Error(
          `Retained verifier fixture ${this.path} because a cleanup that may still use it did not confirm.`,
        ),
      ]);
    // A kept root stays allocated; it is not released.
    if (!removeRoot) return;
    try {
      await this.#root.close();
    } catch (cause) {
      throw this.#retained([
        cause,
        new Error(`Retained verifier fixture ${this.path}.`),
      ]);
    }
    this.#released = true;
  }

  // The failure carries this fixture as its cleanup lease, so whoever holds
  // the failure can retry the release.
  /** @param {readonly unknown[]} errors */
  #retained(errors) {
    return Object.assign(
      new AggregateError(errors, "Verifier cleanup failed"),
      { cleanupLeases: [this] },
    );
  }
}

/**
 * Run a verifier against its fixture and release the fixture afterwards,
 * keeping both the verification failure and any cleanup failure.
 * @template T
 * @param {VerifierFixture} fixture
 * @param {(fixture: VerifierFixture) => T | Promise<T>} operation
 * @returns {Promise<T>}
 */
export async function withVerifierFixture(fixture, operation) {
  try {
    return await withVerifierCleanup(
      () => operation(fixture),
      [() => fixture.release()],
    );
  } catch (cause) {
    // The caller holds this failure, so it carries the retained fixture as
    // its own cleanup lease rather than only on a nested cleanup error.
    if (!fixture.released && typeof cause === "object" && cause !== null)
      Object.assign(cause, { cleanupLeases: [fixture] });
    throw cause;
  }
}

/**
 * Share one cleanup between fixtures that each depend on it: concurrent and
 * later calls reuse a confirmed or in-flight attempt, and a failed attempt is
 * retried by the next call.
 * @param {VerifierCleanupTask} cleanup
 * @returns {() => Promise<unknown>}
 */
export function onceConfirmed(cleanup) {
  /** @type {Promise<unknown> | undefined} */
  let attempt;
  return () => {
    attempt ??= Promise.resolve()
      .then(cleanup)
      .catch((cause) => {
        attempt = undefined;
        throw cause;
      });
    return attempt;
  };
}
