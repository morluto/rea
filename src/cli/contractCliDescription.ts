import { z } from "zod";

import type { AnalysisInputError } from "../domain/analysisErrorCore.js";
import type { AnalysisViewRequest } from "../domain/analysisView/analysisViewRequest.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { err, ok, type Result } from "../domain/result.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import {
  analysisEvidenceDeliveryOptions,
  cliEvidenceDeliveryInputError,
} from "./analysisEvidenceDelivery.js";
import { parseCliJsonOption } from "./cliJsonOption.js";
import { safeParseJson } from "../domain/safeJson.js";
import { cliDecimalShape } from "./options.js";

/**
 * Framework-neutral CLI description of a tool contract. This module owns
 * which contract fields become positionals and options, their spellings,
 * help and argv admission, and the mapping back to contract input. A CLI
 * framework adapter (today `contractCommand.ts` for Incur) only renders it.
 */

/**
 * The parts of a tool contract that a CLI projection reads. A union input
 * shares every field except those the CLI delivery owns, such as a
 * `detail`-discriminated delivery.
 */
export interface ProjectedContract<Name extends string = string> {
  readonly name: Name;
  readonly inputSchema:
    | z.ZodObject
    | z.ZodDiscriminatedUnion<readonly z.ZodObject[]>;
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
  /**
   * Structured fields taken as one JSON text argument. The text is decoded
   * at argv parsing and then admitted by the contract field's own schema.
   */
  readonly jsonText?: readonly Field[];
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
  /**
   * The command delivers complete Evidence or a summary saved beside a
   * bundle: it adds `--detail` and `--evidence_output`. A contract `detail`
   * field selects that delivery and is not passed to the analysis.
   */
  readonly evidenceDelivery?: true;
  /**
   * With `evidenceDelivery`, the contract `view` field selects the delivered
   * page. `--view` takes JSON text that is decoded when the command runs, and
   * the delivery is then checked against the contract input before any
   * target is opened.
   */
  readonly viewDelivery?: CliViewDelivery;
}

/** How a contract command takes its `view` selection. */
export interface CliViewDelivery {
  /** The refusal when `--view` is not JSON. */
  readonly invalidJson: string;
  /** Added to the selection when the contract's view does not name its kind. */
  readonly kind?: AnalysisViewRequest["kind"];
  /**
   * `--detail` has no default: a view selects summary delivery, and complete
   * applies otherwise, as in the contract.
   */
  readonly viewSelectsSummary?: true;
}

/** A CLI option with no contract field, such as `--evidence_output`. */
export interface CliOnlyOption {
  readonly key: string;
  readonly description: string | undefined;
  readonly schema: z.ZodType;
}

/** The Evidence delivery a command invocation selected. */
export interface CliEvidenceDeliveryChoice {
  readonly detail: "complete" | "summary";
  readonly evidenceOutput: string | undefined;
  /** The admitted view, for a projection with `viewDelivery`. */
  readonly view?: AnalysisViewRequest;
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
  /** The value is JSON text decoded into the contract field. */
  readonly jsonText: boolean;
  /** Selects CLI Evidence delivery and is not analysis input. */
  readonly delivery: boolean;
  /**
   * A delivery view as JSON text, decoded when the command runs and admitted
   * with the delivery by the contract input.
   */
  readonly viewSelection: boolean;
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
  /**
   * Each contract input field's own schema. In a union input, a field the
   * delivery owns admits the value of any branch.
   */
  readonly fields: Readonly<Record<string, z.ZodType>>;
  readonly parameters: readonly ContractCliParameter[];
  /** Options after the contract parameters that no contract field owns. */
  readonly cliOnlyOptions: readonly CliOnlyOption[];
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
  /**
   * The selected delivery, for a projection with `evidenceDelivery`, refused
   * before any target is opened when it is not admitted.
   */
  readonly delivery:
    | ((
        values: Readonly<Record<string, unknown>>,
      ) => Result<CliEvidenceDeliveryChoice, AnalysisInputError>)
    | undefined;
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
const kebabCase = (key: string): string =>
  key.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);

/**
 * JSON text for a structured contract field. Argv carries text; the decoded
 * value is admitted by the contract field itself, so `--schema` advertises
 * the contract's structure.
 */
