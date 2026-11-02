/** Selected fields of one fixture's token-verified ready record. */
export interface NativeUiFixtureScope {
  readonly pid: number;
  readonly window_id: number;
}

/** Owns one LaunchServices fixture from before its launch through verified exit. */
export interface NativeUiFixtureOwner {
  readonly root: string;
  /** Compile into the root; release stops this as swiftc requires and joins it. */
  compile(arguments_: readonly string[]): Promise<unknown>;
  /** Launch one fixture and return its token-verified ready scope. */
  launch(application: string): Promise<NativeUiFixtureScope>;
  /** Release every owned resource; failure retains them for another close. */
  close(): Promise<void>;
}

/** Cleanup stays incomplete; the owner keeps its run token and root for retry. */
export class NativeUiFixtureCleanupFailure extends Error {
  readonly _tag: "NativeUiFixtureCleanupFailure";
  readonly cleanupOwner: NativeUiFixtureOwner;
  readonly root: string;
  readonly runId: string;
}

/** Allocate one private fixture root and the owner that alone may remove it. */
export function createNativeUiFixtureOwner(options?: {
  readonly launcherCommand?: string;
  readonly readyTimeoutMs?: number;
}): Promise<NativeUiFixtureOwner>;

/**
 * Run one lane around a fixture owner and settle its process outcome in one
 * place. Exits 130 or 143 when an interruption is the first failure.
 */
export function runNativeUiFixtureLane<Value>(
  operation: (fixture: NativeUiFixtureOwner) => Promise<Value>,
  options?: {
    readonly launcherCommand?: string;
    readonly readyTimeoutMs?: number;
  },
): Promise<Value>;
