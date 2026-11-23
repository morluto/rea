import { z } from "zod";
import { invariantViolation } from "../domain/internalInvariant.js";
import type { Logger } from "pino";

import { logCliCommand } from "../cliLogging.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisProviderSelector } from "../domain/providerSelection.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import type { DirectAnalysis } from "../composition/directAnalysis.js";
import type { CallerInputPaths, Evidence } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import type { ArtifactAnalysisOperation } from "../contracts/artifactToolContracts.js";
import { openBinaryTargetSelection } from "../contracts/sessionLifecycleInputs.js";
import {
  deliverCliAnalysisEvidence,
  publishCliAnalysisEvidence,
} from "./analysisEvidenceDelivery.js";
import { finishCliEvidenceCommand } from "./cliEvidenceCallerPath.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { dispatchQueuedInterrupts } from "../process/queuedInterrupts.js";
import { finalizedResult, runOwned } from "../providers/runOwned.js";
import { parseCliJsonInput } from "./cliJsonInput.js";
import {
  describeContractCommand,
  describeOperationChoices,
  withoutDefault,
} from "./contractCliDescription.js";
import type {
  DocumentContract,
  CliContractProjection,
  CliEvidenceDeliveryChoice,
  CliOptionShape,
  CliOptionValues,
  ContractCliDescription,
  ContractCliEvidenceTargets,
  ContractCliSessionTarget,
  ContractField,
  ProjectedContract,
  CliCheckedJsonInputs,
  CliJsonInputCheck,
} from "./contractCliDescriptionTypes.js";
import {
  cliDeliveredEvidence,
  recordCliResultControls,
} from "./cliResultControls.js";
import {
  cliResultControlsIn,
  failurePartialObservation,
  projectCliAnalysisResult,
  projectCliInputFields,
} from "./projectCliAnalysisResult.js";
import {
  contractDescriptionOperations,
  distinctOperations,
  registerCliCommand,
} from "./commandRegistry.js";
import type { CliInstance } from "./types.js";
import { isRecord } from "../kernel/isRecord.js";
import { optionFlagName } from "./optionFields.js";

/**
 * CLI adapter for contract commands. The command itself is described in
 * `contractCliDescription.ts`; this module only renders that description as
 * CLI args and options and runs the handler.
 */

/** What a contract command's handler receives besides the contract input. */
export interface ContractCommandContext<
  CliOptions extends Readonly<Record<string, unknown>> = Readonly<
    Record<string, unknown>
  >,
  Parsed = unknown,
  Checked extends Readonly<Record<string, unknown>> = Readonly<
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
  /**
   * The source contract and each Evidence target as the caller spelled it,
   * in argv order, for a projection with `evidenceTargets`; undefined
   * otherwise.
   */
  readonly evidenceTargets: CliEvidenceTargetSelection | undefined;
  /**
   * The session target's opening fields, or the Evidence targets' source
   * fields, the caller selected, in that contract's spelling; empty when the
   * projection declares none.
   */
  readonly opening: Readonly<Record<string, unknown>>;
  /** The admitted delivery, for a projection with `evidenceDelivery`. */
  readonly delivery: CliEvidenceDeliveryChoice | undefined;
  /**
   * The contract's parse of the input, when admission parsed the whole
   * input: the projection decodes JSON at run time, or argv supplies every
   * contract field. Undefined when a session target, Evidence target or the
   * handler supplies part of the input.
   */
  readonly parsed: Parsed | undefined;
  /**
   * The contract's parse of an argv-supplied whole input, or its refusal,
   * which the handler reports in its own workflow's shape. It parses on
   * first call and reuses the result; undefined when argv does not supply
   * the whole input. Read it through `admittedContractInput`.
   */
  readonly parseWholeInput:
    | (() => Result<Parsed, AnalysisInputError>)
    | undefined;
  /** What each `jsonInputChecks` check admitted, by contract field. */
  readonly checked: Checked;
  /** The projection's CLI-only options, whose effect the handler owns. */
  readonly cliOptions: CliOptions;
}

