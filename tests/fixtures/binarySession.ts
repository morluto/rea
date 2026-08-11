import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createAnalysisProfile } from "../../src/domain/analysisProfile.js";
import type { BinaryTarget } from "../../src/domain/binaryTarget.js";
import type { AnalysisError } from "../../src/domain/errors.js";
import type { Result } from "../../src/domain/result.js";
import type {
  AnalysisClient,
  AnalysisClientFactory,
  CapabilityDescriptor,
  AnalysisProfileResolution,
  AnalysisProfileResolutionOptions,
  AnalysisProvider,
} from "../../src/application/AnalysisProvider.js";
import { BinarySession } from "../../src/application/BinarySession.js";
import { SessionProviderRouter } from "../../src/application/SessionProviderRouter.js";
import { HopperStartError } from "../../src/domain/errors.js";
import { err, ok as resultOk } from "../../src/domain/result.js";
import { observed } from "./analysisExecution.js";
import { createTestTempDirectory } from "./temporaryDirectory.js";

type TestBinarySessionOptions = {
  readonly resolveAnalysisProfile?: (
    target: BinaryTarget,
    options?: AnalysisProfileResolutionOptions,
  ) => Promise<Result<AnalysisProfileResolution, AnalysisError>>;
};

type TestBinarySessionOptionsOrResolver =
  | TestBinarySessionOptions
  | TestBinarySessionOptions["resolveAnalysisProfile"];

/** Create a focused session around a test-owned provider or client factory. */
export const createTestBinarySession = (
  provider: AnalysisProvider | AnalysisClientFactory,
  optionsOrResolver?: TestBinarySessionOptionsOrResolver,
): BinarySession => {
  const options =
    typeof optionsOrResolver === "function"
      ? { resolveAnalysisProfile: optionsOrResolver }
      : (optionsOrResolver ?? {});
  return new BinarySession(SessionProviderRouter.single(provider, options));
};

/** Materialize two distinct targets for session lifecycle tests. */
export const createBinarySessionTargets = async (): Promise<
  readonly [string, string]
> => {
  const directory = await createTestTempDirectory("rea-binary-session-");
  const first = join(directory, "first.hop");
  const second = join(directory, "second.hop");
  await Promise.all([writeFile(first, "one"), writeFile(second, "two")]);
  return [first, second];
};

/** Create a provider whose calls and declared effects are observable by tests. */
export const createCacheProvider = (
  calls: string[],
  mayWriteFilesystem = false,
): AnalysisProvider => {
  const identity = {
    id: "fixture",
    name: "Fixture analysis provider",
    version: "1",
  } as const;
  return {
    identity: () => identity,
    resolveAnalysisProfile: () =>
      Promise.resolve(
        resultOk({
          profile: createAnalysisProfile(identity, 1, { fixture: true }),
          compatibility: {},
        }),
      ),
    capabilities: () => [
      cacheCapability(identity, "address_name", false, mayWriteFilesystem),
      cacheCapability(identity, "set_address_name", true),
    ],
    createClient: () => ({
      execute: (operation) => {
        calls.push(operation);
        return Promise.resolve(observed(operation));
      },
      close: () => Promise.resolve(),
    }),
  };
};

/** Controllable client used to observe session replacement and cancellation. */
export class ControllableAnalysisClient implements AnalysisClient {
  closed = 0;

  constructor(
    readonly pendingHealth?: Promise<ReturnType<typeof observed>>,
    readonly failHealth = false,
    readonly pendingCall?: Promise<ReturnType<typeof observed>>,
  ) {}

  execute(name: string) {
    if (name === "health")
      return this.failHealth
        ? Promise.resolve(err(new HopperStartError()))
        : (this.pendingHealth ?? Promise.resolve(observed(null)));
    return this.pendingCall ?? Promise.resolve(observed(null));
  }

  close(): Promise<void> {
    this.closed += 1;
    return Promise.resolve();
  }
}

/** Create an explicitly resolved promise for lifecycle interleaving tests. */
export const createDeferred = <T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} => {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
};

const cacheCapability = (
  provider: CapabilityDescriptor["provider"],
  operation: "address_name" | "set_address_name",
  mutatesArtifact: boolean,
  mayWriteFilesystem = false,
): CapabilityDescriptor => ({
  provider,
  operation,
  inputContractVersion: 1,
  outputContractVersion: 1,
  available: true,
  reason: null,
  pagination: "none",
  exhaustive: true,
  effects: {
    mutatesArtifact,
    launchesProcess: false,
    mayShowUi: false,
    mayAccessNetwork: false,
    mayWriteFilesystem,
    changesPermissions: false,
    requiresRoot: false,
  },
  limits: {
    maxResults: null,
    maxPayloadBytes: null,
    timeoutMs: null,
  },
  limitations: [],
});
