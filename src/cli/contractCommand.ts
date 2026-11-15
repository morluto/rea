import { z } from "incur";
import type { Logger } from "pino";

import { logCliCommand } from "../cliLogging.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import type { DirectAnalysis } from "../composition/directAnalysis.js";
import type { CallerInputPaths, Evidence } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Result } from "../domain/result.js";
import { deliverCliAnalysisEvidence } from "./analysisEvidenceDelivery.js";
import { finishCliEvidenceCommand } from "./cliEvidenceCallerPath.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { parseCliJsonInput, resolveCliJsonPaths } from "../cliJsonInput.js";
import { jsonInputArgument } from "./jsonInputArgument.js";
import {
  describeContractCommand,
  describeContractDocumentCommand,
  type CliDocumentProjection,
  type DocumentContract,
  type ContractCliDocumentDescription,
  type CliContractProjection,
  type CliEvidenceDeliveryChoice,
  type CliOptionShape,
  type CliOptionValues,
  type ContractCliDescription,
  type ContractField,
  type ProjectedContract,
} from "./contractCliDescription.js";
import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import type { CliInstance } from "./types.js";

/**
 * Incur adapter for contract commands. The command itself is described in
 * `contractCliDescription.ts`; this module only renders that description as
 * Incur args and options and runs the handler.
 */

/** What a contract command's handler receives besides the contract input. */
export interface ContractCommandContext<
  CliOptions extends Readonly<Record<string, unknown>> = Readonly<
    Record<string, unknown>
  >,
> {
  readonly signal: AbortSignal;
  /** The contract name, which is the canonical operation. */
  readonly operation: string;
  /** Each caller-path field as the caller spelled it, before resolution. */
  readonly callerInputs: CallerInputPaths;
  /**
   * The session target as the caller spelled it, for a projection with
   * `sessionTarget`; undefined otherwise.
   */
  readonly sessionTarget: string | undefined;
  /** Contract fields the CLI spells differently, for input issue paths. */
  readonly inputBinding: ContractCliDescription["inputBinding"];
  /** The admitted delivery, for a projection with `evidenceDelivery`. */
  readonly delivery: CliEvidenceDeliveryChoice | undefined;
  /** The projection's CLI-only options, whose effect the handler owns. */
  readonly cliOptions: CliOptions;
}

/** A closeable one-shot service that inspects one contract input. */
export interface EvidenceInspectionService {
  inspect(
    input: unknown,
    options: { readonly signal: AbortSignal },
  ): Promise<Result<Evidence, AnalysisError>>;
  close(): Promise<void>;
}

/** The caller's spelling of the selected target `path`. */
export const callerTargetPath = ({
  operation,
  callerInputs,
}: ContractCommandContext): string => {
  const { path } = callerInputs;
  if (typeof path !== "string")
    throw new Error(`${operation} has no caller path field named path`);
  return path;
};

/**
 * The caller's spelling of `path`, and of each other caller-path field keyed
 * by its contract field name.
 */
const callerSpellings = (
  context: ContractCommandContext,
): {
  readonly path: string;
  readonly others: CallerInputPaths | undefined;
} => {
  const { path: _path, ...others } = context.callerInputs;
  return {
    path: callerTargetPath(context),
    others: Object.keys(others).length === 0 ? undefined : others,
  };
};

/**
 * Inspect through a closeable service, finish its cleanup, and record the
 * caller's spelling of each selected path in the Evidence.
 */
