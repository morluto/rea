import { cliPublicationInvocation } from "./cliEvidencePublication.js";
import type { Logger } from "pino";

import type { DirectAnalysis } from "../composition/directAnalysis.js";
import type { ArtifactAnalysisOperation } from "../contracts/artifactToolContracts.js";
import { openBinaryTargetSelection } from "../contracts/sessionLifecycleInputs.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { CallerInputPaths, Evidence } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { AnalysisProviderSelector } from "../domain/providerSelection.js";
import type { Result } from "../domain/result.js";
import { dispatchQueuedInterrupts } from "../process/queuedInterrupts.js";
import { finalizedResult, runOwned } from "../providers/runOwned.js";
import {
  deliverCliAnalysisEvidence,
  publishCliAnalysisEvidence,
} from "./analysisEvidenceDelivery.js";
import { finishCliEvidenceCommand } from "./cliEvidenceCallerPath.js";
import type {
  CliEvidenceTargetSelection,
  ContractCommandContext,
} from "./contractCommand.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import {
  projectCliAnalysisResult,
  projectCliInputFields,
} from "./projectCliAnalysisResult.js";

/** A closeable one-shot service that inspects one contract input. */
export interface EvidenceInspectionService {
  inspect(
    input: unknown,
    options: { readonly signal: AbortSignal },
  ): Promise<Result<Evidence, AnalysisError>>;
  close(): Promise<void>;
}

/**
 * The caller's spelling of the primary caller-path field (`path` unless the
 * command names another), and of each other caller-path field keyed by its
 * contract field name.
 */
const callerSpellings = (
  context: ContractCommandContext,
  primary = "path",
): {
  readonly path: string;
  readonly others: CallerInputPaths | undefined;
} => {
  const { [primary]: path, ...others } = context.callerInputs;
  if (typeof path !== "string")
    throw new Error(
      `${context.operation} has no caller path field named ${primary}`,
    );
  return {
    path,
    others: Object.keys(others).length === 0 ? undefined : others,
  };
};

/**
 * Inspect through a closeable service, finish its cleanup, and record the
 * caller's spelling of each selected path in the Evidence; `primary` names
 * the contract field recorded as the Evidence's caller input path.
 */
export const inspectWithService =
  (
    service: () =>
      | EvidenceInspectionService
      | Promise<EvidenceInspectionService>,
    providerId: string,
    primary = "path",
  ) =>
  async (input: unknown, context: ContractCommandContext) => {
    const spellings = callerSpellings(context, primary);
    const owned = await service();
    return finishCliEvidenceCommand(
      spellings.path,
      () => owned.inspect(input, { signal: context.signal }),
      owned,
      providerId,
      context.operation,
      context.signal,
      spellings.others,
    ).then(projectCliAnalysisResult);
  };

/**
 * Open the session target as an MCP session would hold it, with the opening
 * fields the caller selected, and run the contract operation on the
 * remaining input. A projection with `evidenceDelivery` delivers complete
 * Evidence or a summary beside its bundle.
 */
export const runOnSessionTarget =
  (
    runProviderAnalysis: DirectAnalysis["runProviderAnalysis"],
    logger: Logger,
  ) =>
  async (input: object, context: ContractCommandContext) => {
    const { sessionTarget, operation, signal, delivery, opening } = context;
    if (sessionTarget === undefined)
      throw new Error(`${operation} declares no session target`);
    // Argv values are decoded text, and absent options are left out.
    const values = input as Readonly<Record<string, JsonValue>>;
    const result = await (Object.keys(opening).length === 0
      ? runProviderAnalysis(
          sessionTarget,
          operation as SessionTargetOperation,
          values,
          logger,
          signal,
        )
      : runProviderAnalysis(
          sessionTarget,
          // Only artifact operations take an opening selection.
          operation as ArtifactAnalysisOperation,
          values,
          logger,
          signal,
          openBinaryTargetSelection(opening),
        ));
    if (delivery === undefined) return projectCliAnalysisResult(result);
    return publishCliAnalysisEvidence(result, {
      operation,
      signal,
      detail: delivery.detail,
      evidenceOutput: delivery.evidenceOutput,
      rerunRecoversResult: delivery.rerunRecoversResult,
      ...(delivery.view === undefined ? {} : { view: delivery.view }),
    });
  };

