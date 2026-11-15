import {
  retainProcessInspectionCleanup,
  processInspectionCancellationError,
} from "../providers/OwnedCommandCleanup.js";
import { runWithExecutionLimits } from "./PlaywrightElectronExecution.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { bindArtifactFileCleanup } from "../artifacts/ArtifactFileOperation.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { ElectronCaptureCleanup } from "./ElectronCaptureCleanup.js";
import { ElectronCaptureProfile } from "./ElectronCaptureProfile.js";
import { AnalysisCleanupLeaseGroup } from "../artifacts/AnalysisCleanupLease.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { analysisErrorWithCancellation } from "../domain/analysisErrorCancellation.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { electronFuseFailure } from "../electron/ElectronFuseFailures.js";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { _electron as electron } from "playwright-core";

import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../application/AnalysisProvider.js";
import type {
  CanonicalElectronActiveObservationInput,
  ElectronActiveObservationPort,
} from "../application/javascript/ElectronActiveObservationPort.js";
import type { ElectronActiveObservationResult } from "../domain/javascript/electronActiveObservation.js";
import {
  AnalysisError,
  primaryAnalysisError,
} from "../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import type {
  PersistentOwnedProcessGroup,
  ProcessLineageObservation,
} from "../process/ProcessOwnership.js";
import { ProcessOwnershipEvidenceOwner } from "../process/ProcessOwnershipEvidence.js";
import {
  observeOwnedProcessLineage,
  prepareProcessOwnershipInspection,
  systemProcessOwnershipHost,
} from "../process/ProcessOwnershipObservation.js";
import {
  runElectronActions,
  readApplicationState,
  readFinalApplicationState,
} from "./PlaywrightElectronActiveActions.js";
import { projectElectronActiveCapture } from "./PlaywrightElectronActiveProjection.js";
import { readElectronFuseImage } from "../electron/ElectronFuseReader.js";
import { assertNodeCliInspectArgumentsSupported } from "./PlaywrightElectronActiveFuses.js";

const OPERATION = "capture_electron_scenario" as const;
const STARTUP_TIMEOUT_MS = 60_000;

import { PLAYWRIGHT_ELECTRON_ACTIVE_PROVIDER_IDENTITY } from "./providerIdentities.js";

const hookPath = fileURLToPath(
  new URL("../../scripts/electron-active-hook.cjs", import.meta.url),
);

type ElectronApplication = Awaited<ReturnType<typeof electron.launch>>;
type ElectronPaths = {
  readonly executable: string;
  readonly application: string;
  readonly root: string;
  readonly profile: CanonicalElectronActiveObservationInput["profile"];
};

/** Launch an owned Electron application through the official Playwright API. */
export class PlaywrightElectronActiveProvider implements ElectronActiveObservationPort {
  readonly #resources = new ArtifactResourceScope();
  readonly #shutdown = new AbortController();

