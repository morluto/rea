import { z } from "incur";
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
import type { Result } from "../domain/result.js";
import type { ArtifactAnalysisOperation } from "../contracts/artifactToolContracts.js";
import { openBinaryTargetSelection } from "../contracts/sessionLifecycleInputs.js";
import {
  deliverCliAnalysisEvidence,
  publishCliAnalysisEvidence,
} from "./analysisEvidenceDelivery.js";
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
  describeOperationChoices,
  type CliEvidenceDeliveryChoice,
  type CliOptionShape,
  type CliOptionValues,
  type ContractCliDescription,
  type ContractCliSessionTarget,
  type ContractField,
  type ProjectedContract,
} from "./contractCliDescription.js";
import {
  projectCliAnalysisResult,
  projectCliInputFields,
} from "./projectCliAnalysisResult.js";
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
  /**
   * The session target's opening fields the caller selected, in the opening
   * contract's spelling; empty without `sessionTarget.open`.
   */
  readonly opening: Readonly<Record<string, unknown>>;
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

/** The session target's opening fields, when the command declares any. */
const admitOpening = (
  description: {
    readonly contract: { readonly name: string };
    readonly sessionTarget: ContractCliSessionTarget | undefined;
  },
  values: Readonly<Record<string, unknown>>,
): Result<Readonly<Record<string, unknown>>, AnalysisError> =>
  description.sessionTarget === undefined
    ? { ok: true, value: {} }
    : description.sessionTarget.admitOpening(description.contract.name, values);

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
      ...(description.sessionTarget?.options ?? []).map(
        ({ key, schema }) => [key, schema] as const,
      ),
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
  const chosen = describeOperationChoices(description, projection);
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
          : (chosen.get(values[projection.operationBy.option]) ?? description);
      return withCommandCancellation((signal) =>
        logCliCommand(logger, description.command, async () => {
          const admitted = selected.admit(values);
          if (!admitted.ok) return projectAnalysisError(admitted.error);
          const opening = admitOpening(selected, values);
          if (!opening.ok) return projectAnalysisError(opening.error);
          // Every handler's input issues name renamed fields by their CLI key.
          return projectCliInputFields(
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
                opening: opening.value,
                delivery: admitted.value.delivery,
                cliOptions: selected.cliOptionValues(
                  values,
                ) as CliOptionValues<CliOptions>,
              },
            ),
            selected.inputBinding,
          );
        }),
      );
    },
  } as never);
  const registered = descriptions.get(cli) ?? [];
  registered.push(description);
  descriptions.set(cli, registered);
};

/** One contract a target-routed command runs, with the targets it takes. */
export interface CliTargetRoute {
  readonly description: ContractCliDescription;
  /**
   * Whether this route takes the target. Only a route that owns every
   * option the caller gave is asked; the last route takes every other target.
   */
  readonly takesTarget: ((target: string) => Promise<boolean>) | undefined;
  /** What this route's own options need, named when another route refuses them. */
  readonly requirement: string;
  readonly run: (
    input: unknown,
    context: ContractCommandContext,
  ) => Promise<unknown>;
}

/** Describe one route of a target-routed command from its contract. */
export const targetRoute = <
  Contract extends ProjectedContract,
  CliOptions extends CliOptionShape = Record<never, z.ZodType>,
>(
  contract: Contract,
  projection: CliContractProjection<ContractField<Contract>, CliOptions>,
  run: (
    input: z.input<Contract["inputSchema"]>,
    context: ContractCommandContext<CliOptionValues<CliOptions>>,
  ) => Promise<unknown>,
  route: {
    readonly takesTarget?: (target: string) => Promise<boolean>;
    readonly requirement: string;
  },
): CliTargetRoute => {
  if (projection.operationBy !== undefined)
    throw new Error(`${contract.name} routes by target and by an option`);
  return {
    description: describeContractCommand(contract, projection),
    takesTarget: route.takesTarget,
    requirement: route.requirement,
    run: run as CliTargetRoute["run"],
  };
};