/** Operations `runProviderAnalysis` runs on an opened session target. */
type SessionTargetOperation = Parameters<
  DirectAnalysis["runProviderAnalysis"]
>[1];

/** Operations `runDirectAnalysis` runs on a target it opens. */
type DirectAnalysisOperation = Parameters<
  DirectAnalysis["runDirectAnalysis"]
>[1];

/**
 * The one-shot open the caller selected with `open_binary` fields: its
 * target interpretation, provider and analysis snapshot.
 */
const directAnalysisOpening = ({
  provider_id: providerId,
  snapshot_path: snapshotPath,
  ...selection
}: Readonly<Record<string, unknown>>) => ({
  ...openBinaryTargetSelection(selection),
  ...(providerId === undefined
    ? {}
    : { providerId: providerId as AnalysisProviderSelector }),
  ...(snapshotPath === undefined
    ? {}
    : { snapshotPath: snapshotPath as string }),
});

/**
 * Open the session target for one operation with the `open_binary` fields
 * the caller selected, run it, and release the provider. A projection with
 * `evidenceDelivery` delivers complete Evidence or a summary beside its
 * bundle. `requireSourceEvidence` refuses a bundle whose composed result did
 * not return the source Evidence it cites.
 */
export const runDirectOnTarget =
  (
    runDirectAnalysis: DirectAnalysis["runDirectAnalysis"],
    logger: Logger,
    options: { readonly requireSourceEvidence?: true } = {},
  ) =>
  async (input: object, context: ContractCommandContext) => {
    const { sessionTarget, operation, signal, delivery, opening } = context;
    if (sessionTarget === undefined)
      throw new Error(`${operation} declares no session target`);
    const evidenceOutput = delivery?.evidenceOutput;
    const result = await runDirectAnalysis(
      sessionTarget,
      operation as DirectAnalysisOperation,
      // Argv values are decoded text, and absent options are left out.
      input as Readonly<Record<string, JsonValue>>,
      {
        logger,
        signal,
        ...directAnalysisOpening(opening),
        // A bundle needs the sources its record cites: a requested one, or
        // the retained-Evidence cache an over-budget result may go to.
        ...(evidenceOutput !== undefined ||
        (delivery !== undefined &&
          delivery.detail === undefined &&
          cliPublicationInvocation().retention !== undefined)
          ? { includeEvidenceSources: true }
          : {}),
      },
    );
    if (delivery === undefined) return projectCliAnalysisResult(result);
    if (
      options.requireSourceEvidence === true &&
      result.ok &&
      evidenceOutput !== undefined &&
      result.sourceEvidence === undefined
    )
      return projectAnalysisError(
        new AnalysisOutputError(
          operation,
          "The CLI session did not return its source Evidence.",
        ).retainPartialObservation(result.value),
      );
    return publishCliAnalysisEvidence(result, {
      operation,
      signal,
      detail: delivery.detail,
      evidenceOutput,
      rerunRecoversResult: delivery.rerunRecoversResult,
    });
  };

/**
 * Run the source contract on each Evidence target in argv order with the
 * source fields the caller selected, then compose the contract from that
 * Evidence. A target's failure names its positional; any failure retains
 * each completed target's Evidence under its contract field beside the
 * failure's own partial observation.
 */
