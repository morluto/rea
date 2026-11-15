/** An allocated root the fixture owns; `close` removes it. */
export interface VerifierFixtureRoot {
  readonly path: string;
  close(): Promise<void>;
}

/** A directory the verifier keeps after the run; nothing removes it. */
export interface VerifierArtifactDirectory {
  readonly path: string;
  readonly kept: true;
}

/**
 * One verifier fixture root and every cleanup that must confirm before the
 * root may be removed. A failed cleanup retains the root and names it.
 */
export class VerifierFixture {
  constructor(root: VerifierFixtureRoot);
  /**
   * Allocate a `PrivateRuntimeRoot` under `parent` (default: the OS temporary
   * directory), or a plain temporary directory with `private: false`.
   */
  static open(options?: {
    readonly prefix?: string;
    readonly parent?: string;
    readonly private?: boolean;
  }): Promise<VerifierFixture>;
  /**
   * Allocate a directory a verifier keeps for its artifacts (receipts,
   * transcripts, profiles, Evidence). It is never removed; allocation names
   * it on stderr.
   */
  static keepArtifacts(options?: {
    readonly prefix?: string;
    readonly parent?: string;
  }): Promise<VerifierArtifactDirectory>;
  readonly path: string;
  readonly released: boolean;
  /** Register a cleanup that must confirm before the root may be removed. */
  releaseAfter<T extends () => unknown>(cleanup: T): T;
  /**
   * Run cleanups now, in order; one that fails stays registered, so `release`
   * retries it and keeps the root until it confirms. Failures are thrown as
   * an AggregateError.
   */
  closeEarly(cleanups: readonly (() => unknown)[]): Promise<void>;
  /**
   * Keep the root for good: something that may still use it cannot be
   * confirmed stopped. Every later release fails with `reason`.
   */
  retain(reason: string): void;
  /**
   * Run pending cleanups in order, then remove the root if all confirmed. A
   * failure is an AggregateError whose `cleanupLeases` is `[this fixture]`.
   */
  release(): Promise<void>;
  /**
   * Run pending cleanups as `release` does, then keep the root instead of
   * removing it and name it and `reason` on stderr. A failed cleanup fails
   * the same way `release` does.
   */
  keep(reason: string): Promise<void>;
}

/**
 * Share one cleanup between fixtures that depend on it: a confirmed or
 * in-flight attempt is reused; a failed attempt is retried by the next call.
 */
export function onceConfirmed(cleanup: () => unknown): () => Promise<void>;

/**
 * Run a verifier and release its fixture, keeping both failures. When the
 * fixture is retained, the thrown failure's `cleanupLeases` is `[fixture]`.
 */
export function withVerifierFixture<T>(
  fixture: VerifierFixture,
  operation: (fixture: VerifierFixture) => T | Promise<T>,
): Promise<T>;