/**
 * The contract's parse of a projection whose admission parses the whole
 * input, or its refusal. Neither means the projection supplies part of the
 * input elsewhere, which is a defect in that command's registration.
 */
export const admittedContractInput = <Parsed>(context: {
  readonly operation: string;
  readonly parsed: Parsed | undefined;
  readonly parseWholeInput:
    | (() => Result<Parsed, AnalysisInputError>)
    | undefined;
}): Result<Parsed, AnalysisInputError> => {
  if (context.parsed !== undefined) return ok(context.parsed);
  if (context.parseWholeInput === undefined)
    throw invariantViolation(
      `${context.operation} does not admit its whole contract input on the CLI`,
    );
  return context.parseWholeInput();
};

/** The Evidence targets one invocation selected. */
export interface CliEvidenceTargetSelection {
  /** The source contract each target runs. */
  readonly source: string;
  /** Source contract fields this command takes as options, with their flags. */
  readonly sourceFlags: Readonly<Record<string, string>>;
  readonly targets: readonly {
    /** The contract field the target's source Evidence supplies. */
    readonly field: string;
    /** The target's positional key. */
    readonly key: string;
    /** The target as the caller spelled it. */
    readonly target: string;
  }[];
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
        ...(evidenceOutput === undefined
          ? {}
          : { includeEvidenceSources: true }),
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
    });
  };

/**
 * A command's output named for the CLI: renamed issue paths and failure
 * flags (`projectCliInputFields`), and the flags of controls its result
 * records, which the CLI renders in its own envelope.
 */
const projectCliResult = <Output>(
  output: Output,
  outputSchema: z.ZodType | undefined,
  binding: Parameters<typeof projectCliInputFields>[1],
): Output => {
  // A command without flags, or without a result schema that declares
  // recorded controls, has no control to render.
  if (outputSchema !== undefined && Object.keys(binding.flags).length > 0)
    recordCliResultControls(() =>
      // A wrapped delivery recorded its complete Evidence, which the
      // contract's output schema describes; so does a failure's partial
      // Evidence of the same operation.
      cliResultControlsIn(
        cliDeliveredEvidence() ??
          failurePartialObservation(output, binding.operation) ??
          output,
        outputSchema,
        binding,
      ),
    );
  return projectCliInputFields(output, binding);
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
      ...(delivery.view === undefined ? {} : { view: delivery.view }),
    });
  };

/**
 * The session target's opening fields, or the Evidence targets' source
 * fields, when the command declares any.
 */
const admitOpening = (
  description: {
    readonly contract: { readonly name: string };
    readonly sessionTarget: ContractCliSessionTarget | undefined;
    readonly evidenceTargets?: ContractCliEvidenceTargets | undefined;
  },
  values: Readonly<Record<string, unknown>>,
): Result<Readonly<Record<string, unknown>>, AnalysisError> =>
  description.sessionTarget !== undefined
    ? description.sessionTarget.admitOpening(description.contract.name, values)
    : description.evidenceTargets !== undefined
      ? description.evidenceTargets.admitSource(
          description.contract.name,
          values,
        )
      : { ok: true, value: {} };

/** Target positionals, the contract's own, then CLI-only ones, in argv order. */
const commandPositionals = (
  description: ContractCliDescription,
): readonly { readonly key: string; readonly schema: z.ZodType }[] => [
  ...(description.sessionTarget === undefined
    ? []
    : [description.sessionTarget]),
  ...(description.evidenceTargets?.targets ?? []),
  ...description.parameters.filter(({ positional }) => positional),
  ...description.cliPositionals,
];

