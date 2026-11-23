import type {
  CallToolResult,
  ServerContext,
} from "@modelcontextprotocol/server";
import type { Logger } from "pino";
import type { z } from "zod";

import type { ProgressReporter } from "../ports/ProgressReporter.js";
import { mcpProgressReporter } from "./mcpProgress.js";
import type {
  AnalysisOperationPort,
  ExecutionOptions,
} from "../ports/AnalysisProvider.js";
import {
  projectRetainedAnalysis,
  requireAnalysisViewRetention,
  summarizeRetainedAnalysis,
  type AnalysisViewRetention,
} from "../application/analysisView/AnalysisViewService.js";
import type { AnalysisViewRequest } from "../domain/analysisView/analysisViewRequest.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Evidence } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { isRecord } from "../kernel/isRecord.js";
import { err, ok, type Result } from "../domain/result.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { ToolResultEncoding } from "./toolResultEncoding.js";
import { logToolExecution } from "./toolLogging.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { runAdmittedToolOperation } from "./admittedToolOperation.js";
import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import type { InvestigationWorkflowExecution } from "../application/investigation/InvestigationWorkflows.js";
import { withAdmittedAnalysis as sessionAdmission } from "./analysisAdmission.js";
import { deliverInvestigationWorkflow } from "./deliverInvestigationWorkflow.js";
import { runDerivedOperation } from "./runDerivedOperation.js";
import { createOperationProgress } from "./operationProgress.js";
import {
  deliverApplicationExecution,
  type ApplicationExecutionRecords,
} from "./deliverApplicationExecution.js";

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
  viewSource?: JsonValue | (() => JsonValue | undefined),
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

