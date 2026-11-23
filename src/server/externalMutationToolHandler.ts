import type {
  CallToolResult,
  ServerContext,
} from "@modelcontextprotocol/server";
import type { Logger } from "pino";

import { summarizeRetainedAnalysis } from "../application/analysisView/AnalysisViewService.js";
import {
  requireAnalysisViewRetention,
  type AnalysisViewRetention,
} from "../application/analysisView/AnalysisViewRetention.js";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Evidence } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ok, type Result } from "../domain/result.js";
import { deliverEvidenceResult } from "./contractToolHandler.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import {
  runOwnedCleanupWithExternalMutationAdmission,
  runWithExternalMutationAdmission,
  type ExternalMutationAdmission,
} from "./externalMutationAdmission.js";
import { logToolExecution } from "./toolLogging.js";

/** A command's value and the facts its cancellation report keeps. */
export interface MutationValue {
  readonly value: JsonValue;
  /** Identifiers the command created, kept when retirement is cancelled. */
  readonly retained?: Readonly<Record<string, string>>;
}

/** A prepared command that observes through an owned resource. */
export type EvidenceCommand = (
  signal: AbortSignal,
) => Promise<Result<Evidence, AnalysisError>>;

/**
 * What one command that may change the bound artifact does:
 *
 * - `evidence`: observe through an owned resource; a retirement failure keeps
 *   the observation as partial Evidence. `detail: "delivery"` selects a
 *   retained summary.
 * - `value`: create or change an owned resource and report it.
 * - `owned-cleanup`: release the owned resource the input names. Admission
 *   runs it at most once, including when that same resource is the blocker
 *   admission has to clear first.
 *
 * Before an `evidence` or `value` command, `retryCleanup` retries cleanup an
 * earlier command left incomplete; a cleanup that still fails refuses the
 * command and stays owned for the next retry.
 */
export type ExternalMutation<Input = unknown> =
  | ({
      readonly kind: "evidence";
      readonly detail?: "delivery";
      readonly retryCleanup: () => Promise<Result<null, AnalysisError>>;
    } & (
      | {
          readonly run: (
            input: Input,
            signal: AbortSignal,
          ) => Promise<Result<Evidence, AnalysisError>>;
          readonly prepare?: never;
        }
      | {
          /**
           * Validate the request and settle the owner's cleanup before
           * admission, returning the command to run. A refusal here never
           * reaches admission, so the bound target stays open.
           */
          readonly prepare: (
            input: Input,
          ) => Promise<Result<EvidenceCommand, AnalysisError>>;
          readonly run?: never;
        }
    ))
  | {
      readonly kind: "value";
      readonly run: (
        input: Input,
        signal: AbortSignal,
      ) => Promise<Result<MutationValue, AnalysisError>>;
      readonly retryCleanup: () => Promise<Result<null, AnalysisError>>;
    }
  | {
      readonly kind: "owned-cleanup";
      readonly resource: (input: Input) => string;
      readonly run: (input: Input) => Promise<Result<JsonValue, AnalysisError>>;
    };

/**
 * Run a command under the session's external-mutation admission, which
 * retires the bound analysis around it, and deliver its result. Without a
 * session the command runs after any pending cleanup retry. A failure
 * delivers its partial Evidence through the session writer.
 */
export const createExternalMutationToolHandler =
  (
    server: EvidenceMcpServer,
    session: ExternalMutationAdmission | undefined,
    mutation: ExternalMutation,
    logger: Logger,
    retention: AnalysisViewRetention,
  ) =>
  (contract: ToolContract) =>
  async (input: unknown, context: ServerContext): Promise<CallToolResult> => {
    const { name } = contract;
    const { signal } = context.mcpReq;
    const failed = (error: AnalysisError): CallToolResult =>
      server.delivery.toPartialErrorToolResult(
        error,
        contract.returnsTargetContent,
        retention.recordEvidence,
      );
    if (mutation.kind === "owned-cleanup") {
      const closed = await runOwnedCleanupWithExternalMutationAdmission(
        session,
        name,
        signal,
        mutation.resource(input),
        () => logToolExecution(logger, name, () => mutation.run(input)),
      );
      return closed.ok
        ? server.delivery.toCallToolResult(closed, contract)
        : failed(closed.error);
    }
    if (mutation.kind === "value") {
      const changed = await runWithExternalMutationAdmission(
        session,
        name,
        signal,
        () => logToolExecution(logger, name, () => mutation.run(input, signal)),
        undefined,
        mutation.retryCleanup,
        (value) => value.retained ?? {},
      );
      return changed.ok
        ? server.delivery.toCallToolResult(ok(changed.value.value), contract)
        : failed(changed.error);
    }
    const summary =
      mutation.detail === "delivery" && deliveryDetail(input) === "summary";
    if (summary) {
      const ready = requireAnalysisViewRetention(name, retention);
      if (!ready.ok) return server.delivery.toCallToolResult(ready, contract);
    }
    const prepared: Result<EvidenceCommand, AnalysisError> =
      mutation.prepare === undefined
        ? ok((commandSignal) => mutation.run(input, commandSignal))
        : await mutation.prepare(input);
    if (!prepared.ok) return failed(prepared.error);
    const command = prepared.value;
    const observed = await runWithExternalMutationAdmission(
      session,
      name,
      signal,
      () => logToolExecution(logger, name, () => command(signal)),
      (evidence) => evidence,
      mutation.retryCleanup,
    );
    return deliverEvidenceResult(
      server,
      summary && observed.ok
        ? summarizeRetainedAnalysis(observed.value, retention)
        : observed,
      contract,
      retention.recordEvidence,
      undefined,
      retention.evidenceById,
    );
  };

const deliveryDetail = (input: unknown): unknown =>
  typeof input === "object" && input !== null && "detail" in input
    ? input.detail
    : undefined;
