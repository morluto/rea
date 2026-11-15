/** An allocated root the fixture owns; `close` removes it. */
export interface VerifierFixtureRoot {
  readonly path: string;
  close(): Promise<void>;
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
  readonly path: string;
  readonly released: boolean;
  /** Register a cleanup that must confirm before the root may be removed. */
  releaseAfter<T extends () => unknown>(cleanup: T): T;
  /**
   * Run pending cleanups in order, then remove the root if all confirmed. A
   * failure is an AggregateError whose `cleanupLeases` is `[this fixture]`.
   */
  release(): Promise<void>;
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