/** Input admission owns whether inspection receives defaults or caller selections. */
export type RetainedSummaryOperation<Input> =
  | {
      readonly admission: "sdk";
      readonly summary: (
        input: Omit<Input, "detail" | "view">,
        options: ExecutionOptions,
      ) => Promise<Result<Evidence, AnalysisError>>;
    }
  | {
      readonly admission: "application";
      readonly summary: (
        input: unknown,
        options: ExecutionOptions,
      ) => Promise<Result<Evidence, AnalysisError>>;
    };

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
  operation: RetainedSummaryOperation<z.output<InputSchema>>,
  logger: Logger,
  retention: AnalysisViewRetention,
  withAdmittedAnalysis?: WithAdmittedAnalysis,
) => {
  return createEvidenceToolHandler(
    server,
    async (rawInput, options) => {
      if (operation.admission === "sdk") {
        // The MCP SDK already validated `rawInput` against `contract.inputSchema`.
        const { detail, view, ...input } = rawInput as z.output<InputSchema>;
        if (detail === "summary") {
          const ready = requireAnalysisViewRetention(contract.name, retention);
          if (!ready.ok) return ready;
        }
        const inspected = await operation.summary(input, options);
        return detail === "summary" && inspected.ok
          ? projectRetainedAnalysis(
              inspected.value,
              retention,
              view ?? { kind: "summary" },
            )
          : inspected;
      }
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
      const { detail, view } = parsed.data;
      if (detail === "summary") {
        const ready = requireAnalysisViewRetention(contract.name, retention);
        if (!ready.ok) return ready;
      }
      const inspected = await operation.summary(
        isRecord(rawInput)
          ? Object.fromEntries(
              Object.entries(rawInput).filter(
                ([field]) => field !== "detail" && field !== "view",
              ),
            )
          : rawInput,
        options,
      );
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
    runAdmittedToolOperation(
      server,
      withAdmittedAnalysis,
      contract.name,
      context.mcpReq.signal,
      async () => {
        const result = await logToolExecution(logger, contract.name, () =>
          operation(input, {
            signal: context.mcpReq.signal,
            progress: mcpProgressReporter(context),
          }),
        );
        return deliverEvidenceResult(
          server,
          result,
          contract,
          recordEvidence,
          viewSource === undefined ? undefined : () => viewSource(input),
        );
      },
    );

/** The MCP request a value-returning workflow runs for. */
export interface ValueToolRequest {
  readonly signal: AbortSignal;
  readonly progress: ProgressReporter;
  /** The request itself, for workflows that report the client's own facts. */
  readonly context: ServerContext;
}

/**
 * A value that commits a record, with the receipt an overflowing response
 * names so the caller still learns what was committed.
 */
export class CommittedValue {
  constructor(
    readonly value: JsonValue,
    readonly receipt: Readonly<Record<string, JsonValue>>,
  ) {}
}

/**
 * Smaller forms of a value, offered in order when the complete value does not
 * fit the response budget. Each keeps the contract's result shape.
 */
export type ValueAlternatives = (
  failure: Extract<ToolResultEncoding, { readonly ok: false }>,
  budgetBytes: number,
) => Iterable<JsonValue>;

/** A value delivered complete when it fits, or as its first fitting alternative. */
export class ReducibleValue {
  constructor(
    readonly value: JsonValue,
    readonly alternatives: ValueAlternatives,
  ) {}
}

/**
 * A value followed by content blocks an upstream tool returned (a build
 * computer's screenshot, say), delivered unchanged after REA's JSON.
 */
export class ForwardedValue {
  constructor(
    readonly value: JsonValue,
    readonly content: readonly Readonly<Record<string, JsonValue>>[],
  ) {}
}

/**
 * A failure delivered with facts its operation observed alongside the error
 * (an open's selection at failure, say), added to the error's details.
 */
export class DetailedFailure {
  constructor(
    readonly error: AnalysisError,
    readonly details: Readonly<Record<string, JsonValue>>,
  ) {}
}

/** What a value workflow returns. */
export type ValueOutcome = Result<
  JsonValue | CommittedValue | ReducibleValue | ForwardedValue,
  AnalysisError | DetailedFailure
>;

/**
 * Bind a named workflow returning a plain JSON value to shared logging and
 * delivery. A success records no Evidence; a failure's partial Evidence (a
 * cancelled session's cleanup record, say) is delivered through the session
 * writer like any other. It runs under analysis admission only when one is
 * supplied, and then receives the analysis that admission grants.
 */
export const createValueToolHandler =
  (
    server: EvidenceMcpServer,
    operation: (
      input: unknown,
      request: ValueToolRequest & {
        readonly analysis?: AnalysisOperationPort;
      },
    ) => Promise<ValueOutcome>,
    logger: Logger,
    withAdmittedAnalysis?: WithAdmittedAnalysis,
    recordEvidence?: EvidenceWriter["recordEvidence"],
  ) =>
  (contract: ToolContract) =>
  async (input: unknown, context: ServerContext): Promise<CallToolResult> =>
    runAdmittedToolOperation(
      server,
      withAdmittedAnalysis,
      contract.name,
      context.mcpReq.signal,
      async (analysis) => {
        const result = await logToolExecution(logger, contract.name, () =>
          operation(input, {
            signal: context.mcpReq.signal,
            progress: mcpProgressReporter(context),
            context,
            ...(analysis === undefined ? {} : { analysis }),
          }),
        );
        if (!result.ok)
          return result.error instanceof DetailedFailure
            ? server.delivery.toDetailedErrorToolResult(
                result.error.error,
                result.error.details,
                contract.returnsTargetContent,
              )
            : server.delivery.toPartialErrorToolResult(
                result.error,
                contract.returnsTargetContent,
                recordEvidence,
              );
        const { value } = result;
        return value instanceof CommittedValue
          ? server.delivery.toCallToolResult(
              ok(value.value),
              contract,
              value.receipt,
            )
          : value instanceof ReducibleValue
            ? server.delivery.toCallToolResult(
                ok(value.value),
                contract,
                {},
                value.alternatives,
              )
            : value instanceof ForwardedValue
              ? server.delivery.toForwardedToolResult(
                  ok(value.value),
                  contract,
                  value.content,
                )
              : server.delivery.toCallToolResult(ok(value), contract);
      },
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

/** The request an application workflow runs for. */
export interface ApplicationWorkflowRequest {
  readonly signal: AbortSignal;
  readonly progress: ProgressReporter;
}

/** What an application workflow binding runs and the view it stages. */
export interface ApplicationWorkflow {
  readonly workflow: (
    input: unknown,
    request: ApplicationWorkflowRequest,
  ) => Promise<Result<InvestigationWorkflowExecution, AnalysisError>>;
  /** The caller-selected view of the completed Evidence, when the request names one. */
  readonly view?:
    | ((input: unknown) => AnalysisViewRequest | undefined)
    | undefined;
}

/**
 * Run an application workflow under analysis admission and deliver its
 * completed Evidence with its sources and residual unknown. A request for a
 * view (or summary) is refused before the workflow runs when the complete
 * Evidence cannot be retained; a failure delivers its partial Evidence.
 */
export const createApplicationToolHandler =
  (
    server: EvidenceMcpServer,
    { workflow, view }: ApplicationWorkflow,
    logger: Logger,
    records: ApplicationExecutionRecords,
    withAdmittedAnalysis?: WithAdmittedAnalysis,
  ) =>
  (contract: ToolContract) =>
  async (input: unknown, context: ServerContext): Promise<CallToolResult> =>
    runAdmittedToolOperation(
      server,
      withAdmittedAnalysis,
      contract.name,
      context.mcpReq.signal,
      async () => {
        const selected = view?.(input);
        if (selected !== undefined) {
          const retention = requireAnalysisViewRetention(contract.name, {
            recordEvidence: records.recordEvidence,
            evidenceById: records.evidenceById,
          });
          if (!retention.ok)
            return server.delivery.toCallToolResult(retention, contract);
        }
        const result = await logToolExecution(logger, contract.name, () =>
          workflow(input, {
            signal: context.mcpReq.signal,
            progress: mcpProgressReporter(context),
          }),
        );
        if (!result.ok)
          return server.delivery.toPartialErrorToolResult(
            result.error,
            contract.returnsTargetContent,
            records.recordEvidence,
          );
        return deliverApplicationExecution(
          server.delivery,
          records,
          contract,
          result.value,
          selected,
          context.mcpReq.signal,
        );
      },
    );

/**
 * A provider-backed workflow's Evidence and, when the workflow already
 * recorded it in the session, that record's result: delivery reuses it
 * rather than recording (and re-validating) the Evidence again.
 */
export interface AnalysisWorkflowOutcome {
  readonly evidence: Evidence;
  readonly recorded?: Result<unknown, AnalysisError>;
}

/** A provider-backed workflow run on the analysis its admission grants. */
export type AnalysisWorkflow = (
  input: unknown,
  analysis: AnalysisOperationPort,
  request: ApplicationWorkflowRequest,
) => Promise<Result<AnalysisWorkflowOutcome, AnalysisError>>;

/** Delivery controls and the owner of this complete workflow's terminal progress. */
export interface AnalysisWorkflowOptions {
  readonly detail?: "delivery" | undefined;
  readonly completionProgress?: "workflow" | undefined;
}

/**
 * Run a provider-backed workflow on the analysis that admission grants for
 * the call, reporting its start and terminal disposition, and deliver its
 * Evidence. When the binding declares that `detail` selects delivery, it
 * never reaches the workflow: a summary is refused before analysis when nothing
 * retains the complete Evidence, and the complete Evidence is retained
 * behind the summary it delivers.
 */
export const createAnalysisToolHandler =
  (
    server: EvidenceMcpServer,
    analyze: AnalysisWorkflow,
    logger: Logger,
    retention: AnalysisViewRetention,
    withAdmittedAnalysis: WithAdmittedAnalysis,
    options: AnalysisWorkflowOptions,
  ) =>
  (contract: ToolContract) =>
  async (
    rawInput: unknown,
    context: ServerContext,
  ): Promise<CallToolResult> => {
    const { detail, input } =
      options.detail === "delivery"
        ? deliveryDetail(rawInput)
        : { detail: undefined, input: rawInput };
    if (detail === "summary") {
      const ready = requireAnalysisViewRetention(contract.name, retention);
      if (!ready.ok) return server.delivery.toCallToolResult(ready, contract);
    }
    const { signal } = context.mcpReq;
    const admitted = await withAdmittedAnalysis(
      contract.name,
      signal,
      async (analysis) => {
        const progress = createOperationProgress(
          mcpProgressReporter(context),
          contract.name,
          options.completionProgress,
        );
        await progress.start();
        const analyzed = await logToolExecution(logger, contract.name, () =>
          analyze(input, analysis, { signal, progress }),
        );
        const response =
          !analyzed.ok || detail === "summary"
            ? deliverEvidenceResult(
                server,
                analyzed.ok
                  ? summarizeRetainedAnalysis(
                      analyzed.value.evidence,
                      retention,
                    )
                  : analyzed,
                contract,
                retention.recordEvidence,
              )
            : analyzed.value.recorded === undefined
              ? deliverEvidenceResult(
                  server,
                  ok(analyzed.value.evidence),
                  contract,
                  retention.recordEvidence,
                )
              : server.delivery.toEvidenceToolResult(
                  analyzed.value.evidence,
                  contract,
                  analyzed.value.recorded,
                );
        return progress.complete(response);
      },
    );
    return admitted.ok
      ? admitted.value
      : server.delivery.toErrorToolResult(
          admitted.error,
          contract.returnsTargetContent,
        );
  };

/** Split the delivery detail an SDK-admitted request selects from its workflow input. */
const deliveryDetail = (
  rawInput: unknown,
): {
  readonly detail: unknown;
  readonly input: unknown;
} => {
  if (
    typeof rawInput !== "object" ||
    rawInput === null ||
    !("detail" in rawInput)
  )
    return { detail: undefined, input: rawInput };
  const { detail, ...input } = rawInput;
  return { detail, input };
};