const jsonTextField = (declared: z.ZodType, flag: string): z.ZodType => {
  const value =
    declared instanceof z.ZodOptional || declared instanceof z.ZodExactOptional
      ? (declared.unwrap() as z.ZodType)
      : declared;
  const expected =
    core(value) instanceof z.ZodObject ? "a JSON object" : "valid JSON";
  const decoded = z
    .string()
    .transform((text, context) => {
      const parsed = safeParseJson(text);
      if (parsed.ok) return parsed.value;
      context.addIssue({
        code: "custom",
        message: `${flag} must be ${expected}`,
      });
      return z.NEVER;
    })
    .pipe(value);
  const admitted = admitsOmission(declared) ? decoded.optional() : decoded;
  return declared.description === undefined
    ? admitted
    : admitted.describe(declared.description);
};

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

/** The union keyword naming a root discriminator, checked with the delivery. */
const ROOT_DISCRIMINATOR = "x-rea-root-discriminator";

const projectObjectConstraints = (
  contract: ProjectedContract,
  rename: (field: string) => string,
  deliveryFields: ReadonlySet<string>,
): Record<string, unknown> | undefined => {
  const metadata = contract.inputSchema.meta();
  if (metadata === undefined) return undefined;
  for (const keyword of Object.keys(metadata))
    if (
      !ROOT_ANNOTATIONS.has(keyword) &&
      !(OBJECT_CONSTRAINTS as readonly string[]).includes(keyword) &&
      !(
        keyword === ROOT_DISCRIMINATOR &&
        deliveryFields.has(String(metadata[keyword]))
      )
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
 * Each input field's schema. Branches of a union input must share each field
 * the CLI takes as an argument; only delivery-owned fields may differ, and
 * they admit any branch's value here. The delivery is then checked against
 * the whole union.
 */
const inputFields = (
  contract: ProjectedContract,
  deliveryFields: ReadonlySet<string>,
): Record<string, z.ZodType> => {
  const schema = contract.inputSchema;
  if (schema instanceof z.ZodObject)
    return schema.shape as Record<string, z.ZodType>;
  const shapes = schema.options.map(
    (option) => option.shape as Record<string, z.ZodType>,
  );
  const names = new Set(shapes.flatMap((shape) => Object.keys(shape)));
  return Object.fromEntries(
    [...names].map((field) => {
      const branches = shapes.map((shape) => shape[field]);
      const [first] = branches;
      if (branches.every((branch) => branch === first)) return [field, first!];
      if (
        !deliveryFields.has(field) ||
        branches.some((branch) => branch === undefined)
      )
        throw new Error(
          `${contract.name}.${field} differs between input branches and has no argv projection`,
        );
      return [field, z.union(branches as z.ZodType[])];
    }),
  );
};

/** Derive the CLI parameters of one contract from its input schema and projection. */
export const describeContractCommand = <Contract extends ProjectedContract>(
  contract: Contract,
  projection: CliContractProjection<ContractField<Contract>>,
): ContractCliDescription => {
  const evidenceDelivery = projection.evidenceDelivery === true;
  const { viewDelivery } = projection;
  if (viewDelivery !== undefined && !evidenceDelivery)
    throw new Error(`${contract.name} view delivery requires evidenceDelivery`);
  const deliveryFields: ReadonlySet<string> = new Set(
    evidenceDelivery
      ? viewDelivery === undefined
        ? ["detail"]
        : ["detail", "view"]
      : [],
  );
  const shape = inputFields(contract, deliveryFields);
  if (viewDelivery !== undefined && !admitsOmission(shape.view ?? z.never()))
    throw new Error(`${contract.name} has no optional input field view`);
  const positionals: readonly string[] = projection.positionals ?? [];
  const callerPaths: ReadonlySet<string> = new Set(
    projection.callerPaths ?? [],
  );
  const fieldProjections: Readonly<
    Record<string, CliFieldProjection | undefined>
  > = projection.fields ?? {};
  const jsonTextFields: ReadonlySet<string> = new Set(
    projection.jsonText ?? [],
  );
  const omitted: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(projection.omit ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  for (const field of [
    ...positionals,
    ...callerPaths,
    ...jsonTextFields,
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
    const delivery = deliveryFields.has(field);
    const viewSelection = delivery && field === "view";
    const jsonText = jsonTextFields.has(field);
    const key = projected?.name ?? camelCase(field);
    let schema: z.ZodType;
    if (viewSelection) schema = z.string().optional();
    else if (delivery)
      schema =
        viewDelivery?.viewSelectsSummary === true
          ? analysisEvidenceDeliveryOptions.detail.unwrap().optional()
          : analysisEvidenceDeliveryOptions.detail;
    else if (jsonText) schema = jsonTextField(declared, kebabCase(key));
    else if (callerPath) {
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
      key,
      positional: positionals.includes(field),
      alias: projected?.alias,
      description,
      schema,
      booleanFlag: value instanceof z.ZodBoolean,
      repeatable: value instanceof z.ZodArray,
      decimal: value instanceof z.ZodNumber,
      callerPath,
      delivery,
      jsonText,
      viewSelection,
    };
  };
  const parameters = [
    ...positionals,
    ...Object.keys(shape).filter(
      (field) => !positionals.includes(field) && !Object.hasOwn(omitted, field),
    ),
  ].map(parameter);
  const cliOnlyOptions: readonly CliOnlyOption[] = Object.entries(
    evidenceDelivery
      ? Object.hasOwn(shape, "detail")
        ? { evidence_output: analysisEvidenceDeliveryOptions.evidence_output }
        : analysisEvidenceDeliveryOptions
      : {},
  ).map(([key, schema]: [string, z.ZodType]) => ({
    key,
    description: schema.description,
    schema,
  }));
  const keys = new Set([
    ...parameters.map(({ key }) => key),
    ...cliOnlyOptions.map(({ key }) => key),
  ]);
  if (keys.size !== parameters.length + cliOnlyOptions.length)
    throw new Error(`${contract.name} projects two fields to one CLI key`);
  const keyOf = new Map(parameters.map(({ field, key }) => [field, key]));
  const rename = (field: string): string => keyOf.get(field) ?? field;

  const toContractInput = (
    values: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> => {
    const input: Record<string, unknown> = {};
    for (const { field, key, callerPath, delivery } of parameters) {
      const value = values[key];
      if (value === undefined || delivery) continue;
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
    cliOnlyOptions,
    omitted,
    fields: shape,
    optionConstraints: projectObjectConstraints(
      contract,
      rename,
      deliveryFields,
    ),
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
    delivery: evidenceDelivery
      ? (values) => {
          const selected = selectDelivery(
            contract,
            viewDelivery,
            values,
            toContractInput,
            rename,
          );
          if (!selected.ok) return selected;
          const refused = cliEvidenceDeliveryInputError({
            ...selected.value,
            operation: contract.name,
          });
          return refused === undefined ? selected : err(refused);
        }
      : undefined,
  };
};

/**
 * The delivery the parsed values select. A view is decoded from its JSON
 * text and admitted with the delivery and the other inputs by the contract
 * input schema, so the contract's own delivery rules and messages apply.
 */
const selectDelivery = (
  contract: ProjectedContract,
  viewDelivery: CliViewDelivery | undefined,
  values: Readonly<Record<string, unknown>>,
  toContractInput: ContractCliDescription["toContractInput"],
  rename: (field: string) => string,
): Result<CliEvidenceDeliveryChoice, AnalysisInputError> => {
  const detail = values[rename("detail")] as "complete" | "summary" | undefined;
  const evidenceOutput = values.evidence_output as string | undefined;
  if (viewDelivery === undefined)
    return ok({ detail: detail ?? "complete", evidenceOutput });
  const viewKey = rename("view");
  const decoded = parseCliJsonOption(
    contract.name,
    viewKey,
    values[viewKey] as string | undefined,
    viewDelivery.invalidJson,
  );
  if (!decoded.ok) return decoded;
  const input = {
    ...toContractInput(values),
    ...(detail === undefined ? {} : { detail }),
    ...(decoded.value === undefined ? {} : { view: decoded.value }),
  };
  const admitted = contract.inputSchema.safeParse(input);
  if (!admitted.success)
    return err(
      analysisInputErrorFromIssues(contract.name, admitted.error.issues, input),
    );
  const { view } = admitted.data as { readonly view?: object };
  return ok({
    detail: detail ?? (view === undefined ? "complete" : "summary"),
    evidenceOutput,
    ...(view === undefined
      ? {}
      : {
          view: (viewDelivery.kind === undefined
            ? view
            : { kind: viewDelivery.kind, ...view }) as AnalysisViewRequest,
        }),
  });
};
