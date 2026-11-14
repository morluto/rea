import { z } from "incur";
import type { Logger } from "pino";

import { logCliCommand } from "../cliLogging.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Evidence } from "../domain/evidence.js";
import { localPathStringSchema } from "../domain/localPath.js";
import type { Result } from "../domain/result.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { finishCliEvidenceCommand } from "./cliEvidenceCallerPath.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import { cliDecimalShape } from "./options.js";
import type { CliInstance } from "./types.js";

/** The parts of a tool contract that a CLI projection reads. */
export interface ProjectedContract<Name extends string = string> {
  readonly name: Name;
  readonly inputSchema: z.ZodObject;
}

/** A contract input field name. */
export type ContractField<Contract extends ProjectedContract> = keyof z.input<
  Contract["inputSchema"]
> &
  string;

/** How one contract field is spelled on the CLI. */
export interface CliFieldProjection {
  /**
   * Option or argument key, which Incur shows as a kebab-case flag. Omit to
   * use the camelCase spelling of the contract field.
   */
  readonly name?: string;
  /** CLI help, when it differs from the contract field's description. */
  readonly description?: string;
}

/**
 * The CLI spelling of one contract. Everything not listed here is derived
 * from the contract input schema: each field keeps its own schema, so the
 * CLI admits what the contract admits.
 */
export interface CliContractProjection<Field extends string> {
  readonly command: string;
  readonly description: string;
  /** Fields taken as positional arguments, in argv order. */
  readonly positionals?: readonly Field[];
  /**
   * Absolute-path fields the caller may spell relative to the working
   * directory. The CLI admits a nonempty, NUL-free, well-formed path, then
   * resolves it with `absoluteCallerPath` before the contract sees it.
   */
  readonly callerPaths?: readonly Field[];
  readonly fields?: { readonly [Key in Field]?: CliFieldProjection };
  /**
   * Optional fields this one-shot command does not expose, each with the
   * reason. The contract's own default applies.
   */
  readonly omit?: { readonly [Key in Field]?: string };
}

/** One contract from a contract group, keeping its exact schema types. */
export const contractNamed = <
  Contracts extends readonly ProjectedContract[],
  Name extends Contracts[number]["name"],
>(
  contracts: Contracts,
  name: Name,
): Extract<Contracts[number], { readonly name: Name }> => {
  const contract = contracts.find(
    (
      candidate,
    ): candidate is Extract<Contracts[number], { readonly name: Name }> =>
      candidate.name === name,
  );
  if (contract === undefined) throw new Error(`Missing tool contract: ${name}`);
  return contract;
};

/** What a contract command's handler receives besides the contract input. */
export interface ContractCommandContext {
  readonly signal: AbortSignal;
  /** The contract name, which is the canonical operation. */
  readonly operation: string;
  /** Each caller-path field as the caller spelled it, before resolution. */
  readonly callerInputs: Readonly<Record<string, string>>;
}

/** A closeable one-shot service that inspects one contract input. */
export interface EvidenceInspectionService {
  inspect(
    input: unknown,
    options: { readonly signal: AbortSignal },
  ): Promise<Result<Evidence, AnalysisError>>;
  close(): Promise<void>;
}

/**
 * Inspect through a closeable service, finish its cleanup, and record the
 * caller's spelling of `path` in the Evidence.
 */
export const inspectWithService =
  (service: () => EvidenceInspectionService, providerId: string) =>
  (
    input: unknown,
    { signal, operation, callerInputs }: ContractCommandContext,
  ) => {
    const callerPath = callerInputs.path;
    if (callerPath === undefined)
      throw new Error(`${operation} has no caller path field named path`);
    const owned = service();
    return finishCliEvidenceCommand(
      callerPath,
      () => owned.inspect(input, { signal }),
      owned,
      providerId,
      operation,
      signal,
    ).then(projectCliAnalysisResult);
  };

interface FieldBinding {
  readonly field: string;
  readonly key: string;
  readonly positional: boolean;
  readonly callerPath: boolean;
}

/** A command registered from a contract; the parity guard reads these. */
export interface ContractCommandBinding {
  readonly command: string;
  readonly contract: ProjectedContract;
  readonly fields: readonly FieldBinding[];
  readonly omitted: readonly string[];
  /** Map parsed CLI arguments and options to the contract input. */
  readonly toContractInput: (
    args: Readonly<Record<string, unknown>>,
    options: Readonly<Record<string, unknown>>,
  ) => Record<string, unknown>;
}

const bindings = new WeakMap<CliInstance, ContractCommandBinding[]>();

/** Commands registered on this CLI through `registerContractCommand`. */
export const contractCommandBindings = (
  cli: CliInstance,
): readonly ContractCommandBinding[] => bindings.get(cli) ?? [];