  /** Stop admitting work, cancel and join captures, then retry exact retained resource owners. */
  async close(): Promise<void> {
    this.#shutdown.abort(new Error("Electron active provider is closing"));
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw providerError(cause);
    }
  }

  constructor(
    private readonly environment: Readonly<Record<string, string | undefined>>,
    // Load Playwright only when a capture launches; MCP startup stays off its module graph.
    private readonly launch: typeof electron.launch = async (options) =>
      (await import("playwright-core"))._electron.launch(options),
    private readonly readFuseImage: typeof readElectronFuseImage = readElectronFuseImage,
  ) {}

  identity(): ProviderIdentity {
    return PLAYWRIGHT_ELECTRON_ACTIVE_PROVIDER_IDENTITY;
  }

  async capture(
    input: CanonicalElectronActiveObservationInput,
    options: ExecutionOptions = {},
  ): Promise<Result<ElectronActiveObservationResult, AnalysisError>> {
    const signal = AbortSignal.any([
      this.#shutdown.signal,
      ...(options.signal === undefined ? [] : [options.signal]),
    ]);
    try {
      return await this.#resources.run(() =>
        this.#capture(input, { ...options, signal }),
      );
    } catch (cause: unknown) {
      return err(providerError(cause));
    }
  }

  async #capture(
    input: CanonicalElectronActiveObservationInput,
    options: ExecutionOptions,
  ): Promise<Result<ElectronActiveObservationResult, AnalysisError>> {
    let application: ElectronApplication | undefined;
    let ownership: PersistentOwnedProcessGroup | undefined;
    let lineage: ProcessLineageObservation | undefined;
    let capture: ElectronActiveObservationResult | undefined;
    let paths: ElectronPaths | undefined;
    let profile: ElectronCaptureProfile | undefined;
    let initialState:
      | Awaited<ReturnType<typeof readApplicationState>>
      | undefined;
    let actions: ElectronActiveObservationResult["actions"] = [];
    let outcome: Result<ElectronActiveObservationResult, AnalysisError>;
    const runId = randomUUID();
    try {
      if (options.signal?.aborted === true)
        throw new BrowserObservationError(OPERATION, "cancelled", {
          cause: options.signal.reason,
        });
      await inspectOwnership(
        () => prepareProcessOwnershipInspection(options.signal),
        this.#resources,
      );
      const startupDeadline = performance.now() + STARTUP_TIMEOUT_MS;
      paths = {
        executable: input.executable_path,
        application: input.application_path,
        root: input.application_root,
        profile: input.profile,
      };
      const preflight = assertNodeCliInspectArgumentsSupported(
        input.executable_path,
        {
          resources: this.#resources,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          readFuseImage: this.readFuseImage,
        },
      ).catch((cause: unknown) => {
        throw electronFuseFailure(cause, input.executable_path, OPERATION);
      });
      try {
        await runWithExecutionLimits(
          preflight,
          options.signal,
          startupDeadline,
        );
      } catch (interruption: unknown) {
        // A startup interruption cannot abandon an admitted descriptor's final
        // close. Its physical/cleanup failure takes precedence over the race.
        await preflight;
        throw interruption;
      }
      const captureBaseline = await inspectOwnership(
        () => systemProcessOwnershipHost.captureBaseline?.(options.signal),
        this.#resources,
      );
      if (options.signal?.aborted)
        throw new BrowserObservationError(OPERATION, "cancelled", {
          cause: options.signal.reason,
        });
      if (input.profile === "isolated")
        profile = await ElectronCaptureProfile.create();
      const applicationArgs = [
        "-r",
        hookPath,
        paths.application,
        ...input.args,
      ];
      const launchOptions: Parameters<typeof electron.launch>[0] = {
        executablePath: paths.executable,
        cwd: paths.root,
        env: {
          ...safeElectronEnvironment(
            this.environment,
            runId,
            process.platform,
            profile,
          ),
          REA_ELECTRON_CAPTURE_ARGV: JSON.stringify({
            length: applicationArgs.length,
            sha256: createHash("sha256")
              .update(JSON.stringify(applicationArgs))
              .digest("hex"),
          }),
        },
        args: applicationArgs,
        timeout: Math.max(1, startupDeadline - performance.now()),
      };
      application = await containLaunchRejections(() => {
        if (options.signal?.aborted === true)
          throw new BrowserObservationError(OPERATION, "cancelled", {
            cause: options.signal.reason,
          });
        return this.launch(launchOptions);
      });
      const leaderPid = application.process().pid;
      if (
        typeof leaderPid !== "number" ||
        !Number.isSafeInteger(leaderPid) ||
        leaderPid <= 0
      )
        throw new BrowserObservationError(
          OPERATION,
          "process_ownership_unavailable",
        );
      ownership = {
        runId,
        leaderPid,
        processGroupId: leaderPid,
        expectedParentPid: process.pid,
        expectedCommand: paths.executable,
        sweepTokenOwnedProcesses: true,
        evidenceOwner: new ProcessOwnershipEvidenceOwner(),
        ...(captureBaseline === undefined ? {} : { captureBaseline }),
      };
      lineage = await observeOwnedProcessLineage(ownership);
      initialState = await runWithExecutionLimits(
        readApplicationState(application),
        options.signal,
        startupDeadline,
      );
      const actionOutcome = await runElectronActions(
        application,
        input,
        options,
        this.#resources,
      );
      actions = actionOutcome.actions;
      if (actionOutcome.cleanupError !== undefined)
        throw actionOutcome.cleanupError;
      const state = await readFinalApplicationState(
        application,
        options.signal,
      );
      capture = projectElectronActiveCapture(paths, actions, state);
      outcome = ok(capture);
    } catch (cause: unknown) {
      if (paths !== undefined && initialState !== undefined) {
        const retainedCapture = projectElectronActiveCapture(
          paths,
          actions,
          initialState,
        );
        capture = {
          ...retainedCapture,
          limitations: [
            ...retainedCapture.limitations,
            `Capture stopped after the initial pre-action snapshot: ${cause instanceof Error ? cause.message : String(cause)}. Final Windows, metrics, IPC, and timeline state is unknown; the retained snapshot may omit action effects.`,
          ],
        };
      }
      const error = providerError(cause);
      if (capture !== undefined)
        error.retainPartialObservation({
          kind: "electron-active-observation",
          capture,
        });
      outcome = err(error);
    }
    if (application === undefined && profile !== undefined)
      return await this.#releaseUnlaunchedProfile(profile, outcome, options);
    if (application !== undefined) {
      const owner = new ElectronCaptureCleanup(
        application,
        ownership,
        lineage,
        profile,
      );
      const released = await owner.release(this.#resources);
      const cleanup = owner.processResult;
      outcome = captureOutcomeWithCancellation(outcome, options.signal);
      if (
        released.processes.kind === "failed" ||
        released.transport.kind === "failed" ||
        released.profile.kind === "failed"
      ) {
        const processFailure = released.processes.kind === "failed";
        const failures = [
          released.processes,
          released.transport,
          released.profile,
        ].flatMap((attempt) =>
          attempt.kind === "failed" ? [attempt.cause] : [],
        );
        const cause =
          failures.length === 1
            ? failures[0]
            : new AggregateError(
                failures,
                "Electron process and transport cleanup failed",
              );
        const reason = failures
          .map((failure) =>
            failure instanceof Error ? failure.message : String(failure),
          )
          .join("; ");
        const failure = new BrowserObservationError(
          OPERATION,
          "cleanup_failed",
          {
            cause,
            detail: `${processFailure ? "Electron process cleanup could not be verified" : released.transport.kind === "failed" ? "Electron transport teardown failed after process cleanup" : "The private Electron profile could not be removed after process cleanup"}: ${reason}. Collected observations are retained when available.`,
            cleanup: { reason, resources: owner.pendingResources },
            ...(capture === undefined
              ? {}
              : {
                  partialObservation: {
                    kind: "electron-active-observation" as const,
                    capture: processFailure
                      ? {
                          ...capture,
                          application: {
                            ...capture.application,
                            cleanup: "unverified" as const,
                          },
                        }
                      : capture,
                  },
                }),
          },
        );
        owner.bind(failure);
        if (outcome.ok) return err(failure);
        const composed = analysisErrorWithCleanupFailure(
          outcome.error,
          failure,
          OPERATION,
        ).bindCleanupDependencies([outcome.error, failure]);
        if (failure.partialObservation !== undefined)
          composed.partialObservation = failure.partialObservation;
        return err(composed);
      }
      if (outcome.ok && cleanup?.cleaned && cleanup.unverified !== undefined)
        outcome = ok({
          ...outcome.value,
          limitations: [
            ...outcome.value.limitations,
            ...cleanup.unverified.map(
              ({ pid, diagnostic }) =>
                `Ownership of unrelated process ${String(pid)} could not be verified; it was left untouched: ${diagnostic}`,
            ),
          ],
        });
    }
    // Cleanup failures returned above keep precedence; a completed capture
    // observed under late cancellation is retained as partial Evidence.
    return captureOutcomeWithCancellation(outcome, options.signal);
  }

  /** A launch that never produced an application still owns its private profile. */
  async #releaseUnlaunchedProfile(
    profile: ElectronCaptureProfile,
    outcome: Result<ElectronActiveObservationResult, AnalysisError>,
    options: ExecutionOptions,
  ): Promise<Result<ElectronActiveObservationResult, AnalysisError>> {
    const lease = ElectronCaptureCleanup.profileLease(profile);
    const released = await this.#resources.release({
      kind: "lease",
      resource: "electron_profile",
      lease,
    });
    const settled = captureOutcomeWithCancellation(outcome, options.signal);
    if (released.kind === "released") return settled;
    const reason =
      released.cause instanceof Error
        ? released.cause.message
        : String(released.cause);
    const failure = new BrowserObservationError(OPERATION, "cleanup_failed", {
      cause: released.cause,
      detail: `The private Electron profile could not be removed: ${reason}.`,
      cleanup: { reason, resources: ["electron_profile"] },
    });
    new AnalysisCleanupLeaseGroup(failure, [lease]);
    if (settled.ok) return err(failure);
    return err(
      analysisErrorWithCleanupFailure(
        settled.error,
        failure,
        OPERATION,
      ).bindCleanupDependencies([settled.error, failure]),
    );
  }
}