const commandOptions = (description: ContractCliDescription): z.ZodType => {
  const object = z.object(
    Object.fromEntries([
      ...description.parameters
        .filter(({ positional }) => !positional)
        .map(({ key, schema }) => [key, schema] as const),
      ...[
        ...(description.sessionTarget?.options ?? []),
        ...(description.evidenceTargets?.options ?? []),
      ].map(({ key, schema }) => [key, schema] as const),
      ...description.cliOnlyOptions.map(
        ({ key, schema }) => [key, schema] as const,
      ),
      ...description.parameters.flatMap(({ selectorOption }) =>
        [selectorOption, selectorOption?.alternative].flatMap((option) =>
          option === undefined ? [] : [[option.key, option.schema] as const],
        ),
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
  Checks extends {
    readonly [Key in ContractField<Contract>]?: CliJsonInputCheck;
  } = Record<never, CliJsonInputCheck>,
>(
  cli: CliInstance,
  logger: Logger,
  contract: Contract,
  projection: CliContractProjection<ContractField<Contract>, CliOptions> & {
    readonly jsonInputChecks?: Checks;
  },
  run: (
    input: z.input<Contract["inputSchema"]>,
    context: ContractCommandContext<
      CliOptionValues<CliOptions>,
      z.output<Contract["inputSchema"]>,
      CliCheckedJsonInputs<Checks>
    >,
  ) => Promise<Value>,
): void => {
  const description = describeContractCommand(contract, projection);
  const chosen = describeOperationChoices(description, projection);
  const positionals = commandPositionals(description);
  const alias = Object.fromEntries(
    description.parameters.flatMap(({ key, alias: short, positional }) =>
      short === undefined || positional ? [] : [[key, short]],
    ),
  );
  registerCliCommand(
    cli,
    description.command,
    {
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
      options: commandOptions(description),
      ...(Object.keys(alias).length === 0 ? {} : { alias }),
      run: ({
        args,
        options,
      }: {
        readonly args?: Readonly<Record<string, unknown>>;
        readonly options: Readonly<Record<string, unknown>>;
      }) => {
        const values: Record<string, unknown> = { ...options, ...args };
        // A selector's positional and named option may share one key.
        for (const { key, selectorOption } of description.parameters)
          if (selectorOption !== undefined) {
            values[key] = args?.[key];
            for (const option of [selectorOption, selectorOption.alternative])
              if (option !== undefined)
                values[option.valueKey] = options[option.key];
          }
        const selected =
          projection.operationBy === undefined
            ? description
            : (chosen.get(values[projection.operationBy.option]) ??
              description);
        return withCommandCancellation((signal) =>
          logCliCommand(logger, description.command, async () => {
            const options = selected.admitDeliveryOptions(values);
            if (!options.ok) return projectAnalysisError(options.error);
            const read = await readJsonInputs(selected, options.value, signal);
            if (!read.ok) return read.error;
            const admitted = selected.admit(read.value);
            // Admission and handler issues alike name renamed fields by CLI key.
            if (!admitted.ok)
              return projectCliInputFields(
                projectAnalysisError(admitted.error),
                selected.inputBinding,
              );
            const opening = admitOpening(selected, values);
            if (!opening.ok) return projectAnalysisError(opening.error);
            // A composed command also takes its sources' options; a control
            // its result records from a source is set by that option.
            const operations = contractDescriptionOperations(selected);
            const resultBinding =
              description.evidenceTargets === undefined
                ? { ...selected.inputBinding, operations }
                : {
                    ...selected.inputBinding,
                    operations,
                    flags: {
                      ...description.evidenceTargets.sourceFlags,
                      ...selected.inputBinding.flags,
                    },
                  };
            return projectCliResult(
              await run(
                admitted.value.input as z.input<Contract["inputSchema"]>,
                {
                  signal,
                  operation: selected.contract.name,
                  callerInputs: selected.callerInputs(values),
                  sessionTarget:
                    description.sessionTarget === undefined
                      ? undefined
                      : (values[description.sessionTarget.key] as string),
                  evidenceTargets:
                    description.evidenceTargets === undefined
                      ? undefined
                      : {
                          source: description.evidenceTargets.source,
                          sourceFlags: description.evidenceTargets.sourceFlags,
                          targets: description.evidenceTargets.targets.map(
                            ({ field, key }) => ({
                              field,
                              key,
                              target: values[key] as string,
                            }),
                          ),
                        },
                  opening: opening.value,
                  delivery: admitted.value.delivery,
                  parsed: admitted.value.parsed as
                    | z.output<Contract["inputSchema"]>
                    | undefined,
                  parseWholeInput: admitted.value.parseWholeInput as
                    | (() => Result<
                        z.output<Contract["inputSchema"]>,
                        AnalysisInputError
                      >)
                    | undefined,
                  checked: read.checked as CliCheckedJsonInputs<Checks>,
                  cliOptions: selected.cliOptionValues(
                    values,
                  ) as CliOptionValues<CliOptions>,
                },
              ),
              selected.contract.outputSchema,
              resultBinding,
            );
          }),
        );
      },
    } as never,
    {
      operations: distinctOperations([
        ...contractDescriptionOperations(description),
        ...[...chosen.entries()].flatMap(([value, choice]) =>
          contractDescriptionOperations(choice, {
            selector: `--${optionFlagName(projection.operationBy!.option)} ${String(value)}`,
          }),
        ),
      ]),
      source: { kind: "contract", description },
    },
  );
};

/** One contract input a routed command runs, with the inputs it takes. */
export interface CliCommandRoute {
  readonly description: ContractCliDescription;
  /**
   * Whether this route takes the given input. Only a route that owns every
   * option the caller gave is asked; the last route takes every other input.
   */
  readonly takes: ((values: RouteValues) => Promise<boolean>) | undefined;
  /**
   * What this route's input is, named when an option the caller gave belongs
   * to another route.
   */
  readonly requirement: string;
  readonly run: (
    input: unknown,
    context: ContractCommandContext,
  ) => Promise<unknown>;
}

/**
 * The parsed arguments and options of a routed command, keyed by CLI key.
 * JSON inputs that every route takes are already decoded, so a route can be
 * chosen by document content.
 */
export type RouteValues = Readonly<Record<string, unknown>>;

/** Describe one route of a routed command from its contract input. */
export const commandRoute = <
  Contract extends ProjectedContract,
  CliOptions extends CliOptionShape = Record<never, z.ZodType>,
>(
  contract: Contract,
  projection: CliContractProjection<ContractField<Contract>, CliOptions>,
  run: (
    input: z.input<Contract["inputSchema"]>,
    context: ContractCommandContext<
      CliOptionValues<CliOptions>,
      z.output<Contract["inputSchema"]>
    >,
  ) => Promise<unknown>,
  route: {
    readonly takes?: (values: RouteValues) => Promise<boolean>;
    readonly requirement: string;
  },
): CliCommandRoute => {
  if (projection.operationBy !== undefined)
    throw new Error(`${contract.name} routes by target and by an option`);
  return {
    description: describeContractCommand(contract, projection),
    takes: route.takes,
    requirement: route.requirement,
    run: run as CliCommandRoute["run"],
  };
};

/**
 * The input shape of a union contract that has `field`, as a contract a
 * route can project: the same operation, admitted by that shape alone.
 */
export const contractInputBranch = <
  Name extends string,
  Branches extends readonly z.ZodObject[],
  Field extends string,
>(
  contract: {
    readonly name: Name;
    readonly cli?: true;
    readonly inputSchema: z.ZodUnion<Branches>;
  },
  field: Field,
): {
  readonly name: Name;
  readonly cli?: true;
  readonly inputSchema: Extract<
    Branches[number],
    { readonly shape: { readonly [Key in Field]: z.ZodType } }
  >;
} => {
  const branches = contract.inputSchema.options.filter((branch) =>
    Object.hasOwn(branch.shape, field),
  );
  if (branches.length !== 1)
    throw new Error(`${contract.name} has no single input shape with ${field}`);
  return {
    name: contract.name,
    ...(contract.cli === undefined ? {} : { cli: contract.cli }),
    inputSchema: branches[0] as Extract<
      Branches[number],
      { readonly shape: { readonly [Key in Field]: z.ZodType } }
    >,
  };
};

/** The argv arguments and options one description takes, keyed by CLI key. */
const commandShape = (description: ContractCliDescription) => ({
  args: commandPositionals(description).map(
    ({ key, schema }) => [key, schema] as const,
  ),
  // Routed descriptions declare no object-level rules, so this is the object.
  options: Object.fromEntries(
    Object.entries(
      (commandOptions(description) as z.ZodObject).shape as Readonly<
        Record<string, z.ZodType>
      >,
    ).map(([key, schema]) => [key, withoutDefault(schema)]),
  ),
});

const schemaSignatures = new WeakMap<z.ZodType, string>();

const schemaSignature = (schema: z.ZodType): string => {
  const cached = schemaSignatures.get(schema);
  if (cached !== undefined) return cached;
  const serialized = JSON.stringify(
    z.toJSONSchema(schema, { unrepresentable: "any" }),
  );
  schemaSignatures.set(schema, serialized);
  return serialized;
};

const simpleSchemasIdentical = (left: z.ZodType, right: z.ZodType): boolean => {
  if (left === right) return true;
  if (
    z.globalRegistry.get(left) !== undefined ||
    z.globalRegistry.get(right) !== undefined
  )
    return false;
  const leftDef = left._zod.def as unknown as Readonly<Record<string, unknown>>;
  const rightDef = right._zod.def as unknown as Readonly<
    Record<string, unknown>
  >;
  if (leftDef.type !== rightDef.type) return false;
  switch (leftDef.type) {
    case "boolean":
    case "string":
      return (
        (leftDef.checks as readonly unknown[] | undefined)?.length ===
          undefined &&
        (rightDef.checks as readonly unknown[] | undefined)?.length ===
          undefined
      );
    case "number":
      return (
        leftDef.format === undefined &&
        rightDef.format === undefined &&
        (leftDef.checks as readonly unknown[] | undefined)?.length ===
          undefined &&
        (rightDef.checks as readonly unknown[] | undefined)?.length ===
          undefined
      );
    case "literal": {
      const leftValues = leftDef.values as readonly unknown[];
      const rightValues = rightDef.values as readonly unknown[];
      return (
        leftValues.length === rightValues.length &&
        leftValues.every((value, index) => Object.is(value, rightValues[index]))
      );
    }
    case "enum": {
      const leftEntries = Object.entries(
        leftDef.entries as Record<string, string | number>,
      );
      const rightEntries = rightDef.entries as Record<string, string | number>;
      return (
        leftEntries.length === Object.keys(rightEntries).length &&
        leftEntries.every(
          ([key, value]) =>
            Object.hasOwn(rightEntries, key) &&
            Object.is(rightEntries[key], value),
        )
      );
    }
    case "optional":
    case "nullable":
    case "readonly":
      return simpleSchemasIdentical(
        leftDef.innerType as z.ZodType,
        rightDef.innerType as z.ZodType,
      );
    default:
      return false;
  }
};

const schemasAgree = (left: z.ZodType, right: z.ZodType): boolean =>
  simpleSchemasIdentical(left, right) ||
  schemaSignature(left) === schemaSignature(right);

/**
 * Register one CLI command whose input chooses the contract input it runs,
 * such as `analyze` running static JavaScript analysis on an application
 * archive and the binary overview on a program, or `compare-web-captures`
 * comparing recorded scenarios or passive captures by what the documents
 * hold. Each route is projected from its own contract input; the command
 * takes the union of their options, which must agree on every shared key.
 * The first route that owns every given option and takes the input runs; an
 * option the chosen route does not own is refused naming its CLI key and the
 * route that takes it.
 */
export const registerRoutedCommand = (
  cli: CliInstance,
  logger: Logger,
  command: { readonly description: string },
  routes: readonly [...CliCommandRoute[], CliCommandRoute],
): void => {
  // Every route projects the same command, which names itself or is the own
  // command of one route's contract.
  const name = routes[0]!.description.command;
  const shapes = routes.map(({ description }) => {
    if (
      description.command !== name ||
      description.optionConstraints !== undefined ||
      description.checkOptions !== undefined ||
      description.evidenceTargets !== undefined ||
      description.parameters.some(
        ({ selectorOption }) => selectorOption !== undefined,
      )
    )
      throw new Error(
        `${description.contract.name} cannot be routed by ${name}`,
      );
    return commandShape(description);
  });
  const args = shapes[0]!.args;
  const options = new Map<string, z.ZodType>();
  const owners = new Map<string, CliCommandRoute>();
  for (const [index, shape] of shapes.entries()) {
    if (
      index > 0 &&
      (shape.args.length !== args.length ||
        shape.args.some(
          ([key, schema], position) =>
            key !== args[position]![0] ||
            !schemasAgree(schema, args[position]![1]),
        ))
    )
      throw new Error(`${name} routes take different arguments`);
    for (const [key, schema] of Object.entries(shape.options)) {
      const shared = options.get(key);
      if (shared !== undefined && !schemasAgree(shared, schema))
        throw new Error(`${name} routes disagree on --${key}`);
      options.set(key, schema);
      owners.set(key, routes[index]!);
    }
  }
  const owns = (route: CliCommandRoute, key: string): boolean =>
    args.some(([argument]) => argument === key) ||
    Object.hasOwn(shapes[routes.indexOf(route)]!.options, key);
  // Only JSON inputs every route takes alike are decoded before routing.
  const sharedJson = sharedJsonInputs(name, routes);
  registerCliCommand(
    cli,
    name,
    {
      description: command.description,
      args: z.object(Object.fromEntries(args)),
      options: z.object(Object.fromEntries(options)),
      run: ({
        args: given,
        options: chosen,
      }: {
        readonly args: Readonly<Record<string, unknown>>;
        readonly options: Readonly<Record<string, unknown>>;
      }) => {
        const values: Record<string, unknown> = { ...chosen, ...given };
        const supplied = Object.keys(values).filter(
          (key) => values[key] !== undefined,
        );
        return withCommandCancellation((signal) =>
          logCliCommand(logger, name, async () => {
            const shared = await readJsonInputs(
              routes[0]!.description,
              values,
              signal,
              sharedJson,
            );
            if (!shared.ok) return shared.error;
            let route = routes.at(-1)!;
            for (const candidate of routes)
              if (
                candidate.takes !== undefined &&
                supplied.every((key) => owns(candidate, key)) &&
                (await candidate.takes(shared.value))
              ) {
                route = candidate;
                break;
              }
            const { description } = route;
            const refused = supplied.filter((key) => !owns(route, key));
            if (refused.length > 0)
              return projectAnalysisError(
                new AnalysisInputError(
                  description.contract.name,
                  undefined,
                  refused.map((key) => ({
                    path: [key],
                    reason: "invalid_value" as const,
                    message: `--${optionFlagName(key)} requires ${owners.get(key)!.requirement}; the given input selects ${route.requirement}, which does not take it.`,
                  })),
                ),
              );
            const options = description.admitDeliveryOptions(shared.value);
            if (!options.ok) return projectAnalysisError(options.error);
            const read = await readJsonInputs(
              description,
              options.value,
              signal,
              ownJsonInputs(description, sharedJson),
            );
            if (!read.ok) return read.error;
            const admitted = description.admit(read.value);
            if (!admitted.ok)
              return projectCliInputFields(
                projectAnalysisError(admitted.error),
                description.inputBinding,
              );
            const opening = admitOpening(description, values);
            if (!opening.ok) return projectAnalysisError(opening.error);
            return projectCliResult(
              await route.run(admitted.value.input, {
                signal,
                operation: description.contract.name,
                callerInputs: description.callerInputs(values),
                sessionTarget:
                  description.sessionTarget === undefined
                    ? undefined
                    : (values[description.sessionTarget.key] as string),
                evidenceTargets: undefined,
                opening: opening.value,
                delivery: admitted.value.delivery,
                parsed: admitted.value.parsed,
                parseWholeInput: admitted.value.parseWholeInput,
                checked: { ...shared.checked, ...read.checked },
                cliOptions: description.cliOptionValues(
                  withCliOnlyDefaults(description, values),
                ),
              }),
              description.contract.outputSchema,
              {
                ...description.inputBinding,
                operations: contractDescriptionOperations(description),
              },
            );
          }),
        );
      },
    } as never,
    {
      operations: distinctOperations(
        routes.flatMap(({ description }) =>
          contractDescriptionOperations(description),
        ),
      ),
      source: {
        kind: "routed",
        descriptions: routes.map(({ description }) => description),
      },
    },
  );
};

/**
 * Routing saw CLI-only options without their defaults; the chosen route's
 * handler receives each omitted one's default, which no contract parse
 * would otherwise restore.
 */
const withCliOnlyDefaults = (
  description: ContractCliDescription,
  values: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => ({
  ...values,
  ...Object.fromEntries(
    description.cliOnlyOptions.flatMap(({ key, schema }) =>
      values[key] === undefined ? [[key, schema.parse(undefined)]] : [],
    ),
  ),
});

/** The CLI keys of a description's JSON inputs. */
const jsonInputKeys = (
  description: ContractCliDescription,
): ReadonlySet<string> =>
  new Set(
    description.parameters
      .filter(({ jsonInput }) => jsonInput)
      .map(({ key }) => key),
  );

/**
 * The JSON inputs every route takes under the same key, with the same
 * refusal, so they can be decoded once before a route is chosen.
 */
const sharedJsonInputs = (
  command: string,
  routes: readonly CliCommandRoute[],
): ReadonlySet<string> => {
  const keys = routes.map(({ description }) => jsonInputKeys(description));
  const shared = new Set(
    [...keys[0]!].filter((key) => keys.every((own) => own.has(key))),
  );
  for (const key of shared) {
    const parameters = routes.map(({ description }) =>
      description.parameters.find((parameter) => parameter.key === key)!,
    );
    if (new Set(parameters.map(({ runtimeJson }) => runtimeJson)).size !== 1)
      throw new Error(`${command} routes refuse --${key} differently`);
    // A shared input is checked before the route is chosen, so every route
    // must check it the same way.
    if (
      new Set(parameters.map(({ checkJsonInput }) => checkJsonInput)).size !== 1
    )
      throw new Error(`${command} routes check --${key} differently`);
  }
  return shared;
};

/** The chosen route's JSON inputs that were not decoded before routing. */
const ownJsonInputs = (
  description: ContractCliDescription,
  decoded: ReadonlySet<string>,
): ReadonlySet<string> =>
  new Set([...jsonInputKeys(description)].filter((key) => !decoded.has(key)));

/**
 * Read and decode each JSON input the caller gave, inline or from a file,
 * before the parameters are admitted; `keys` limits which are read. A file
 * that cannot be read keeps its own failure; inline text that is not JSON is
 * refused under its CLI key.
 */
const readJsonInputs = async (
  description: ContractCliDescription,
  values: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
  keys: ReadonlySet<string> = jsonInputKeys(description),
): Promise<
  | {
      readonly ok: true;
      readonly value: Readonly<Record<string, unknown>>;
      readonly checked: Readonly<Record<string, unknown>>;
    }
  | { readonly ok: false; readonly error: JsonValue }
> => {
  const decoded: Record<string, unknown> = { ...values };
  const checked: Record<string, unknown> = {};
  for (const {
    field,
    key,
    runtimeJson,
    checkJsonInput,
  } of description.parameters) {
    const text = values[key];
    if (!keys.has(key) || typeof text !== "string") continue;
    const parsed = await parseCliJsonInput(
      text,
      description.contract.name,
      signal,
    );
    if (!parsed.ok)
      return {
        ok: false,
        error: keepsOwnFailure(parsed.error)
          ? parsed.error
          : projectAnalysisError(
              new AnalysisInputError(description.contract.name, undefined, [
                {
                  path: [key],
                  reason: "invalid_format",
                  expected: "JSON",
                  ...(runtimeJson === undefined
                    ? {}
                    : { message: runtimeJson }),
                },
              ]),
            ),
      };
    decoded[key] = parsed.value;
    if (checkJsonInput === undefined) continue;
    // Refuse this input before the next one is read.
    const admitted = checkJsonInput(parsed.value);
    if (!admitted.ok)
      return {
        ok: false,
        error: projectCliInputFields(
          projectAnalysisError(admitted.error),
          description.inputBinding,
        ),
      };
    checked[field] = admitted.value;
  }
  return { ok: true, value: decoded, checked };
};

/** A file failure names the selected path, and a cancellation is its own. */
const keepsOwnFailure = (error: JsonValue): boolean =>
  isRecord(error) &&
  ("input_path" in error ||
    (error as { readonly code?: unknown }).code === "cancelled");
