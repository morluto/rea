import { z } from "zod";

import type { AnalysisInputError } from "../domain/analysisErrorCore.js";
import type { AnalysisViewRequest } from "../domain/analysisView/analysisViewRequest.js";
import type { CallerInputPaths } from "../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { err, ok, type Result } from "../domain/result.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import {
  analysisEvidenceDeliveryOptions,
  cliEvidenceDeliveryInputError,
} from "./analysisEvidenceDelivery.js";
import { parseCliJsonOption } from "./cliJsonOption.js";
import { getEvidenceInputContract } from "../domain/evidenceInputContract.js";
import { cliJsonCallerPathSchema } from "../cliJsonInput.js";
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

/** A contract whose whole input a CLI command takes as one JSON document. */
export interface DocumentContract<Name extends string = string> {
  readonly name: Name;
  readonly inputSchema: z.ZodType;
}

/** A contract input field name. */
export type ContractField<Contract extends DocumentContract> = keyof z.input<
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
export interface CliContractProjection<
  Field extends string,
  CliOptions extends CliOptionShape = CliOptionShape,
> {
  readonly command: string;
  readonly description: string;
  /** Fields taken as positional arguments, in argv order. */
  readonly positionals?: readonly Field[];
  /**
   * Absolute-path fields, or lists of them, the caller may spell relative to
   * the working directory. The CLI admits each nonempty, NUL-free,
   * well-formed path, then resolves it with `absoluteCallerPath` before the
   * contract sees it.
   */
  readonly callerPaths?: readonly Field[];
  /**
   * Structured fields taken as one JSON text argument. The text is decoded
   * at argv parsing and then admitted by the contract field's own schema.
   */
  readonly jsonText?: readonly Field[];
  /**
   * Structured fields taken as JSON text that is decoded when the command
   * runs, each with its refusal when the text is not JSON. The decoded input
   * is then admitted by the contract input before any target is opened.
   */
  readonly runtimeJson?: { readonly [Key in Field]?: string };
  /**
   * Nullable limits whose null ("all remaining") is spelled by a bare flag,
   * keyed by contract field. The limit option takes only a value; the flag
   * and the limit are mutually exclusive.
   */
  readonly nullFlags?: { readonly [Key in Field]?: CliNullFlag };
  /**
   * The operation analyzes the target an MCP session holds open, so the
   * target is not a contract field. The CLI takes it as the first positional,
   * `path`, and opens it before the operation runs on the contract input.
   */
  readonly sessionTarget?: CliSessionTarget;
  /**
   * Optional object fields taken as one option per member, keyed by contract
   * field and then member. Any member given supplies the whole object, so the
   * contract reports a missing companion member.
   */
  readonly flatten?: {
    readonly [Key in Field]?: Readonly<Record<string, CliFieldProjection>>;
  };
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
  /**
   * Options no contract field owns, keyed by their CLI key. Each is admitted
   * by its own schema and takes effect in the command handler, never in the
   * contract input; for example, an exit status chosen from the result.
   */
  readonly cliOptions?: CliOptions;
  /**
   * `dependentRequired` entries over CLI keys that the CLI-only options add
   * to the contract's own. Help and `--schema` advertise them; the handler
   * enforces them.
   */
  readonly cliOptionDependencies?: Readonly<
    Partial<Record<keyof CliOptions & string, readonly string[]>>
  >;
}

/** Schemas of the CLI-only options of one command, keyed by CLI key. */
export type CliOptionShape = Readonly<Record<string, z.ZodType>>;

/** Parsed values of the CLI-only options of one command. */
export type CliOptionValues<CliOptions extends CliOptionShape> = {
  readonly [Key in keyof CliOptions]: z.output<CliOptions[Key]>;
};

/** The target an operation runs on, which an MCP session holds open. */
export interface CliSessionTarget {
  /** Help for the target positional. */
  readonly description: string;
}

/** The CLI key of a session target, which no contract field supplies. */
const SESSION_TARGET_KEY = "path";

/** A bare flag that sets a nullable contract field to null. */
export interface CliNullFlag {
  readonly key: string;
  readonly description: string;
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
  /**
   * The refusal for text that is not JSON, when the value is JSON text
   * decoded when the command runs; undefined otherwise.
   */
  readonly runtimeJson: string | undefined;
  /** The bare flag that sets this nullable field to null, if any. */
  readonly nullFlag: string | undefined;
  /** The member of the object field this option supplies, if flattened. */
  readonly member: string | undefined;
}