/** Normalize only explicit facts emitted by the inspection owner. */
const inspectOwnership = async <T>(
  inspect: () => Promise<T> | undefined,
  resources: ArtifactResourceScope,
): Promise<T | undefined> => {
  try {
    return await inspect();
  } catch (cause: unknown) {
    const cancellation = processInspectionCancellationError(cause, OPERATION);
    const primary =
      cancellation === undefined ? providerError(cause) : cancellation;
    throw retainProcessInspectionCleanup(cause, primary, resources, OPERATION);
  }
};

/** Keep existing failures and their cleanup owners when cancellation arrives later. */
const captureOutcomeWithCancellation = (
  outcome: Result<ElectronActiveObservationResult, AnalysisError>,
  signal: AbortSignal | undefined,
): Result<ElectronActiveObservationResult, AnalysisError> => {
  if (signal?.aborted !== true) return outcome;
  if (outcome.ok) return err(cancelledCapture(outcome.value, signal.reason));
  const primary = primaryAnalysisError(outcome.error);
  if (
    (primary instanceof AnalysisCancelledError ||
      primary.userCategory === "cancelled") &&
    Object.is(primary.cause, signal.reason)
  )
    return outcome;
  return err(
    analysisErrorWithCancellation(
      outcome.error,
      new AnalysisCancelledError(OPERATION, { cause: signal.reason }),
    ),
  );
};

