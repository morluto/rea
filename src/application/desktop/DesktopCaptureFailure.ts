import type { ProviderProcessInspectionCleanup } from "../../process/ProviderProcess.js";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "../../artifacts/AnalysisCleanupLease.js";
import {
  ArtifactResourceRetryFailure,
  ArtifactResourceScope,
} from "../../artifacts/ArtifactResourceScope.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
import {
  ProviderAdapterError,
  type ProviderAdapterErrorOptions,
} from "../../domain/providerAdapterError.js";
import { describeValidationFailure } from "../../domain/validationFailure.js";
import {
  DesktopSessionCleanupError,
  type UnresolvedCleanup,
} from "../../desktop/DesktopApplicationSession.js";
import type { DesktopContentStore } from "../../desktop/DesktopContentStore.js";
import { XpropUnavailableError } from "../../desktop/X11WindowObserver.js";
import type { CaptureFile } from "./DesktopCaptureOutput.js";
import {
  DESKTOP_OPERATION,
  DESKTOP_PROVIDER,
  desktopOperationFailure,
  unavailable,
} from "./DesktopCaptureRefusals.js";

/** The parts of the content store its cleanup uses. */
type ContentOwner = Pick<
  DesktopContentStore,
  "close" | "discard" | "directory"
>;

const HANDLES_UNCLOSED =
  "a retained file's handle could not be closed after a retry";
const CAPTURE_FILE_UNCLOSED =
  "the unpublished capture file's handle could not be closed after a retry";
const PROCESS_REMEDIATION =
  "Check for processes still carrying the listed run token and stop them before capturing again.";

/**
 * Retry an owner's failed handle closes. Handles that fail again stay bound
 * through their exact leases; the owner itself backs any other failure.
 */
const closeHandles = async (
  owner: { close(): Promise<void> },
  resource: string,
  reason: string,
): Promise<readonly UnresolvedCleanup[]> =>
  owner.close().then(
    () => [],
    (cause: unknown) => [
      {
        reason,
        leases:
          cause instanceof ArtifactResourceRetryFailure
            ? cause.cleanupLeases
            : [AnalysisCleanupLease.forCloseOwner(owner, resource)],
      },
    ],
  );

const closeStoreHandles = (store: ContentOwner) =>
  closeHandles(store, store.directory, HANDLES_UNCLOSED);

/** Historical inspection facts only; cleanup authority remains with the existing owner leases. */
export class DesktopCaptureInspectionCleanupContext extends AggregateError {
  constructor(
    readonly inspectionCleanup: readonly ProviderProcessInspectionCleanup[],
    options?: ErrorOptions,
  ) {
    super(
      inspectionCleanup.flatMap((snapshot) => snapshot.causes),
      "Desktop process inspection cleanup facts",
      options,
    );
    this.name = "DesktopCaptureInspectionCleanupContext";
  }
}

/**
 * One cleanup error for every unresolved owner. The error stays incomplete,
 * and lists their current resources, until each owner releases.
 */
const cleanupError = (
  unresolved: readonly [UnresolvedCleanup, ...UnresolvedCleanup[]],
  options: (reason: string) => ProviderAdapterErrorOptions,
): ProviderAdapterError => {
  const leases = unresolved.flatMap((entry) => entry.leases);
  const cleanup = {
    reason: unresolved.map((entry) => entry.reason).join("; "),
    resources: [
      ...new Set(leases.flatMap((lease) => lease.cleanupResources ?? [])),
    ],
  };
  const errorOptions = options(cleanup.reason);
  const inspectionCleanup = [
    ...new Set(
      unresolved.flatMap((entry) =>
        entry.inspectionCleanup === undefined ? [] : [entry.inspectionCleanup],
      ),
    ),
  ];
  const error = new ProviderAdapterError(
    DESKTOP_PROVIDER.id,
    DESKTOP_OPERATION,
    {
      ...errorOptions,
      ...(inspectionCleanup.length === 0
        ? {}
        : {
            cause: new DesktopCaptureInspectionCleanupContext(
              inspectionCleanup,
              Object.hasOwn(errorOptions, "cause")
                ? { cause: errorOptions.cause }
                : undefined,
            ),
          }),
      cleanup,
    },
  );
  new AnalysisCleanupLeaseGroup(error, leases);
  return error;
};

