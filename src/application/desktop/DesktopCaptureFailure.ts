import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { describeValidationFailure } from "../../domain/validationFailure.js";
import { DesktopSessionCleanupError } from "../../desktop/DesktopApplicationSession.js";
import type { DesktopContentStore } from "../../desktop/DesktopContentStore.js";
import { XpropUnavailableError } from "../../desktop/X11WindowObserver.js";
import { discardCaptureFile } from "./DesktopCaptureOutput.js";
import {
  DESKTOP_OPERATION,
  DESKTOP_PROVIDER,
  unavailable,
} from "./DesktopCaptureRefusals.js";

/** One resource left behind and why. */
interface Unresolved {
  readonly reason: string;
  readonly resources: readonly string[];
}

const HANDLES_UNCLOSED =
  "a retained file's handle could not be closed after a retry";
const PROCESS_REMEDIATION =
  "Check for processes still carrying the listed run token and stop them before capturing again.";

const cleanupFacts = (unresolved: readonly Unresolved[]) => ({
  reason: unresolved.map((entry) => entry.reason).join("; "),
  resources: unresolved.flatMap((entry) => entry.resources),
});

/**
 * One cleanup error for everything left unresolved after the capture was
 * written: launched processes, retained-file handles, or both.
 */
export const cleanupFailure = (
  published: string,
  output: string,
  unresolved: {
    readonly processes: Unresolved | undefined;
    readonly handles: boolean;
  },
) => {
  const { processes, handles } = unresolved;
  const cleanup = cleanupFacts([
    ...(processes === undefined ? [] : [processes]),
    ...(handles ? [{ reason: HANDLES_UNCLOSED, resources: [output] }] : []),
  ]);
  return new ProviderAdapterError(DESKTOP_PROVIDER.id, DESKTOP_OPERATION, {
    userMessage: `The capture was written to ${published}, but cleanup is incomplete: ${cleanup.reason}.`,
    remediationAction:
      processes === undefined
        ? "Retry the command in a new capture folder; the written capture is complete."
        : PROCESS_REMEDIATION,
    cleanup,
    diagnostics: { capture_file: published },
  });
};

/**
 * Remove what a capture that failed before publishing `capture.json` wrote,
 * each through the owner that wrote it, and close its retained-file handles.
 * Returns what could not be cleaned up.
 */
export const discardFailedCapture = async (
  store: DesktopContentStore,
  output: string,
): Promise<readonly Unresolved[]> => {
  const removed = await store.discard().then(
    () => true,
    () => false,
  );
  const partial = await discardCaptureFile(output);
  const closed = await store.close().then(
    () => true,
    () => false,
  );
  return [
    ...(removed
      ? []
      : [
          {
            reason:
              "the content the failed capture retained could not be removed",
            resources: [store.directory],
          },
        ]),
    ...(partial === undefined
      ? []
      : [
          {
            reason: "the unpublished capture file could not be removed",
            resources: [partial],
          },
        ]),
    ...(closed ? [] : [{ reason: HANDLES_UNCLOSED, resources: [output] }]),
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
  discarded: readonly Unresolved[],
): unknown => {
  const session =
    cause instanceof DesktopSessionCleanupError ? cause.cleanup : undefined;
  const unresolved = [
    ...(session === undefined ? [] : [session]),
    ...discarded,
  ];
  if (unresolved.length === 0) return cause;
  const primary =
    cause instanceof DesktopSessionCleanupError ? cause.primary : cause;
  const cleanup = cleanupFacts(unresolved);
  return new ProviderAdapterError(DESKTOP_PROVIDER.id, DESKTOP_OPERATION, {
    cause: primary,
    ...(primary instanceof AnalysisError ? { cleanupPrimary: primary } : {}),
    userMessage: `Desktop capture could not complete: ${describe(primary)}; cleanup is incomplete: ${cleanup.reason}.`,
    remediationAction:
      session === undefined
        ? "Remove the listed paths, then retry the command in a new capture folder."
        : PROCESS_REMEDIATION,
    cleanup,
    diagnostics: { phase: "desktop_capture" },
  });
};

/** Project any capture failure into a typed analysis error. */
export const projectFailure = (
  cause: unknown,
  signal: AbortSignal | undefined,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (signal?.aborted === true)
    return new AnalysisCancelledError(DESKTOP_OPERATION, {
      cause: signal.reason,
    });
  if (cause instanceof XpropUnavailableError)
    return unavailable(
      "executable_missing",
      cause.message,
      "Install x11-utils, or set REA_XPROP_COMMAND to an xprop executable.",
    );
  return new ProviderAdapterError(DESKTOP_PROVIDER.id, DESKTOP_OPERATION, {
    cause,
    diagnostics: { phase: "desktop_capture" },
    userMessage: `Desktop capture could not complete: ${describeValidationFailure(cause)}`,
  });
};