const camelCase = (field: string): string =>
  field.replaceAll(/_([a-z0-9])/gu, (_, letter: string) =>
    letter.toUpperCase(),
  );

const admitsOmission = (field: z.ZodType): boolean =>
  field.safeParse(undefined).success;

/** Caller-relative spelling of an absolute-path contract field. */
const callerPathField = (field: z.ZodType): z.ZodType => {
  const admitted = admitsOmission(field)
    ? localPathStringSchema.optional()
    : localPathStringSchema;
  return field.description === undefined
    ? admitted
    : admitted.describe(field.description);
};

/**
 * Reject field kinds whose argv form this projection does not define, so a
 * new contract field cannot reach the CLI with an unreviewed spelling.
 */
const assertArgvField = (
  contract: string,
  field: string,
  schema: z.ZodType,
) => {
  const core = (value: z.ZodType): z.ZodType => {
    let current = value;
    while (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodExactOptional ||
      current instanceof z.ZodDefault ||
      current instanceof z.ZodPrefault ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodReadonly
    )
      current = current.unwrap() as z.ZodType;
    return current;
  };
  const scalar = (value: z.ZodType): boolean =>
    value instanceof z.ZodString ||
    value instanceof z.ZodNumber ||
    value instanceof z.ZodBoolean ||
    value instanceof z.ZodEnum;
  const current = core(schema);
  const supported =
    scalar(current) ||
    (current instanceof z.ZodArray &&
      (core(current.element as z.ZodType) instanceof z.ZodString ||
        core(current.element as z.ZodType) instanceof z.ZodEnum));
  if (!supported)
    throw new Error(
      `${contract}.${field} has no argv projection; declare one before exposing it on the CLI`,
    );
};

const OBJECT_CONSTRAINTS = ["dependentRequired", "if", "then", "else"] as const;

/** Contract-level presentation that CLI help states in its own words. */
const ROOT_ANNOTATIONS: ReadonlySet<string> = new Set([
  "description",
  "title",
  "examples",
]);

