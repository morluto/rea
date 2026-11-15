import { rm } from "node:fs/promises";

import { createCanonicalTemporaryDirectory } from "./canonical-temporary-directory.mjs";
import { withVerifierCleanup } from "./verifier-cleanup.mjs";
import { importVerifierSource } from "./verifier-source-loader.mjs";

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
  #root;
  #pending = [];
  #released = false;
  #releasing;

  /** Take ownership of a root that is already allocated: `{ path, close() }`. */
  constructor(root) {
    this.#root = root;
  }

  /**
   * Allocate a private root under `parent` (default: the OS temporary
   * directory). `private: false` allocates a plain temporary directory for
   * child scratch space: on Windows a private root keeps a DELETE handle that
   * blocks children from creating temporary directories beneath it.
   */
  static async open({ prefix, parent, private: owned = true } = {}) {
    if (!owned) {
      const { path } = await createCanonicalTemporaryDirectory(
        prefix ?? "rea-verifier-",
        ...(parent === undefined ? [] : [parent]),
      );
      return new VerifierFixture({
        path,
        close: () => rm(path, { recursive: true, force: true }),
      });
    }
    const { PrivateRuntimeRoot } = await importVerifierSource(
      new URL("../../src/process/PrivateRuntimeRoot.ts", import.meta.url).href,
      import.meta.url,
    );
    return new VerifierFixture(
      await PrivateRuntimeRoot.create({
        prefix: prefix ?? "rea-verifier-",
        ...(parent === undefined ? {} : { parent }),
      }),
    );
  }

  get path() {
    return this.#root.path;
  }

  /** True once every registered cleanup and the root removal have confirmed. */
  get released() {
    return this.#released;
  }

  /** Register a cleanup that must confirm before the root may be removed. */
  releaseAfter(cleanup) {
    if (this.#released || this.#releasing !== undefined)
      throw new Error(
        `Verifier fixture ${this.path} is already being released; register its cleanups before release.`,
      );
    this.#pending.push(cleanup);
    return cleanup;
  }

  /** Concurrent callers share one attempt; a failed attempt can be retried. */
  release() {
    if (this.#released) return Promise.resolve();
    this.#releasing ??= this.#attemptRelease().finally(() => {
      this.#releasing = undefined;
    });
    return this.#releasing;
  }

  async #attemptRelease() {
    const failures = [];
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
 */
export function withVerifierFixture(fixture, operation) {
  return withVerifierCleanup(
    () => operation(fixture),
    [() => fixture.release()],
  );
}