/** The contract input and delivery one invocation selected. */
export interface ContractCliAdmission {
  readonly input: Record<string, unknown>;
  /** The admitted delivery, for a projection with `evidenceDelivery`. */
  readonly delivery: CliEvidenceDeliveryChoice | undefined;
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
  /**
   * Map parsed values, keyed by parameter key, to the contract input. Values
   * of run-time JSON parameters must already be decoded.
   */
  readonly toContractInput: (
    values: Readonly<Record<string, unknown>>,
  ) => Record<string, unknown>;
  /** Each caller-path field as the caller spelled it, before resolution. */
  readonly callerInputs: (
    values: Readonly<Record<string, unknown>>,
  ) => CallerInputPaths;
  /** The parsed values of the projection's CLI-only options. */
  readonly cliOptionValues: (
    values: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>>;
  /**
   * The session target positional, taken before the contract positionals,
   * when the operation runs on a target the CLI opens; undefined otherwise.
   */
  readonly sessionTarget:
    | { readonly key: string; readonly schema: z.ZodType }
    | undefined;
  /**
   * Contract fields the CLI spells differently, so input issues reported
   * after argv parsing can name the CLI key.
   */
  readonly inputBinding: {
    readonly operation: string;
    readonly fields: Readonly<Record<string, string>>;
  };
  /** The command adds `--detail` and `--evidence_output`. */
  readonly evidenceDelivery: boolean;
  /**
   * Decode run-time JSON, then map parsed values to the contract input and
   * the selected delivery. An input or delivery that is not admitted is
   * refused before any target is opened.
   */
  readonly admit: (
    values: Readonly<Record<string, unknown>>,
  ) => Result<ContractCliAdmission, AnalysisInputError>;
}

/** One contract from a contract group, keeping its exact schema types. */
export const contractNamed = <
  Contracts extends readonly { readonly name: string }[],
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
  cliOptionDependencies: Readonly<Record<string, readonly string[]>>,
  nullFlagLimits: readonly (readonly [flag: string, limit: string])[],
): Record<string, unknown> | undefined => {
  const metadata = contract.inputSchema.meta() ?? {};
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
  if (Object.keys(cliOptionDependencies).length > 0)
    projected.dependentRequired = {
      ...(projected.dependentRequired as object | undefined),
      ...cliOptionDependencies,
    };
  if (nullFlagLimits.length > 1)
    throw new Error(`${contract.name} has more than one null flag`);
  for (const [flag, limit] of nullFlagLimits)
    projected.not = {
      required: [flag, limit],
      properties: { [flag]: { const: true } },
    };
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

/**
 * The CLI spelling of a contract whose whole input is one JSON document:
 * inline JSON, a JSON file path, or `-` for standard input.
 */
export interface CliDocumentProjection<
  Field extends string,
  CliOptions extends CliOptionShape = CliOptionShape,
> {
  readonly command: string;
  readonly description: string;
  /** Help for the document argument. */
  readonly document: string;
  /**
   * Property paths of caller paths inside the document. Each nonblank string
   * there that is not a URL is resolved against the working directory.
   */
  readonly callerPaths?: readonly (readonly string[])[];
  /**
   * Optional top-level fields this one-shot command does not admit, each with
   * the reason; `--schema` leaves them out of the document.
   */
  readonly omit?: { readonly [Key in Field]?: string };
  /** Options no contract field owns, keyed by their CLI key. */
  readonly cliOptions?: CliOptions;
}

/** A complete, framework-neutral CLI command whose input is one JSON document. */
export interface ContractCliDocumentDescription {
  readonly command: string;
  readonly description: string;
  readonly contract: DocumentContract;
  /** The argument key, which no option shares. */
  readonly key: string;
  /** Help for the document argument. */
  readonly documentDescription: string;
  /**
   * What the document admits as `--schema` advertises it: the contract input
   * without omitted fields, with each Evidence carrier left to its owner.
   */
  readonly content: z.ZodType;
  /** Property paths of caller paths inside the document. */
  readonly callerPaths: readonly (readonly string[])[];
  /** Contract fields the command does not admit, with the reason. */
  readonly omitted: Readonly<Record<string, string>>;
  readonly cliOnlyOptions: readonly CliOnlyOption[];
  /** The parsed values of the projection's CLI-only options. */
  readonly cliOptionValues: (
    values: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>>;
}

/**
 * The document field at `path` as the CLI admits it: a caller path the
 * command resolves against the working directory, so a relative spelling is
 * admitted where the contract requires an absolute one. Unions and wrappers
 * keep their other branches; clones keep the source's registry metadata.
 */
const admitDocumentCallerPath = (
  schema: z.ZodType,
  path: readonly string[],
): z.ZodType => {
  const [head, ...tail] = path;
  if (head === undefined) {
    const admitted =
      core(schema) instanceof z.ZodArray
        ? z.array(cliJsonCallerPathSchema)
        : cliJsonCallerPathSchema;
    const field = admitsOmission(schema) ? admitted.optional() : admitted;
    return schema.description === undefined
      ? field
      : field.describe(schema.description);
  }
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodExactOptional ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodReadonly
  )
    return z.clone(
      schema,
      {
        ...schema.def,
        innerType: admitDocumentCallerPath(schema.unwrap() as z.ZodType, path),
      },
      { parent: true },
    );
  if (schema instanceof z.ZodUnion)
    return z.clone(
      schema,
      {
        ...schema.def,
        options: schema.options.map((option) =>
          admitDocumentCallerPath(option as z.ZodType, path),
        ),
      },
      { parent: true },
    );
  if (schema instanceof z.ZodObject && Object.hasOwn(schema.shape, head))
    return z.clone(
      schema,
      {
        ...schema.def,
        shape: {
          ...schema.shape,
          [head]: admitDocumentCallerPath(
            schema.shape[head] as z.ZodType,
            tail,
          ),
        },
      },
      { parent: true },
    );
  return schema;
};

/** The CLI key of a JSON input document. */
const DOCUMENT_KEY = "inputJson";

/**
 * Describe a contract command that takes its whole input as one JSON
 * document. The handler admits the decoded document with the contract's
 * owner, which borrows Evidence carriers rather than parsing them here.
 */
export const describeContractDocumentCommand = <
  Contract extends DocumentContract,
  CliOptions extends CliOptionShape = CliOptionShape,
>(
  contract: Contract,
  projection: CliDocumentProjection<ContractField<Contract>, CliOptions>,
): ContractCliDocumentDescription => {
  const omitted: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(projection.omit ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  let admitted: z.ZodType = contract.inputSchema;
  if (Object.keys(omitted).length > 0) {
    const schema = contract.inputSchema;
    if (!(schema instanceof z.ZodObject))
      throw new Error(`${contract.name} omits fields from a union input`);
    const shape = schema.shape as Record<string, z.ZodType>;
    for (const field of Object.keys(omitted))
      if (!Object.hasOwn(shape, field) || !admitsOmission(shape[field]!))
        throw new Error(`${contract.name}.${field} is not an optional field`);
    admitted = schema.omit(
      Object.fromEntries(
        Object.keys(omitted).map((field) => [field, true]),
      ) as never,
    );
  }
  const callerPaths = projection.callerPaths ?? [];
  for (const path of callerPaths)
    admitted = admitDocumentCallerPath(admitted, path);
  const cliOptions: CliOptionShape = projection.cliOptions ?? {};
  if (Object.hasOwn(cliOptions, DOCUMENT_KEY))
    throw new Error(`${contract.name} projects two fields to one CLI key`);
  return {
    command: projection.command,
    description: projection.description,
    contract,
    key: DOCUMENT_KEY,
    documentDescription: projection.document,
    content: getEvidenceInputContract(admitted).frameSchema,
    callerPaths,
    omitted,
    cliOnlyOptions: Object.entries(cliOptions).map(([key, schema]) => ({
      key,
      description: schema.description,
      schema,
    })),
    cliOptionValues: (values) =>
      Object.fromEntries(
        Object.keys(cliOptions).flatMap((key) =>
          values[key] === undefined ? [] : [[key, values[key]]],
        ),
      ),
  };
};

/** Derive the CLI parameters of one contract from its input schema and projection. */
export const describeContractCommand = <
  Contract extends ProjectedContract,
  CliOptions extends CliOptionShape = CliOptionShape,
>(
  contract: Contract,
  projection: CliContractProjection<ContractField<Contract>, CliOptions>,
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
  const runtimeJsonFields: Readonly<Record<string, string | undefined>> =
    projection.runtimeJson ?? {};
  const nullFlags: Readonly<Record<string, CliNullFlag | undefined>> =
    projection.nullFlags ?? {};
  const omitted: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(projection.omit ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  for (const field of [
    ...positionals,
    ...callerPaths,
    ...jsonTextFields,
    ...Object.keys(runtimeJsonFields),
    ...Object.keys(nullFlags),
    ...Object.keys(projection.flatten ?? {}),
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
    const runtimeJson = viewSelection
      ? viewDelivery?.invalidJson
      : runtimeJsonFields[field];
    const nullFlag = nullFlags[field]?.key;
    const key = projected?.name ?? camelCase(field);
    let schema: z.ZodType;
    if (runtimeJson !== undefined) {
      if (!admitsOmission(declared))
        throw new Error(`${contract.name}.${field} is required on the CLI`);
      schema = z.string().optional();
      if (declared.description !== undefined && !viewSelection)
        schema = schema.describe(declared.description);
    } else if (nullFlag !== undefined) {
      // The flag spells null, so the option itself takes only a value.
      if (!declared.safeParse(null).success)
        throw new Error(`${contract.name}.${field} does not admit null`);
      assertArgvField(contract.name, field, declared);
      schema = cliDecimalShape({ field: core(declared).optional() }).field;
      if (declared.description !== undefined)
        schema = schema.describe(declared.description);
    } else if (delivery)
      schema =
        viewDelivery?.viewSelectsSummary === true
          ? analysisEvidenceDeliveryOptions.detail.unwrap().optional()
          : analysisEvidenceDeliveryOptions.detail;
    else if (jsonText) schema = jsonTextField(declared, kebabCase(key));
    else if (callerPath) {
      const admitted =
        core(declared) instanceof z.ZodArray
          ? z.array(localPathStringSchema)
          : localPathStringSchema;
      schema = admitsOmission(declared) ? admitted.optional() : admitted;
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
      runtimeJson,
      nullFlag,
      member: undefined,
    };
  };
  const flattened: Readonly<
    Record<string, Readonly<Record<string, CliFieldProjection>> | undefined>
  > = projection.flatten ?? {};
  const memberParameters = (field: string): ContractCliParameter[] => {
    const declared = shape[field]!;
    const object = core(declared);
    const members = flattened[field]!;
    if (!(object instanceof z.ZodObject) || !admitsOmission(declared))
      throw new Error(`${contract.name}.${field} is not an optional object`);
    const memberShape = object.shape as Record<string, z.ZodType>;
    if (
      Object.keys(members).toSorted().join() !==
      Object.keys(memberShape).toSorted().join()
    )
      throw new Error(`${contract.name}.${field} flattens other members`);
    return Object.entries(memberShape).map(([member, memberDeclared]) => {
      const projected = members[member]!;
      assertArgvField(contract.name, `${field}.${member}`, memberDeclared);
      let schema = cliDecimalShape({ field: memberDeclared.optional() }).field;
      const description = projected.description ?? memberDeclared.description;
      if (description !== undefined) schema = schema.describe(description);
      const value = core(memberDeclared);
      return {
        field,
        key: projected.name ?? camelCase(member),
        positional: false,
        alias: projected.alias,
        description,
        schema,
        booleanFlag: value instanceof z.ZodBoolean,
        repeatable: value instanceof z.ZodArray,
        decimal: value instanceof z.ZodNumber,
        callerPath: false,
        delivery: false,
        jsonText: false,
        viewSelection: false,
        runtimeJson: undefined,
        nullFlag: undefined,
        member,
      };
    });
  };
  const parameters = [
    ...positionals,
    ...Object.keys(shape).filter(
      (field) => !positionals.includes(field) && !Object.hasOwn(omitted, field),
    ),
  ].flatMap((field) =>
    flattened[field] === undefined
      ? [parameter(field)]
      : memberParameters(field),
  );
  const cliOptions: CliOptionShape = projection.cliOptions ?? {};
  const cliOnlyOptions: readonly CliOnlyOption[] = [
    ...Object.values(nullFlags).flatMap((flag) =>
      flag === undefined
        ? []
        : [
            [
              flag.key,
              z.boolean().default(false).describe(flag.description),
            ] satisfies [string, z.ZodType],
          ],
    ),
    ...Object.entries(
      evidenceDelivery
        ? Object.hasOwn(shape, "detail")
          ? { evidence_output: analysisEvidenceDeliveryOptions.evidence_output }
          : analysisEvidenceDeliveryOptions
        : {},
    ),
    ...Object.entries(cliOptions),
  ].map(([key, schema]: [string, z.ZodType]) => ({
    key,
    description: schema.description,
    schema,
  }));
  const sessionTargetKeys =
    projection.sessionTarget === undefined ? [] : [SESSION_TARGET_KEY];
  const keys = new Set([
    ...sessionTargetKeys,
    ...parameters.map(({ key }) => key),
    ...cliOnlyOptions.map(({ key }) => key),
  ]);
  if (
    keys.size !==
    sessionTargetKeys.length + parameters.length + cliOnlyOptions.length
  )
    throw new Error(`${contract.name} projects two fields to one CLI key`);
  const cliOptionDependencies = Object.fromEntries(
    Object.entries(projection.cliOptionDependencies ?? {}).filter(
      (entry): entry is [string, readonly string[]] => entry[1] !== undefined,
    ),
  );
  for (const [key, required] of Object.entries(cliOptionDependencies))
    for (const dependency of [key, ...required])
      if (!keys.has(dependency))
        throw new Error(`${contract.name} has no CLI option ${dependency}`);
  const keyOf = new Map(
    parameters.flatMap(({ field, key, member }) =>
      member === undefined ? [[field, key] as const] : [],
    ),
  );
  const rename = (field: string): string => keyOf.get(field) ?? field;

  const toContractInput = (
    values: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> => {
    const input: Record<string, unknown> = {};
    for (const { field, key, callerPath, delivery, member } of parameters) {
      const value = values[key];
      if (value === undefined || delivery || member !== undefined) continue;
      input[field] = !callerPath
        ? value
        : Array.isArray(value)
          ? value.map((path: string) => absoluteCallerPath(path))
          : absoluteCallerPath(value as string);
    }
    // Any member given supplies the whole object, absent members included,
    // so the contract names the missing companion.
    for (const field of Object.keys(flattened)) {
      const members = parameters.filter(
        (candidate) => candidate.field === field,
      );
      if (members.some(({ key }) => values[key] !== undefined))
        input[field] = Object.fromEntries(
          members.map(({ member, key }) => [member, values[key]]),
        );
    }
    for (const { field, nullFlag } of parameters)
      if (nullFlag !== undefined && values[nullFlag] === true)
        input[field] = null;
    return input;
  };
  const nullFlagLimits = parameters.flatMap(({ key, nullFlag }) =>
    nullFlag === undefined ? [] : [[nullFlag, key] as const],
  );

  // Cross-field rules belong to the contract: run its own object checks on
  // the options mapped to contract names, then name CLI keys. Positional
  // values are not visible here; the service's contract parse still
  // enforces every rule.
  const checks =
    projection.crossFieldRules === "argv"
      ? (contract.inputSchema._zod.def.checks ?? [])
      : [];
  if (
    checks.length > 0 &&
    parameters.some(({ runtimeJson }) => runtimeJson !== undefined)
  )
    throw new Error(
      `${contract.name} decodes JSON when it runs, after argv cross-field rules`,
    );
  const contractChecks = z
    .object({})
    .loose()
    .check(...(checks as z.core.$ZodCheck<Record<string, unknown>>[]));
  const checkOptions =
    checks.length === 0 && nullFlagLimits.length === 0
      ? undefined
      : (options: Readonly<Record<string, unknown>>) => {
          const conflicts = nullFlagLimits.flatMap(([flag, limit]) => {
            if (options[flag] !== true || options[limit] === undefined)
              return [];
            const message = `${flag} and ${limit} are mutually exclusive`;
            const issue: z.core.$ZodIssueCustom = {
              code: "custom",
              path: [flag],
              message,
              input: undefined,
            };
            return [{ path: [flag], message, issue }];
          });
          const result = contractChecks.safeParse(toContractInput(options));
          return result.success
            ? conflicts
            : [
                ...conflicts,
                ...result.error.issues.map((issue) => {
                  const [field, ...rest] = issue.path;
                  return {
                    path:
                      typeof field === "string"
                        ? [rename(field), ...rest]
                        : issue.path,
                    message: issue.message,
                    issue,
                  };
                }),
              ];
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
      cliOptionDependencies,
      nullFlagLimits,
    ),
    checkOptions,
    toContractInput,
    callerInputs: (values) =>
      Object.fromEntries(
        parameters.flatMap(({ field, key, callerPath }) => {
          const value = values[key];
          return callerPath && value !== undefined
            ? [[field, value as string | readonly string[]]]
            : [];
        }),
      ),
    cliOptionValues: (values) =>
      Object.fromEntries(
        Object.keys(cliOptions).flatMap((key) =>
          values[key] === undefined ? [] : [[key, values[key]]],
        ),
      ),
    sessionTarget:
      projection.sessionTarget === undefined
        ? undefined
        : {
            key: SESSION_TARGET_KEY,
            schema: localPathStringSchema.describe(
              projection.sessionTarget.description,
            ),
          },
    inputBinding: {
      operation: contract.name,
      fields: Object.fromEntries(
        parameters.flatMap(({ field, key, member }) =>
          member === undefined && key !== field ? [[field, key]] : [],
        ),
      ),
    },
    evidenceDelivery,
    admit: (values) =>
      admitInvocation(
        contract,
        { evidenceDelivery, viewDelivery, parameters, shape },
        values,
        toContractInput,
        rename,
      ),
  };
};

/**
 * Decode run-time JSON, then map the values to the contract input and the
 * selected delivery. When the projection decodes JSON at run time, the
 * decoded input, delivery and view are admitted together by the contract
 * input schema, so the contract's own rules and messages apply.
 */
const admitInvocation = (
  contract: ProjectedContract,
  command: {
    readonly evidenceDelivery: boolean;
    readonly viewDelivery: CliViewDelivery | undefined;
    readonly parameters: readonly ContractCliParameter[];
    readonly shape: Readonly<Record<string, z.ZodType>>;
  },
  values: Readonly<Record<string, unknown>>,
  toContractInput: ContractCliDescription["toContractInput"],
  rename: (field: string) => string,
): Result<ContractCliAdmission, AnalysisInputError> => {
  const { evidenceDelivery, viewDelivery, parameters, shape } = command;
  const decoded: Record<string, unknown> = { ...values };
  for (const { key, runtimeJson } of parameters) {
    if (runtimeJson === undefined) continue;
    const parsed = parseCliJsonOption(
      contract.name,
      key,
      values[key] as string | undefined,
      runtimeJson,
    );
    if (!parsed.ok) return parsed;
    decoded[key] = parsed.value;
  }
  const input = toContractInput(decoded);
  const detail = evidenceDelivery
    ? (decoded[rename("detail")] as "complete" | "summary" | undefined)
    : undefined;
  let view: object | undefined;
  if (parameters.some(({ runtimeJson }) => runtimeJson !== undefined)) {
    const selected =
      viewDelivery === undefined ? undefined : decoded[rename("view")];
    const candidate = {
      ...input,
      ...(detail === undefined || !Object.hasOwn(shape, "detail")
        ? {}
        : { detail }),
      ...(selected === undefined ? {} : { view: selected }),
    };
    const admitted = contract.inputSchema.safeParse(candidate);
    if (!admitted.success)
      return err(
        analysisInputErrorFromIssues(
          contract.name,
          admitted.error.issues,
          candidate,
        ),
      );
    if (viewDelivery !== undefined)
      ({ view } = admitted.data as { readonly view?: object });
  }
  if (!evidenceDelivery) return ok({ input, delivery: undefined });
  const delivery: CliEvidenceDeliveryChoice = {
    detail: detail ?? (view === undefined ? "complete" : "summary"),
    evidenceOutput: decoded.evidence_output as string | undefined,
    ...(view === undefined
      ? {}
      : {
          view: (viewDelivery?.kind === undefined
            ? view
            : { kind: viewDelivery.kind, ...view }) as AnalysisViewRequest,
        }),
  };
  const refused = cliEvidenceDeliveryInputError({
    ...delivery,
    operation: contract.name,
  });
  return refused === undefined ? ok({ input, delivery }) : err(refused);
};