/** Rename the field names inside the object constraints the contract advertises. */
const renameConstraint = (
  contract: string,
  value: unknown,
  rename: (field: string) => string,
): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${contract} has an unsupported object constraint`);
  return Object.fromEntries(
    Object.entries(value).map(([keyword, inner]) => {
      if (keyword === "required" && Array.isArray(inner))
        return [keyword, inner.map((field: string) => rename(field))];
      if (keyword === "properties" && typeof inner === "object" && inner)
        return [
          keyword,
          Object.fromEntries(
            Object.entries(inner).map(([field, schema]) => [
              rename(field),
              schema,
            ]),
          ),
        ];
      throw new Error(
        `${contract} object constraint keyword ${keyword} has no CLI projection`,
      );
    }),
  );
};

const projectObjectConstraints = (
  contract: ProjectedContract,
  rename: (field: string) => string,
): Record<string, unknown> | undefined => {
  const metadata = contract.inputSchema.meta();
  if (metadata === undefined) return undefined;
  for (const keyword of Object.keys(metadata))
    if (
      !ROOT_ANNOTATIONS.has(keyword) &&
      !(OBJECT_CONSTRAINTS as readonly string[]).includes(keyword)
    )
      throw new Error(
        `${contract.name} input keyword ${keyword} has no CLI projection`,
      );
  const projected: Record<string, unknown> = {};
  for (const keyword of OBJECT_CONSTRAINTS) {
    const value = metadata[keyword];
    if (value === undefined) continue;
    projected[keyword] =
      keyword === "dependentRequired"
        ? Object.fromEntries(
            Object.entries(value as Record<string, readonly string[]>).map(
              ([field, required]) => [rename(field), required.map(rename)],
            ),
          )
        : renameConstraint(contract.name, value, rename);
  }
  return Object.keys(projected).length === 0 ? undefined : projected;
};

/**
 * Register one CLI command whose arguments and options are projected from a
 * tool contract. Field schemas, bounds, defaults and help come from the
 * contract; decimal integers use the shared argv grammar; cross-field rules
 * run once through the contract with issue paths renamed to CLI keys. The
 * handler receives the contract input, with caller paths made absolute.
 */
export const registerContractCommand = <
  Contract extends ProjectedContract,
  Value,
>(
  cli: CliInstance,
  logger: Logger,
  contract: Contract,
  projection: CliContractProjection<ContractField<Contract>>,
  run: (
    input: z.input<Contract["inputSchema"]>,
    context: ContractCommandContext,
  ) => Promise<Value>,
): void => {
  const shape = contract.inputSchema.shape as Record<string, z.ZodType>;
  const positionals: readonly string[] = projection.positionals ?? [];
  const callerPaths: ReadonlySet<string> = new Set(
    projection.callerPaths ?? [],
  );
  const fieldProjections: Readonly<
    Record<string, CliFieldProjection | undefined>
  > = projection.fields ?? {};
  const omitted = Object.keys(projection.omit ?? {});
  for (const field of [
    ...positionals,
    ...callerPaths,
    ...Object.keys(fieldProjections),
    ...omitted,
  ])
    if (!Object.hasOwn(shape, field))
      throw new Error(`${contract.name} has no input field ${field}`);
  for (const field of omitted)
    if (!admitsOmission(shape[field]!))
      throw new Error(`${contract.name}.${field} is required on the CLI`);

  const ordered = [
    ...positionals,
    ...Object.keys(shape).filter(
      (field) => !positionals.includes(field) && !omitted.includes(field),
    ),
  ];
  const fields: FieldBinding[] = ordered.map((field) => ({
    field,
    key: fieldProjections[field]?.name ?? camelCase(field),
    positional: positionals.includes(field),
    callerPath: callerPaths.has(field),
  }));
  const keyOf = new Map(fields.map((binding) => [binding.field, binding.key]));
  const rename = (field: string): string => keyOf.get(field) ?? field;

  const cliSchema = (binding: FieldBinding): z.ZodType => {
    const field = shape[binding.field]!;
    const description = fieldProjections[binding.field]?.description;
    if (binding.callerPath) {
      const admitted = callerPathField(field);
      return description === undefined
        ? admitted
        : admitted.describe(description);
    }
    assertArgvField(contract.name, binding.field, field);
    const admitted = cliDecimalShape({ field }).field;
    return description === undefined
      ? admitted
      : admitted.describe(description);
  };
  const groupShape = (positional: boolean) =>
    Object.fromEntries(
      fields
        .filter((binding) => binding.positional === positional)
        .map((binding) => [binding.key, cliSchema(binding)]),
    );

  const toContractInput = (
    args: Readonly<Record<string, unknown>>,
    options: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> => {
    const input: Record<string, unknown> = {};
    for (const binding of fields) {
      const value = (binding.positional ? args : options)[binding.key];
      if (value === undefined) continue;
      input[binding.field] =
        binding.callerPath && typeof value === "string"
          ? absoluteCallerPath(value)
          : value;
    }
    return input;
  };

  // Cross-field rules belong to the contract. Run its own object checks on
  // the options mapped to contract names, then report CLI keys. Positional
  // values are not visible to an options refinement; the service's contract
  // parse still enforces any rule that reads them.
  const checks = contract.inputSchema._zod.def.checks ?? [];
  const contractChecks = z
    .object({})
    .loose()
    .check(...(checks as z.core.$ZodCheck<Record<string, unknown>>[]));
  const refined = (options: z.ZodObject): z.ZodType =>
    checks.length === 0
      ? options
      : options.superRefine((parsed, context) => {
          const result = contractChecks.safeParse(toContractInput({}, parsed));
          if (result.success) return;
          for (const issue of result.error.issues) {
            const [field, ...rest] = issue.path;
            context.addIssue({
              ...issue,
              path:
                typeof field === "string"
                  ? [rename(field), ...rest]
                  : issue.path,
            } as never);
          }
        });
  const constraints = projectObjectConstraints(contract, rename);
  const optionsObject = z.object(groupShape(false));
  const options = refined(
    constraints === undefined ? optionsObject : optionsObject.meta(constraints),
  );
  const args =
    positionals.length === 0 ? undefined : z.object(groupShape(true));

  cli.command(projection.command, {
    description: projection.description,
    ...(args === undefined ? {} : { args }),
    options,
    run: ({
      args: parsedArgs,
      options: parsedOptions,
    }: {
      readonly args?: Readonly<Record<string, unknown>>;
      readonly options: Readonly<Record<string, unknown>>;
    }) => {
      const rawArgs = parsedArgs ?? {};
      const rawOptions = parsedOptions;
      const callerInputs: Record<string, string> = {};
      for (const binding of fields) {
        const value = (binding.positional ? rawArgs : rawOptions)[binding.key];
        if (binding.callerPath && typeof value === "string")
          callerInputs[binding.field] = value;
      }
      return withCommandCancellation((signal) =>
        logCliCommand(logger, projection.command, () =>
          run(
            toContractInput(rawArgs, rawOptions) as z.input<
              Contract["inputSchema"]
            >,
            { signal, operation: contract.name, callerInputs },
          ),
        ),
      );
    },
  } as never);
  const registered = bindings.get(cli) ?? [];
  registered.push({
    command: projection.command,
    contract,
    fields,
    omitted,
    toContractInput,
  });
  bindings.set(cli, registered);
};