/** The argv arguments and options one description takes, keyed by CLI key. */
const commandShape = (description: ContractCliDescription) => ({
  args: [
    ...(description.sessionTarget === undefined
      ? []
      : [description.sessionTarget]),
    ...description.parameters.filter(({ positional }) => positional),
  ].map(({ key, schema }) => [key, schema] as const),
  // Routed descriptions declare no object-level rules, so this is the object.
  options: Object.fromEntries(
    Object.entries(
      (incurOptions(description) as z.ZodObject).shape as Readonly<
        Record<string, z.ZodType>
      >,
    ).map(([key, schema]) => [key, withoutDefault(schema)]),
  ),
});

/**
 * An omitted option must stay omitted, since a given option routes the
 * target; the chosen contract applies its own default on admission. Help and
 * `--schema` keep the option's metadata.
 */
const withoutDefault = (schema: z.ZodType): z.ZodType => {
  if (!(schema instanceof z.ZodDefault)) return schema;
  const omittable = (schema.removeDefault() as z.ZodType).optional();
  const metadata = schema.meta();
  return metadata === undefined ? omittable : omittable.meta(metadata);
};

const schemaSignature = (schema: z.ZodType): string =>
  JSON.stringify(z.toJSONSchema(schema, { unrepresentable: "any" }));

const routedDescriptions = new WeakMap<CliInstance, ContractCliDescription[]>();

/** Route descriptions of commands registered through `registerTargetRoutedCommand`. */
export const targetRoutedCommandDescriptions = (
  cli: CliInstance,
): readonly ContractCliDescription[] => routedDescriptions.get(cli) ?? [];

/**
 * Register one CLI command whose target chooses the contract it runs, such
 * as `analyze` running static JavaScript analysis on an application archive
 * and the binary overview on a program. Each route is projected from its own
 * contract; the command takes the union of their options, which must agree
 * on every shared key. The first route that owns every given option and
 * takes the target runs; an option the chosen route does not own is refused
 * naming its CLI key and the route that takes it.
 */
export const registerTargetRoutedCommand = (
  cli: CliInstance,
  logger: Logger,
  command: { readonly command: string; readonly description: string },
  routes: readonly [...CliTargetRoute[], CliTargetRoute],
): void => {
  const shapes = routes.map(({ description }) => {
    if (
      description.command !== command.command ||
      description.optionConstraints !== undefined ||
      description.checkOptions !== undefined ||
      description.parameters.some(
        ({ selectorOption }) => selectorOption !== undefined,
      )
    )
      throw new Error(
        `${description.contract.name} cannot be routed by ${command.command}`,
      );
    return commandShape(description);
  });
  const args = shapes[0]!.args;
  const options = new Map<string, z.ZodType>();
  const owners = new Map<string, CliTargetRoute>();
  for (const [index, shape] of shapes.entries()) {
    if (
      shape.args.length !== args.length ||
      shape.args.some(
        ([key, schema], position) =>
          key !== args[position]![0] ||
          schemaSignature(schema) !== schemaSignature(args[position]![1]),
      )
    )
      throw new Error(`${command.command} routes take different arguments`);
    for (const [key, schema] of Object.entries(shape.options)) {
      const shared = options.get(key);
      if (
        shared !== undefined &&
        schemaSignature(shared) !== schemaSignature(schema)
      )
        throw new Error(`${command.command} routes disagree on --${key}`);
      options.set(key, schema);
      owners.set(key, routes[index]!);
    }
  }
  const owns = (route: CliTargetRoute, key: string): boolean =>
    args.some(([argument]) => argument === key) ||
    Object.hasOwn(shapes[routes.indexOf(route)]!.options, key);
  const [targetKey] = args[0] ?? [];
  if (targetKey === undefined)
    throw new Error(`${command.command} routes take no target`);
  cli.command(command.command, {
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
        logCliCommand(logger, command.command, async () => {
          const target = values[targetKey] as string;
          let route = routes.at(-1)!;
          for (const candidate of routes)
            if (
              candidate.takesTarget !== undefined &&
              supplied.every((key) => owns(candidate, key)) &&
              (await candidate.takesTarget(target))
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
                  message: `--${kebabCase(key)} requires ${owners.get(key)!.requirement}; this target runs ${description.contract.name}, which does not take it.`,
                })),
              ),
            );
          const admitted = description.admit(values);
          if (!admitted.ok) return projectAnalysisError(admitted.error);
          const opening = admitOpening(description, values);
          if (!opening.ok) return projectAnalysisError(opening.error);
          return projectCliInputFields(
            await route.run(admitted.value.input, {
              signal,
              operation: description.contract.name,
              callerInputs: description.callerInputs(values),
              sessionTarget:
                description.sessionTarget === undefined ? undefined : target,
              opening: opening.value,
              delivery: admitted.value.delivery,
              cliOptions: description.cliOptionValues(
                withCliOnlyDefaults(description, values),
              ),
            }),
            description.inputBinding,
          );
        }),
      );
    },
  } as never);
  const registered = routedDescriptions.get(cli) ?? [];
  registered.push(...routes.map(({ description }) => description));
  routedDescriptions.set(cli, registered);
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