const cancelledCapture = (
  capture: ElectronActiveObservationResult,
  reason: unknown,
): BrowserObservationError =>
  new BrowserObservationError(OPERATION, "cancelled", {
    cause: reason,
    partialObservation: { kind: "electron-active-observation", capture },
  });

/**
 * Select the launched application's environment.
 *
 * With a private profile, every per-user location (home, temp, Windows
 * application data) points into it; without one, the operator's real
 * locations are passed by explicit caller choice.
 */
export const safeElectronEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
  runId: string,
  platform: NodeJS.Platform = process.platform,
  profile?: ElectronCaptureProfile,
): Record<string, string> => ({
  ...operatorElectronEnvironment(environment, platform, profile !== undefined),
  ...profile?.environment(platform),
  REA_PROCESS_RUN_ID: runId,
});

const PROFILE_LOCATION_VARIABLES = new Set(["HOMEDRIVE", "HOMEPATH"]);

const operatorElectronEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  isolated: boolean,
): Record<string, string> =>
  Object.fromEntries(
    [
      "HOME",
      "LANG",
      "PATH",
      "TMP",
      "TMPDIR",
      "USER",
      "DISPLAY",
      "XAUTHORITY",
      "WAYLAND_DISPLAY",
      ...(platform === "win32"
        ? [
            "SYSTEMROOT",
            "TEMP",
            "APPDATA",
            "LOCALAPPDATA",
            "USERPROFILE",
            "COMSPEC",
            "PATHEXT",
            "PROGRAMDATA",
            "ALLUSERSPROFILE",
            "USERNAME",
            "SYSTEMDRIVE",
            "HOMEDRIVE",
            "HOMEPATH",
          ]
        : []),
    ]
      .filter((name) => !isolated || !PROFILE_LOCATION_VARIABLES.has(name))
      .map((name) => [name, environment[name]] as const)
      .filter(
        (entry): entry is readonly [string, string] => entry[1] !== undefined,
      ),
  );