export const inspectWithService =
  (service: () => EvidenceInspectionService, providerId: string) =>
  (input: unknown, context: ContractCommandContext) => {
    const spellings = callerSpellings(context);
    const owned = service();
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
 * Open the session target as an MCP session would hold it, run the contract
 * operation on the remaining input, and name renamed fields by their CLI key
 * in input issues.
 */
export const runOnSessionTarget =
  (
    runProviderAnalysis: DirectAnalysis["runProviderAnalysis"],
    logger: Logger,
  ) =>
  (input: object, context: ContractCommandContext) => {
    if (context.sessionTarget === undefined)
      throw new Error(`${context.operation} declares no session target`);
    return runProviderAnalysis(
      context.sessionTarget,
      context.operation as SessionTargetOperation,
      // Argv values are decoded text, and absent options are left out.
      input as Readonly<Record<string, JsonValue>>,
      logger,
      context.signal,
    ).then((result) => projectCliAnalysisResult(result, context.inputBinding));
  };

/** Operations `runProviderAnalysis` runs on an opened session target. */
type SessionTargetOperation = Parameters<
  DirectAnalysis["runProviderAnalysis"]
>[1];

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
  (service: () => EvidenceInspectionService, providerId: string) =>
  (input: unknown, context: ContractCommandContext) => {
    const spellings = callerSpellings(context);
    const { delivery } = context;
    if (delivery === undefined)
      throw new Error(`${context.operation} does not declare evidenceDelivery`);
    const owned = service();
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
      ...(delivery.view === undefined ? {} : { view: delivery.view }),
    });
  };

const descriptions = new WeakMap<CliInstance, ContractCliDescription[]>();

/** Commands registered on this CLI through `registerContractCommand`. */
export const contractCommandDescriptions = (
  cli: CliInstance,
): readonly ContractCliDescription[] => descriptions.get(cli) ?? [];

const incurOptions = (description: ContractCliDescription): z.ZodType => {
  const object = z.object(
    Object.fromEntries([
      ...description.parameters
        .filter(({ positional }) => !positional)
        .map(({ key, schema }) => [key, schema] as const),
      ...description.cliOnlyOptions.map(
        ({ key, schema }) => [key, schema] as const,
      ),
    ]),
  );
  const constrained =
    description.optionConstraints === undefined
      ? object
      : object.meta(description.optionConstraints);
  const { checkOptions } = description;
  return checkOptions === undefined
    ? constrained
    : constrained.superRefine((parsed, context) => {
        for (const { path, issue } of checkOptions(parsed))
          context.addIssue({ ...issue, path: [...path] } as never);
      });
};

/**
 * Register one CLI command described from a tool contract. The handler
 * receives the contract input, with caller paths made absolute.
 */
export const registerContractCommand = <
  Contract extends ProjectedContract,
  Value,
  CliOptions extends CliOptionShape = Record<never, z.ZodType>,
>(
  cli: CliInstance,
  logger: Logger,
  contract: Contract,
  projection: CliContractProjection<ContractField<Contract>, CliOptions>,
  run: (
    input: z.input<Contract["inputSchema"]>,
    context: ContractCommandContext<CliOptionValues<CliOptions>>,
  ) => Promise<Value>,
): void => {
  const description = describeContractCommand(contract, projection);
  const positionals = [
    ...(description.sessionTarget === undefined
      ? []
      : [description.sessionTarget]),
    ...description.parameters.filter(({ positional }) => positional),
  ];
  const alias = Object.fromEntries(
    description.parameters.flatMap(({ key, alias: short, positional }) =>
      short === undefined || positional ? [] : [[key, short]],
    ),
  );
  cli.command(description.command, {
    description: description.description,
    ...(positionals.length === 0
      ? {}
      : {
          args: z.object(
            Object.fromEntries(
              positionals.map(({ key, schema }) => [key, schema]),
            ),
          ),
        }),
    options: incurOptions(description),
    ...(Object.keys(alias).length === 0 ? {} : { alias }),
    run: ({
      args,
      options,
    }: {
      readonly args?: Readonly<Record<string, unknown>>;
      readonly options: Readonly<Record<string, unknown>>;
    }) => {
      const values = { ...options, ...args };
      return withCommandCancellation((signal) =>
        logCliCommand(logger, description.command, async () => {
          const admitted = description.admit(values);
          if (!admitted.ok) return projectAnalysisError(admitted.error);
          return run(admitted.value.input as z.input<Contract["inputSchema"]>, {
            signal,
            operation: contract.name,
            callerInputs: description.callerInputs(values),
            sessionTarget:
              description.sessionTarget === undefined
                ? undefined
                : (values[description.sessionTarget.key] as string),
            inputBinding: description.inputBinding,
            delivery: admitted.value.delivery,
            cliOptions: description.cliOptionValues(
              values,
            ) as CliOptionValues<CliOptions>,
          });
        }),
      );
    },
  } as never);
  const registered = descriptions.get(cli) ?? [];
  registered.push(description);
  descriptions.set(cli, registered);
};

