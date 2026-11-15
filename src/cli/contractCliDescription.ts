import { z } from "zod";

import { localPathStringSchema } from "../domain/localPath.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { cliDecimalShape } from "./options.js";

/**
 * Framework-neutral CLI description of a tool contract. This module owns
 * which contract fields become positionals and options, their spellings,
 * help and argv admission, and the mapping back to contract input. A CLI
 * framework adapter (today `contractCommand.ts` for Incur) only renders it.
 */

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
  /** Parameter key, in camelCase. Omit to use the camelCase contract field. */
  readonly name?: string;
  /** Single-character short flag. */
  readonly alias?: string;
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
  /**
   * Where the contract's cross-field rules first refuse a combination.
   * `argv` reports them as CLI validation errors naming CLI keys; by default
   * the service's contract parse reports them as an `invalid_request`.
   */
  readonly crossFieldRules?: "argv";
}

/** One positional argument or option of a contract command. */
export interface ContractCliParameter {
  /** The contract input field this parameter supplies. */
  readonly field: string;
  /** camelCase key; an option's flag is its kebab-case spelling. */
  readonly key: string;
  readonly positional: boolean;
  readonly alias: string | undefined;
  readonly description: string | undefined;
  /**
   * Admission of the parsed argv value: the contract field's own schema,
   * with decimal integer tokens and caller-relative paths admitted.
   */
  readonly schema: z.ZodType;
  /** A bare flag sets true; it takes no value. */
  readonly booleanFlag: boolean;
  /** The option may repeat; each occurrence adds one array element. */
  readonly repeatable: boolean;
  /** Integer values are spelled as decimal digits only. */
  readonly decimal: boolean;
  /** Resolved with `absoluteCallerPath` before the contract sees it. */
  readonly callerPath: boolean;
}

/** One cross-field refusal, naming CLI keys. */
export interface ContractCliIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly issue: z.core.$ZodIssue;
}