const kebabCase = (key: string): string =>
  key.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);

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
  /**
   * The document's transport frame as `--schema` advertises it. A handler
   * that reads other inputs first, such as an Evidence bundle, admits the
   * document with it beforehand; Evidence carriers stay with their owner.
   */
  readonly frame: z.ZodType;
  /** The admitted delivery, for a projection with `evidenceDelivery`. */
  readonly delivery: CliEvidenceDeliveryChoice | undefined;
  /** The projection's CLI-only options, whose effect the handler owns. */
  readonly cliOptions: CliOptions;
  /**
   * The session target as the caller spelled it, for a projection with
   * `sessionTarget`; undefined otherwise.
   */
  readonly sessionTarget: string | undefined;
  /**
   * The session target's opening fields the caller selected, in the opening
   * contract's spelling; empty without `sessionTarget.open`.
   */
  readonly opening: Readonly<Record<string, unknown>>;
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
 * A document field the projection omits or takes as an option is refused
 * with its reason rather than passed to an owner that would act on it.
 */
const refusedDocumentFieldError = (
  operation: string,
  refusals: Readonly<Record<string, string>>,
  document: object,
): AnalysisError | undefined => {
  const issues = Object.entries(refusals)
    .filter(([field]) => Object.hasOwn(document, field))
    .map(([field, message]) => ({
      code: "custom" as const,
      path: [field],
      message,
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
    [
      ...(description.sessionTarget?.options ?? []),
      ...description.deliveryOptions,
      ...description.cliOnlyOptions,
    ].map(({ key, schema }) => [key, schema]),
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
          // Delivery options are checked before the document is read.
          const delivery = description.admitDelivery(values);
          if (!delivery.ok) return projectAnalysisError(delivery.error);
          const opening = admitOpening(description, { ...values, ...args });
          if (!opening.ok) return projectAnalysisError(opening.error);
          const decoded = await parseCliJsonInput(
            args[description.key]!,
            contract.name,
            signal,
          );
          if (!decoded.ok) return decoded.error;
          // A document that is not an object has no fields to refuse; the
          // contract refuses it.
          const refused =
            typeof decoded.value === "object" && decoded.value !== null
              ? refusedDocumentFieldError(
                  contract.name,
                  description.documentRefusals,
                  decoded.value,
                )
              : undefined;
          if (refused !== undefined) return projectAnalysisError(refused);
          return run(
            resolveCliJsonPaths(decoded.value, description.callerPaths),
            {
              signal,
              operation: contract.name,
              spelled: decoded.value,
              frame: description.content,
              delivery: delivery.value,
              opening: opening.value,
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