const PLAYWRIGHT_INTERNAL_FRAME = /playwright-core[\\/]lib[\\/]/;
interface LaunchRejectionScope {
  failure?: unknown;
}
const activeLaunches = new Set<LaunchRejectionScope>();
const heldLaunchRejections = new Map<
  Promise<unknown>,
  {
    readonly reason: Error;
    readonly candidates: Set<LaunchRejectionScope>;
    readonly hadExternalListener: boolean;
  }
>();

const holdLaunchRejection = (
  reason: unknown,
  promise: Promise<unknown>,
): void => {
  if (
    !(reason instanceof Error) ||
    !PLAYWRIGHT_INTERNAL_FRAME.test(reason.stack ?? "")
  )
    throw reason;
  if (!heldLaunchRejections.has(promise))
    heldLaunchRejections.set(promise, {
      reason,
      candidates: new Set(activeLaunches),
      hadExternalListener: process
        .listeners("unhandledRejection")
        .some((listener) => listener !== holdLaunchRejection),
    });
};

const forwardLaunchRejection = (
  reason: Error,
  hadExternalListener: boolean,
): void => {
  // Listeners present at the original event already observed it. When the
  // holding listener was the only listener, restore Node's fatal behavior.
  if (!hadExternalListener)
    process.nextTick(() => {
      throw reason;
    });
};

/** Playwright leaves rejected launch promises unhandled; absorb only those that repeat this launch's failure. */
const containLaunchRejections = async <T>(
  launch: () => Promise<T>,
): Promise<T> => {
  const scope: LaunchRejectionScope = {};
  if (activeLaunches.size === 0)
    process.on("unhandledRejection", holdLaunchRejection);
  activeLaunches.add(scope);
  try {
    return await launch();
  } catch (cause: unknown) {
    scope.failure = cause;
    throw cause;
  } finally {
    await new Promise<void>((resolve) => setImmediate(resolve));
    activeLaunches.delete(scope);
    if (activeLaunches.size === 0)
      process.off("unhandledRejection", holdLaunchRejection);
    for (const [
      promise,
      { reason, candidates, hadExternalListener },
    ] of heldLaunchRejections) {
      if (!candidates.delete(scope)) continue;
      if (
        scope.failure instanceof Error &&
        reason.message !== "" &&
        scope.failure.message.includes(reason.message)
      )
        heldLaunchRejections.delete(promise);
      else if (candidates.size === 0) {
        heldLaunchRejections.delete(promise);
        forwardLaunchRejection(reason, hadExternalListener);
      }
    }
  }
};

const providerError = (cause: unknown): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined) {
    const failure = new ProviderCleanupError(
      PLAYWRIGHT_ELECTRON_ACTIVE_PROVIDER_IDENTITY.id,
      cause.cleanup.resources,
      { reason: cause.cleanup.reason },
      { operation: OPERATION, cause },
    );
    bindArtifactFileCleanup(cause, failure);
    return failure;
  }
  return new ProviderAdapterError(
    PLAYWRIGHT_ELECTRON_ACTIVE_PROVIDER_IDENTITY.id,
    OPERATION,
    {
      cause,
      diagnostics: {
        message: cause instanceof Error ? cause.message : String(cause),
      },
    },
  );
};
