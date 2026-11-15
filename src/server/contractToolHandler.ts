import type {
  CallToolResult,
  ServerContext,
} from "@modelcontextprotocol/server";
import type { Logger } from "pino";
import type { z } from "zod";

import type { ProgressReporter } from "../ports/ProgressReporter.js";
import {
  optionalProviderUnavailable,
  type OptionalProviderLoadFailure,
} from "../ports/OptionalObservationProviders.js";
import { mcpProgressReporter } from "./mcpProgress.js";
import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import {
  projectRetainedAnalysis,
  requireAnalysisViewRetention,
  type AnalysisViewRetention,
} from "../application/analysisView/AnalysisViewService.js";
import type { AnalysisViewRequest } from "../domain/analysisView/analysisViewRequest.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Evidence } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, type Result } from "../domain/result.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { logToolExecution } from "./toolLogging.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { runAdmittedToolOperation } from "./admittedToolOperation.js";
import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import type { InvestigationWorkflowExecution } from "../application/investigation/InvestigationWorkflows.js";
import { withAdmittedAnalysis as sessionAdmission } from "./analysisAdmission.js";
import { deliverInvestigationWorkflow } from "./deliverInvestigationWorkflow.js";
import { runDerivedOperation } from "./runDerivedOperation.js";

/** Application service executing one named contract operation. */
export interface ContractToolService<TOperation extends string> {
  execute(
    operation: TOperation,
    input: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>>;
}

/** Record and deliver one Evidence result using the tool's exact contract. */
export const deliverEvidenceResult = (
  server: EvidenceMcpServer,
  result: Result<Evidence, AnalysisError>,
  contract: ToolContract,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  viewSource?: JsonValue,
): CallToolResult => {
  if (!result.ok)
    return server.delivery.toPartialErrorToolResult(
      result.error,
      contract.returnsTargetContent,
      recordEvidence,
    );
  const recorded = recordEvidence?.(result.value);
  return server.delivery.toEvidenceToolResult(
    result.value,
    contract,
    recorded,
    viewSource,
  );
};

/**
 * Bind one service-backed handler to its exact named contract through the
 * shared log/execute/record/deliver workflow.
 */
export const createContractToolHandler =
  <TOperation extends string>(
    server: EvidenceMcpServer,
    service: ContractToolService<TOperation>,
    logger: Logger,
    recordEvidence?: EvidenceWriter["recordEvidence"],
    withAdmittedAnalysis?: WithAdmittedAnalysis,
  ) =>
  (contract: ToolContract<TOperation>) =>
    createEvidenceToolHandler(
      server,
      (input, options) => service.execute(contract.name, input, options),
      logger,
      recordEvidence,
      withAdmittedAnalysis,
    )(contract);

/** Validate delivery selection before inspection and retain its complete source for summaries. */
export const createRetainedSummaryToolHandler = <
  Name extends string,
  InputSchema extends z.ZodType<
    Readonly<Record<string, unknown>> & {
      readonly detail: "complete" | "summary";
      readonly view?: AnalysisViewRequest;
    }
  >,
>(
  server: EvidenceMcpServer,
  contract: ToolContract<Name, InputSchema>,
  inspect: (
    input: Omit<z.output<InputSchema>, "detail" | "view">,
    options: ExecutionOptions,
  ) => Promise<Result<Evidence, AnalysisError>>,
  logger: Logger,
  retention: AnalysisViewRetention,
  withAdmittedAnalysis?: WithAdmittedAnalysis,
) => {
  return createEvidenceToolHandler(
    server,
    async (rawInput, options) => {
      const parsed = contract.inputSchema.safeParse(rawInput);
      if (!parsed.success)
        return err(
          analysisInputErrorFromIssues(
            contract.name,
            parsed.error.issues,
            rawInput,
            { cause: parsed.error },
          ),
        );
      const { detail, view, ...input } = parsed.data;
      if (detail === "summary") {
        const ready = requireAnalysisViewRetention(contract.name, retention);
        if (!ready.ok) return ready;
      }
      const inspected = await inspect(input, options);
      return detail === "summary" && inspected.ok
        ? projectRetainedAnalysis(
            inspected.value,
            retention,
            view ?? { kind: "summary" },
          )
        : inspected;
    },
    logger,
    retention.recordEvidence,
    withAdmittedAnalysis,
  )(contract);
};

/**
 * Bind a named Evidence-producing operation to shared logging and delivery.
 * The operation receives the request signal and its MCP progress reporter.
 */
export const createEvidenceToolHandler =
  (
    server: EvidenceMcpServer,
    operation: (
      input: unknown,
      options: ExecutionOptions,
    ) => Promise<Result<Evidence, AnalysisError>>,
    logger: Logger,
    recordEvidence?: EvidenceWriter["recordEvidence"],
    withAdmittedAnalysis?: WithAdmittedAnalysis,
    viewSource?: (input: unknown) => JsonValue | undefined,
  ) =>
  <TOperation extends string>(contract: ToolContract<TOperation>) =>
  (input: unknown, context: ServerContext) =>
    runEvidenceToolOperation(
      { server, logger, recordEvidence, withAdmittedAnalysis, viewSource },
      contract,
      undefined,
      { input, context },
      operation,
    );

/** The MCP request a value-returning workflow runs for. */
export interface ValueToolRequest {
  readonly signal: AbortSignal;
  readonly progress: ProgressReporter;
  /** The request itself, for workflows that report the client's own facts. */
  readonly context: ServerContext;
}

/**
 * Bind a named workflow returning a plain JSON value to shared logging and
 * delivery. It records no Evidence and runs outside analysis admission.
 */
export const createValueToolHandler =
  (
    server: EvidenceMcpServer,
    operation: (
      input: unknown,
      request: ValueToolRequest,
    ) => Promise<Result<JsonValue, AnalysisError>>,
    logger: Logger,
  ) =>
  (contract: ToolContract) =>
  async (input: unknown, context: ServerContext): Promise<CallToolResult> =>
    server.delivery.toCallToolResult(
      await logToolExecution(logger, contract.name, () =>
        operation(input, {
          signal: context.mcpReq.signal,
          progress: mcpProgressReporter(context),
          context,
        }),
      ),
      contract,
    );

/** What a derivation may read before it runs. */
export interface DerivedSources {
  readonly evidenceForAnalysis: BinarySessionPort["evidenceForAnalysis"];
  readonly signal: AbortSignal;
}

/**
 * Read a derivation's inputs, then return the synchronous derivation over
 * them. A derivation from session-held Evidence alone acquires nothing.
 */
export type DerivedAcquisition = (
  input: unknown,
  sources: DerivedSources,
) => Promise<
  Result<
    () => Result<InvestigationWorkflowExecution, AnalysisError>,
    AnalysisError
  >
>;

/**
 * Derive Evidence from Evidence the session holds and the inputs the binding
 * acquires. The session owner admits the call, resolves its session-held
 * inputs, retains the sources the derivation read and records the derived
 * Evidence with its unknowns, so provenance is the same whichever tool
 * derives it. An acquisition failure is delivered as is.
 */
export const createDerivedToolHandler =
  (
    server: EvidenceMcpServer,
    session: BinarySessionPort,
    acquire: DerivedAcquisition,
    logger: Logger,
  ) =>
  (contract: ToolContract) => {
    const admission = sessionAdmission({ kind: "session", session });
    const evidenceForAnalysis = session.evidenceForAnalysis.bind(session);
    return async (
      input: unknown,
      context: ServerContext,
    ): Promise<CallToolResult> =>
      runAdmittedToolOperation(
        server,
        admission,
        contract.name,
        context.mcpReq.signal,
        async () => {
          const outcome = await logToolExecution(
            logger,
            contract.name,
            async () => {
              const acquired = await acquire(input, {
                evidenceForAnalysis,
                signal: context.mcpReq.signal,
              });
              if (!acquired.ok)
                return { ...acquired, stage: "acquire" as const };
              const derive = acquired.value;
              const derived = await runDerivedOperation(
                context,
                contract.name,
                () => {
                  const result = derive();
                  if (!result.ok) throw result.error;
                  return result.value;
                },
                (value) => value,
              );
              return { ...derived, stage: "derive" as const };
            },
          );
          return outcome.stage === "acquire"
            ? server.delivery.toCallToolResult(outcome, contract)
            : deliverInvestigationWorkflow(server, session, contract, outcome);
        },
      );
  };

/** One owner for optional-provider admission, execution, recording and delivery. */
export const runEvidenceToolOperation = async <Input>(
  options: {
    readonly server: EvidenceMcpServer;
    readonly logger: Logger;
    readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
    readonly withAdmittedAnalysis?: WithAdmittedAnalysis | undefined;
    /** The source a view's overflow recovery may name again, when it has one. */
    readonly viewSource?: ((input: Input) => JsonValue | undefined) | undefined;
  },
  contract: ToolContract,
  loadFailure: OptionalProviderLoadFailure | undefined,
  request: { readonly input: Input; readonly context: ServerContext },
  execute: (
    input: Input,
    options: {
      readonly signal: AbortSignal;
      readonly progress: ProgressReporter;
    },
  ) => Promise<Result<Evidence, AnalysisError>>,
): Promise<CallToolResult> => {
  const { input, context } = request;
  if (loadFailure !== undefined)
    return options.server.delivery.toCallToolResult(
      err(optionalProviderUnavailable(loadFailure, contract.name)),
      contract,
    );
  return runAdmittedToolOperation(
    options.server,
    options.withAdmittedAnalysis,
    contract.name,
    context.mcpReq.signal,
    async () => {
      const result = await logToolExecution(options.logger, contract.name, () =>
        execute(input, {
          signal: context.mcpReq.signal,
          progress: mcpProgressReporter(context),
        }),
      );
      return deliverEvidenceResult(
        options.server,
        result,
        contract,
        options.recordEvidence,
        options.viewSource?.(input),
      );
    },
  );
};