const nonEmpty = <T>(items: readonly T[]): items is readonly [T, ...T[]] =>
  items.length > 0;

/**
 * Close the store's retained-file handles after `capture.json` was written.
 * Returns the cleanup error for anything still owned, together with the
 * session's unreleased processes, or undefined when everything was released.
 */
export const publishedCaptureCleanup = async (
  published: string,
  store: ContentOwner,
  processes: UnresolvedCleanup | undefined,
): Promise<ProviderAdapterError | undefined> => {
  const unresolved = [
    ...(processes === undefined ? [] : [processes]),
    ...(await closeStoreHandles(store)),
  ];
  if (!nonEmpty(unresolved)) return undefined;
  return cleanupError(unresolved, (reason) => ({
    userMessage: `The capture was written to ${published}, but cleanup is incomplete: ${reason}.`,
    remediationAction:
      processes === undefined
        ? "Retry the command in a new capture folder; the written capture is complete."
        : PROCESS_REMEDIATION,
    diagnostics: { capture_file: published },
  }));
};

/**
 * Remove what a capture that failed before publishing `capture.json` wrote,
 * each through the owner that wrote it, and close the handles the capture
 * file and the store still hold. Returns what could not be cleaned up, with
 * the owners that still hold it.
 */
export const discardFailedCapture = async (
  store: ContentOwner,
  captureFile: Pick<CaptureFile, "close" | "discard" | "partial">,
): Promise<readonly UnresolvedCleanup[]> => {
  const resources = new ArtifactResourceScope();
  const removals = [
    {
      reason: "the content the failed capture retained could not be removed",
      attempt: await resources.release({
        kind: "lease",
        resource: store.directory,
        lease: { release: () => store.discard() },
      }),
    },
    {
      reason: "the unpublished capture file could not be removed",
      attempt: await resources.release({
        kind: "lease",
        resource: captureFile.partial,
        lease: { release: () => captureFile.discard() },
      }),
    },
  ];
  return [
    ...removals.flatMap(({ reason, attempt }) =>
      attempt.kind === "failed" ? [{ reason, leases: [attempt.lease] }] : [],
    ),
    ...(await closeHandles(
      captureFile,
      captureFile.partial,
      CAPTURE_FILE_UNCLOSED,
    )),
    ...(await closeStoreHandles(store)),
  ];
};

const describe = (cause: unknown): string =>
  cause instanceof AnalysisError
    ? (cause.userMessage ?? cause.message)
    : describeValidationFailure(cause);

/**
 * The error a capture that failed before publication reports: the failure
 * itself, or, when the session's processes or the discarded content could
 * not be cleaned up, a cleanup error that keeps the failure as its cause.
 */
export const failedCaptureError = (
  cause: unknown,
  discarded: readonly UnresolvedCleanup[],
): unknown => {
  const session =
    cause instanceof DesktopSessionCleanupError ? cause.cleanup : undefined;
  const unresolved = [
    ...(session === undefined ? [] : [session]),
    ...discarded,
  ];
  if (!nonEmpty(unresolved)) return cause;
  const primary =
    cause instanceof DesktopSessionCleanupError ? cause.primary : cause;
  const failure = cleanupError(unresolved, (reason) => ({
    cause: primary,
    ...(primary instanceof AnalysisError ? { cleanupPrimary: primary } : {}),
    userMessage: `Desktop capture could not complete: ${describe(primary)}; cleanup is incomplete: ${reason}.`,
    remediationAction:
      session === undefined
        ? "Remove the listed paths, then retry the command in a new capture folder."
        : PROCESS_REMEDIATION,
    diagnostics: { phase: "desktop_capture" },
  }));
  return primary instanceof AnalysisError && primary.cleanupIncomplete
    ? analysisErrorWithCleanupFailure(
        primary,
        failure,
        DESKTOP_OPERATION,
      ).bindCleanupDependencies([primary, failure])
    : failure;
};

/** Project any capture failure into a typed analysis error. */
export const projectFailure = (
  cause: unknown,
  signal: AbortSignal | undefined,
): AnalysisError => {
  return desktopOperationFailure(
    cause instanceof XpropUnavailableError
      ? unavailable(
          "executable_missing",
          cause.message,
          "Install x11-utils, or set REA_XPROP_COMMAND to an xprop executable.",
        )
      : cause,
    signal,
    DESKTOP_OPERATION,
    "Desktop capture",
  );
};