/** A complete, framework-neutral CLI command derived from one contract. */
export interface ContractCliDescription {
  readonly command: string;
  readonly description: string;
  readonly contract: ProjectedContract;
  readonly parameters: readonly ContractCliParameter[];
  /** Contract fields the command does not expose, with the reason. */
  readonly omitted: Readonly<Record<string, string>>;
  /** Object-level JSON Schema constraints, renamed to CLI keys. */
  readonly optionConstraints: Readonly<Record<string, unknown>> | undefined;
  /**
   * The contract's cross-field rules over parsed option values, when the
   * projection refuses them at argv parsing; undefined otherwise.
   */
  readonly checkOptions:
    | ((
        options: Readonly<Record<string, unknown>>,
      ) => readonly ContractCliIssue[])
    | undefined;
  /** Map parsed values, keyed by parameter key, to the contract input. */
  readonly toContractInput: (
    values: Readonly<Record<string, unknown>>,
  ) => Record<string, unknown>;
  /** Each caller-path field as the caller spelled it, before resolution. */
  readonly callerInputs: (
    values: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, string>>;
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

const camelCase = (field: string): string =>
  field.replaceAll(/_([a-z0-9])/gu, (_, letter: string) =>
    letter.toUpperCase(),
  );

/** The contract object admits this field's key being absent. */
const admitsOmission = (field: z.ZodType): boolean =>
  z.object({ value: field }).safeParse({}).success;

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

/**
 * Accept only field forms argv can carry, so a new contract field cannot
 * reach the CLI with an unreviewed spelling.
 */
const assertArgvField = (
  contract: string,
  field: string,
  schema: z.ZodType,
) => {
  const current = core(schema);
  const scalar =
    current instanceof z.ZodString ||
    current instanceof z.ZodNumber ||
    current instanceof z.ZodBoolean ||
    current instanceof z.ZodEnum;
  const element =
    current instanceof z.ZodArray ? core(current.element as z.ZodType) : null;
  if (
    !scalar &&
    !(element instanceof z.ZodString || element instanceof z.ZodEnum)
  )
    throw new Error(
      `${contract}.${field} has no argv projection; declare one before exposing it on the CLI`,
    );
};

/**
 * Argv cannot carry an explicit undefined, so an exact-optional field admits
 * the same values as an optional one. Renderers such as Incur's help read
 * boolean flags and enum choices only through `optional`.
 */
const argvOptional = (field: z.ZodType): z.ZodType => {
  if (!(field instanceof z.ZodExactOptional)) return field;
  const optional = (field.unwrap() as z.ZodType).optional();
  return field.description === undefined
    ? optional
    : optional.describe(field.description);
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

/** Derive the CLI parameters of one contract from its input schema and projection. */
export const describeContractCommand = <Contract extends ProjectedContract>(
  contract: Contract,
  projection: CliContractProjection<ContractField<Contract>>,
): ContractCliDescription => {
  const shape = contract.inputSchema.shape as Record<string, z.ZodType>;
  const positionals: readonly string[] = projection.positionals ?? [];
  const callerPaths: ReadonlySet<string> = new Set(
    projection.callerPaths ?? [],
  );
  const fieldProjections: Readonly<
    Record<string, CliFieldProjection | undefined>
  > = projection.fields ?? {};
  const omitted: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(projection.omit ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  for (const field of [
    ...positionals,
    ...callerPaths,
    ...Object.keys(fieldProjections),
    ...Object.keys(omitted),
  ])
    if (!Object.hasOwn(shape, field))
      throw new Error(`${contract.name} has no input field ${field}`);
  for (const field of Object.keys(omitted))
    if (!admitsOmission(shape[field]!))
      throw new Error(`${contract.name}.${field} is required on the CLI`);

  const parameter = (field: string): ContractCliParameter => {
    const declared = shape[field]!;
    const projected = fieldProjections[field];
    const callerPath = callerPaths.has(field);
    let schema: z.ZodType;
    if (callerPath) {
      schema = admitsOmission(declared)
        ? localPathStringSchema.optional()
        : localPathStringSchema;
      if (declared.description !== undefined)
        schema = schema.describe(declared.description);
    } else {
      assertArgvField(contract.name, field, declared);
      schema = cliDecimalShape({ field: argvOptional(declared) }).field;
    }
    if (projected?.description !== undefined)
      schema = schema.describe(projected.description);
    const description = schema.description;
    const value = core(declared);
    return {
      field,
      key: projected?.name ?? camelCase(field),
      positional: positionals.includes(field),
      alias: projected?.alias,
      description,
      schema,
      booleanFlag: value instanceof z.ZodBoolean,
      repeatable: value instanceof z.ZodArray,
      decimal: value instanceof z.ZodNumber,
      callerPath,
    };
  };
  const parameters = [
    ...positionals,
    ...Object.keys(shape).filter(
      (field) => !positionals.includes(field) && !Object.hasOwn(omitted, field),
    ),
  ].map(parameter);
  const keys = new Set(parameters.map(({ key }) => key));
  if (keys.size !== parameters.length)
    throw new Error(`${contract.name} projects two fields to one CLI key`);
  const keyOf = new Map(parameters.map(({ field, key }) => [field, key]));
  const rename = (field: string): string => keyOf.get(field) ?? field;

  const toContractInput = (
    values: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> => {
    const input: Record<string, unknown> = {};
    for (const { field, key, callerPath } of parameters) {
      const value = values[key];
      if (value === undefined) continue;
      input[field] =
        callerPath && typeof value === "string"
          ? absoluteCallerPath(value)
          : value;
    }
    return input;
  };

  // Cross-field rules belong to the contract: run its own object checks on
  // the options mapped to contract names, then name CLI keys. Positional
  // values are not visible here; the service's contract parse still
  // enforces every rule.
  const checks =
    projection.crossFieldRules === "argv"
      ? (contract.inputSchema._zod.def.checks ?? [])
      : [];
  const contractChecks = z
    .object({})
    .loose()
    .check(...(checks as z.core.$ZodCheck<Record<string, unknown>>[]));
  const checkOptions =
    checks.length === 0
      ? undefined
      : (options: Readonly<Record<string, unknown>>) => {
          const result = contractChecks.safeParse(toContractInput(options));
          return result.success
            ? []
            : result.error.issues.map((issue) => {
                const [field, ...rest] = issue.path;
                return {
                  path:
                    typeof field === "string"
                      ? [rename(field), ...rest]
                      : issue.path,
                  message: issue.message,
                  issue,
                };
              });
        };

  return {
    command: projection.command,
    description: projection.description,
    contract,
    parameters,
    omitted,
    optionConstraints: projectObjectConstraints(contract, rename),
    checkOptions,
    toContractInput,
    callerInputs: (values) =>
      Object.fromEntries(
        parameters.flatMap(({ field, key, callerPath }) => {
          const value = values[key];
          return callerPath && typeof value === "string"
            ? [[field, value]]
            : [];
        }),
      ),
  };
};
