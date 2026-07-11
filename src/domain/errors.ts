/** Base class for expected Hopper integration failures. */
export abstract class HopperError extends Error {
  abstract readonly _tag: string;
}

/** Hopper did not respond within the configured operation deadline. */
export class HopperTimeoutError extends HopperError {
  readonly _tag = "HopperTimeoutError";

  constructor(readonly timeoutMs: number) {
    super(`Hopper did not respond within ${String(timeoutMs)}ms`);
  }
}

/** The caller cancelled a Hopper operation before it completed. */
export class HopperCancelledError extends HopperError {
  readonly _tag = "HopperCancelledError";

  constructor() {
    super("Hopper operation was cancelled");
  }
}

/** Hopper returned bytes or JSON that do not satisfy the NDJSON RPC contract. */
export class HopperProtocolError extends HopperError {
  readonly _tag = "HopperProtocolError";
}

/** Hopper's JSON-RPC endpoint returned an expected remote error response. */
export class HopperRemoteError extends HopperError {
  readonly _tag = "HopperRemoteError";

  constructor(
    readonly code: number,
    readonly safeMessage: string,
  ) {
    super(`Hopper request failed (${String(code)}): ${safeMessage}`);
  }
}

/** The owned Hopper bridge stopped before its client was closed. */
export class HopperProcessError extends HopperError {
  readonly _tag = "HopperProcessError";

  constructor(readonly exitCode: number | null) {
    super(`Hopper bridge stopped unexpectedly with code ${String(exitCode)}`);
  }
}

/** Hopper did not make the repository bridge available after launch. */
export class HopperUnavailableError extends HopperError {
  readonly _tag = "HopperUnavailableError";

  constructor() {
    super(
      "Hopper did not start the analysis bridge. Check the target and loader architecture options, then retry.",
    );
  }
}

/** Hopper or the repository bridge could not be started. */
export class HopperStartError extends HopperError {
  readonly _tag = "HopperStartError";

  constructor(options?: ErrorOptions) {
    super("Hopper application bridge could not be started", options);
  }
}

/** Runtime configuration could not be parsed safely. */
export class ConfigurationError extends HopperError {
  readonly _tag = "ConfigurationError";
}