export const runOnEvidenceTargets =
  (
    runSource: (
      target: string,
      parameters: Readonly<Record<string, JsonValue>>,
      signal: AbortSignal,
    ) => Promise<Result<Evidence, AnalysisError>>,
    compose: (
      input: Readonly<Record<string, unknown>>,
      context: ContractCommandContext & {
        readonly evidenceTargets: CliEvidenceTargetSelection;
      },
    ) => Promise<Result<Evidence, AnalysisError>>,
  ) =>
  async (input: object, context: ContractCommandContext) => {
    const { evidenceTargets, operation, signal } = context;
    if (evidenceTargets === undefined)
      throw new Error(`${operation} declares no Evidence targets`);
    // Argv values are decoded text, and absent options are left out.
    const parameters = context.opening as Readonly<Record<string, JsonValue>>;
    const sources: Record<string, Evidence> = {};
    const retainSources = (failure: AnalysisError) => {
      for (const [field, evidence] of Object.entries(sources))
        failure.retainArgumentObservation(field, evidence);
      return failure;
    };
    for (const { field, key, target } of evidenceTargets.targets) {
      const source = await runSource(target, parameters, signal);
      if (!source.ok)
        return projectCliInputFields(
          {
            error: "Analysis failed",
            ...projectAnalysisError(retainSources(source.error), "invocation"),
          },
          {
            operation: evidenceTargets.source,
            fields: { path: key },
            flags: evidenceTargets.sourceFlags,
          },
        );
      sources[field] = source.value;
    }
    // A cancellation that arrives as the composition settles keeps its
    // most complete Evidence. The composition owns no resource of its own,
    // so its close only lets queued interrupts reach the signal first.
    const result = finalizedResult(
      await runOwned(
        async (): Promise<Result<Evidence, AnalysisError>> => {
          try {
            return await compose(
              { ...input, ...sources },
              { ...context, evidenceTargets },
            );
          } catch (cause: unknown) {
            // The completed source Evidence outlives a defect in the composition.
            return {
              ok: false,
              error: new AnalysisOutputError(
                operation,
                `${operation} produced invalid output`,
                { cause },
              ),
            };
          }
        },
        {
          providerId: evidenceTargets.source,
          operation,
          signal,
          close: dispatchQueuedInterrupts,
          partial: (value) => value,
        },
      ),
    );
    if (result.ok) return result.value;
    return {
      error: "Analysis failed",
      ...projectAnalysisError(retainSources(result.error), "invocation"),
    };
  };

/**
 * Run an analysis that selects no target path through a closeable service
 * and finish its cleanup.
 */
export const analyzeWithService =
  (service: () => EvidenceInspectionService, providerId: string) =>
  (input: unknown, context: ContractCommandContext) => {
    if (Object.keys(context.callerInputs).length > 0)
      throw new Error(`${context.operation} selects a caller path`);
    const owned = service();
    return finishAnalysisCommand(
      () => owned.inspect(input, { signal: context.signal }),
      owned,
      providerId,
      context.operation,
      context.signal,
    ).then(projectCliAnalysisResult);
  };

/**
 * Inspect through a closeable service, then deliver complete Evidence or a
 * summary with its bundle, recording the caller's spelling of each selected
 * path.
 */
export const deliverWithService =
  (
    service: () =>
      | EvidenceInspectionService
      | Promise<EvidenceInspectionService>,
    providerId: string,
  ) =>
  async (input: unknown, context: ContractCommandContext) => {
    const spellings = callerSpellings(context);
    const { delivery } = context;
    if (delivery === undefined)
      throw new Error(`${context.operation} does not declare evidenceDelivery`);
    const owned = await service();
    return deliverCliAnalysisEvidence({
      callerInputPath: spellings.path,
      ...(spellings.others === undefined
        ? {}
        : { callerInputPaths: spellings.others }),
      run: () => owned.inspect(input, { signal: context.signal }),
      service: owned,
      providerId,
      operation: context.operation,
      signal: context.signal,
      detail: delivery.detail,
      evidenceOutput: delivery.evidenceOutput,
      rerunRecoversResult: delivery.rerunRecoversResult,
      ...(delivery.view === undefined ? {} : { view: delivery.view }),
    });
  };
