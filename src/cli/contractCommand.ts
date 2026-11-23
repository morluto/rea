import { z } from "zod";
import { invariantViolation } from "../domain/internalInvariant.js";
import type { Logger } from "pino";

import { logCliCommand } from "../cliLogging.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import type { CallerInputPaths } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { parseCliJsonInput } from "./cliJsonInput.js";
import {
  describeContractCommand,
  describeOperationChoices,
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
 * A command's output named for the CLI: renamed issue paths and failure
 * flags (`projectCliInputFields`), and the flags of controls its result
 * records, which the CLI renders in its own envelope.
 */
export const projectCliResult = <Output>(
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
 * The session target's opening fields, or the Evidence targets' source
 * fields, when the command declares any.
 */
export const admitOpening = (
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
export const commandPositionals = (
  description: ContractCliDescription,
): readonly { readonly key: string; readonly schema: z.ZodType }[] => [
  ...(description.sessionTarget === undefined
    ? []
    : [description.sessionTarget]),
  ...(description.evidenceTargets?.targets ?? []),
  ...description.parameters.filter(({ positional }) => positional),
  ...description.cliPositionals,
];

export const commandOptions = (
  description: ContractCliDescription,
): z.ZodType => {
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

/** The CLI keys of a description's JSON inputs. */
export const jsonInputKeys = (
  description: ContractCliDescription,
): ReadonlySet<string> =>
  new Set(
    description.parameters
      .filter(({ jsonInput }) => jsonInput)
      .map(({ key }) => key),
  );

/**
 * Read and decode each JSON input the caller gave, inline or from a file,
 * before the parameters are admitted; `keys` limits which are read. A file
 * that cannot be read keeps its own failure; inline text that is not JSON is
 * refused under its CLI key.
 */
export const readJsonInputs = async (
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