/** What a JSON-document command's handler receives besides the document. */
export interface ContractDocumentContext<
  CliOptions extends Readonly<Record<string, unknown>> = Readonly<
    Record<string, unknown>
  >,
> {
  readonly signal: AbortSignal;
  /** The contract name, which is the canonical operation. */
  readonly operation: string;
  /** The document as decoded, before its caller paths were resolved. */
  readonly spelled: unknown;
  /** The projection's CLI-only options, whose effect the handler owns. */
  readonly cliOptions: CliOptions;
  /**
   * The session target as the caller spelled it, for a projection with
   * `sessionTarget`; undefined otherwise.
   */
  readonly sessionTarget: string | undefined;
}

const documentDescriptions = new WeakMap<
  CliInstance,
  ContractCliDocumentDescription[]
>();

/** Commands registered on this CLI through `registerContractDocumentCommand`. */
export const contractDocumentCommandDescriptions = (
  cli: CliInstance,
): readonly ContractCliDocumentDescription[] =>
  documentDescriptions.get(cli) ?? [];

/**
 * A document field the projection omits is refused with its reason rather
 * than passed to an owner that would act on it.
 */
const omittedDocumentFieldError = (
  operation: string,
  omitted: Readonly<Record<string, string>>,
  document: unknown,
): AnalysisError | undefined => {
  if (typeof document !== "object" || document === null) return undefined;
  const issues = Object.entries(omitted)
    .filter(([field]) => Object.hasOwn(document, field))
    .map(([field, reason]) => ({
      code: "custom" as const,
      path: [field],
      message: `${field} is not accepted by this command: ${reason}`,
      input: (document as Readonly<Record<string, unknown>>)[field],
    }));
  return issues.length === 0
    ? undefined
    : analysisInputErrorFromIssues(operation, issues, document);
};

/**
 * Register one CLI command whose whole contract input is one JSON document.
 * The handler receives the decoded document with its caller paths made
 * absolute, and admits it with the contract's owner.
 */
export const registerContractDocumentCommand = <
  Contract extends DocumentContract,
  Value,
  CliOptions extends CliOptionShape = Record<never, z.ZodType>,
>(
  cli: CliInstance,
  logger: Logger,
  contract: Contract,
  projection: CliDocumentProjection<ContractField<Contract>, CliOptions>,
  run: (
    document: unknown,
    context: ContractDocumentContext<CliOptionValues<CliOptions>>,
  ) => Promise<Value>,
): void => {
  const description = describeContractDocumentCommand(contract, projection);
  const options = Object.fromEntries(
    description.cliOnlyOptions.map(({ key, schema }) => [key, schema]),
  );
  cli.command(description.command, {
    description: description.description,
    args: z.object({
      ...(description.sessionTarget === undefined
        ? {}
        : {
            [description.sessionTarget.key]: description.sessionTarget.schema,
          }),
      [description.key]: jsonInputArgument(
        description.documentDescription,
        description.content,
      ),
    }),
    ...(Object.keys(options).length === 0
      ? {}
      : { options: z.object(options) }),
    run: ({
      args,
      options: values,
    }: {
      readonly args: Readonly<Record<string, string>>;
      readonly options: Readonly<Record<string, unknown>>;
    }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, description.command, async () => {
          const decoded = await parseCliJsonInput(
            args[description.key]!,
            contract.name,
            signal,
          );
          if (!decoded.ok) return decoded.error;
          const refused = omittedDocumentFieldError(
            contract.name,
            description.omitted,
            decoded.value,
          );
          if (refused !== undefined) return projectAnalysisError(refused);
          return run(
            resolveCliJsonPaths(decoded.value, description.callerPaths),
            {
              signal,
              operation: contract.name,
              spelled: decoded.value,
              sessionTarget:
                description.sessionTarget === undefined
                  ? undefined
                  : args[description.sessionTarget.key],
              cliOptions: description.cliOptionValues(
                values,
              ) as CliOptionValues<CliOptions>,
            },
          );
        }),
      ),
  } as never);
  const registered = documentDescriptions.get(cli) ?? [];
  registered.push(description);
  documentDescriptions.set(cli, registered);
};
