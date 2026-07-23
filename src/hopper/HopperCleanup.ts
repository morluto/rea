import type { Socket } from "node:net";

import type { ProgressReporter } from "../application/ProgressReporter.js";
import type { AnalysisError, HopperError } from "../domain/errors.js";
import { HopperProcessError } from "../domain/errors.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import type { Logger } from "../logger.js";
import type { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import type { ProcessCleanupResult } from "../process/ProcessOwnership.js";
import type { ProviderProcessSupervisor } from "../process/ProviderProcess.js";
import type { BridgeLaunch } from "./BridgeLauncher.js";
import {
  createOwnedHopperShutdownDiagnostic,
  type HopperDiagnostic,
  providerCleanupFailure,
} from "./HopperDiagnostics.js";
import type { HopperRequestActivity } from "./HopperRequestQueue.js";
import {
  isHopperCleanupRequired,
  isHopperShutdownAcknowledgement,
} from "./HopperSessionValues.js";

interface CleanupIssue {
  readonly resource: string;
  readonly reason: string;
}

interface CleanupState {
  readonly issues: CleanupIssue[];
  readonly resources: Set<string>;
  cleanupResult: ProcessCleanupResult | undefined;
  shutdownConfirmed: boolean;
  ownedProcessStopped: boolean;
}

export interface HopperCleanupInput {
  readonly socket: Socket | undefined;
  readonly launch: BridgeLaunch | undefined;
  readonly processSupervisor: ProviderProcessSupervisor | undefined;
  readonly runtimeRoot: PrivateRuntimeRoot | undefined;
  readonly activeRequest: HopperRequestActivity | null;
  readonly progress: ProgressReporter | undefined;
  readonly logger: Logger;
  readonly onDiagnostic: ((event: HopperDiagnostic) => void) | undefined;
  request(
    method: "shutdown" | "shutdown_document",
  ): Promise<Result<JsonValue, HopperError>>;
  releaseTransport(socket: Socket | undefined): void;
}

/** Close Hopper phases and retain every resource whose cleanup is unverified. */
export const cleanupHopperSession = async (
  input: HopperCleanupInput,
): Promise<Result<null, AnalysisError>> => {
  const state: CleanupState = {
    issues: [],
    resources: new Set(),
    cleanupResult: undefined,
    shutdownConfirmed: false,
    ownedProcessStopped: false,
  };
  await report(input.progress, 0, "requesting Hopper document shutdown");
  await requestShutdown(input, state);
  await report(input.progress, 0.35, "releasing Hopper bridge transport");
  input.releaseTransport(input.socket);
  await stopProcess(input, state);
  recordUnconfirmedDocument(input, state);
  await report(input.progress, 0.75, "removing Hopper private runtime files");
  await closeRuntimeRoot(input.runtimeRoot, state);
  return cleanupOutcome(input, state);
};

const requestShutdown = async (
  input: HopperCleanupInput,
  state: CleanupState,
): Promise<void> => {
  if (
    input.socket === undefined ||
    input.socket.destroyed ||
    input.activeRequest !== null
  ) {
    if (input.activeRequest !== null)
      input.logger.warn(
        {
          method: input.activeRequest.operation,
          callerState: input.activeRequest.callerState,
        },
        "Hopper shutdown skipped because a bridge operation remained active",
      );
    return;
  }
  const shutdown = await input
    .request("shutdown")
    .catch(() => err(new HopperProcessError(null)));
  if (
    shutdown.ok &&
    isHopperCleanupRequired(shutdown.value) &&
    input.launch?.shutdownByCleanup === true &&
    input.launch.cleanup !== undefined
  ) {
    state.cleanupResult = await input.launch
      .cleanup()
      .catch(providerCleanupFailure);
    if (!state.cleanupResult.cleaned) {
      state.shutdownConfirmed = await fallbackDocumentShutdown(input);
      state.cleanupResult = await input.launch
        .cleanup()
        .catch(providerCleanupFailure);
    }
  } else if (shutdown.ok) {
    state.shutdownConfirmed = isHopperShutdownAcknowledgement(shutdown.value);
  }
  if (
    !shutdown.ok ||
    (!state.shutdownConfirmed && state.cleanupResult === undefined)
  )
    input.logger.warn(
      { status: shutdown.ok ? "invalid-acknowledgement" : "failed" },
      "Hopper document shutdown was not confirmed",
    );
};

const fallbackDocumentShutdown = async (
  input: HopperCleanupInput,
): Promise<boolean> => {
  const fallback = await input
    .request("shutdown_document")
    .catch(() => err(new HopperProcessError(null)));
  const confirmed =
    fallback.ok && isHopperShutdownAcknowledgement(fallback.value);
  if (!confirmed)
    input.logger.warn(
      { status: fallback.ok ? "invalid-acknowledgement" : "failed" },
      "Hopper document shutdown fallback was not confirmed",
    );
  return confirmed;
};

const stopProcess = async (
  input: HopperCleanupInput,
  state: CleanupState,
): Promise<void> => {
  const supervisor = input.processSupervisor;
  if (supervisor === undefined) return;
  const stopped = await supervisor.stop(
    state.cleanupResult === undefined
      ? {}
      : { cleanupResult: state.cleanupResult },
  );
  const diagnostic = createOwnedHopperShutdownDiagnostic(
    supervisor.launch,
    stopped,
    state.cleanupResult,
  );
  try {
    input.onDiagnostic?.(diagnostic);
  } catch {
    // Diagnostic consumers cannot change the already-observed cleanup result.
  }
  input.logger.info(diagnostic, "Owned Hopper launcher shutdown completed");
  if (stopped.status !== "incomplete") {
    state.ownedProcessStopped = stopped.status !== "not-owned";
    return;
  }
  const processGroupId = supervisor.launch.ownership?.processGroupId;
  const resource =
    processGroupId === undefined
      ? "hopper-process"
      : `process-group:${String(processGroupId)}`;
  state.resources.add(resource);
  state.issues.push({ resource, reason: stopped.reason });
  input.logger.warn(
    { reason: stopped.reason },
    "Owned launcher cleanup failed closed",
  );
};

const recordUnconfirmedDocument = (
  input: HopperCleanupInput,
  state: CleanupState,
): void => {
  if (
    (input.socket === undefined && input.launch === undefined) ||
    state.shutdownConfirmed ||
    state.ownedProcessStopped
  )
    return;
  state.resources.add("hopper-document");
  state.issues.push({
    resource: "hopper-document",
    reason:
      input.activeRequest === null
        ? "authenticated shutdown acknowledgement was not observed"
        : `bridge operation ${input.activeRequest.operation} remained active after caller ${input.activeRequest.callerState}`,
  });
};

const closeRuntimeRoot = async (
  runtimeRoot: PrivateRuntimeRoot | undefined,
  state: CleanupState,
): Promise<void> => {
  try {
    await runtimeRoot?.close();
  } catch (cause: unknown) {
    const resource = runtimeRoot?.path ?? "hopper-runtime-root";
    state.resources.add(resource);
    state.issues.push({
      resource,
      reason:
        cause instanceof Error
          ? cause.message
          : "private runtime root cleanup failed",
    });
  }
};

const cleanupOutcome = (
  input: HopperCleanupInput,
  state: CleanupState,
): Result<null, AnalysisError> => {
  if (state.issues.length === 0) return ok(null);
  return err(
    new ProviderCleanupError("hopper", [...state.resources], {
      issues: cleanupIssueDetails(state.issues),
      ...(input.runtimeRoot === undefined
        ? {}
        : { runtime_root: input.runtimeRoot.path }),
      ...(input.activeRequest === null
        ? {}
        : { active_request: activityDetails(input.activeRequest) }),
    }),
  );
};

const cleanupIssueDetails = (issues: readonly CleanupIssue[]): JsonValue =>
  issues.map((issue) => ({
    resource: issue.resource,
    reason: issue.reason,
  }));

const activityDetails = (activity: HopperRequestActivity): JsonValue => ({
  request_id: activity.requestId,
  operation: activity.operation,
  elapsed_ms: activity.elapsedMs,
  timeout_ms: activity.timeoutMs,
  caller_state: activity.callerState,
  queued_requests: activity.queuedRequests,
});

const report = async (
  progress: ProgressReporter | undefined,
  completed: number,
  message: string,
): Promise<void> => {
  await progress
    ?.report({
      phase: "hopper_cleanup",
      completed,
      total: 1,
      message,
    })
    .catch(() => undefined);
};
