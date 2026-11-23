import { z } from "zod";

import { cliCommandFor } from "../contracts/cliCommandNames.js";
import type { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { err, ok, type Result } from "../domain/result.js";
import { safeParseJson } from "../domain/safeJson.js";
import { schemaAnnotations } from "../domain/schemaAnnotations.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import type {
  CliEvidenceTargets,
  CliInputBranches,
  CliSessionTarget,
  CliTargetOpening,
  CliViewDelivery,
  ContractCliEvidenceTargets,
  ContractCliOpeningOption,
  ContractCliSessionTarget,
  DocumentContract,
  ProjectedContract,
} from "./contractCliDescriptionTypes.js";
import { optionFlagName } from "./optionFields.js";
import { cliDecimalField, cliDecimalShape, isNumericCore } from "./options.js";

/** The CLI key of a session target, which no contract field supplies. */
export const SESSION_TARGET_KEY = "path";

/** Help for `--view`, which names the delivery it needs. */
export const viewOptionHelp = (viewDelivery: CliViewDelivery): string =>
  viewDelivery.viewSelectsSummary === true
    ? "JSON page selection; selects summary delivery, which requires --evidence_output"
    : "JSON page selection; requires --detail summary and --evidence_output";

/**
 * The command a projection registers: the contract's own command, which the
 * contract declares with `cli: true` so the CLI inventory can be derived from
 * the registry, or the command a route names.
 */
export const projectedCommand = (
  contract: DocumentContract,
  command: string | undefined,
): string => {
  if (command !== undefined) return command;
  if (contract.cli !== true)
    throw new Error(`${contract.name} does not declare its CLI command`);
  return cliCommandFor(contract.name);
};

export const camelCase = (field: string): string =>
  field.replaceAll(/_([a-z0-9])/gu, (_, letter: string) =>
    letter.toUpperCase(),
  );

const admitsOmissionCache = new WeakMap<z.ZodType, boolean>();

/** The contract object admits this field's key being absent. */
export const admitsOmission = (field: z.ZodType): boolean => {
  const cached = admitsOmissionCache.get(field);
  if (cached !== undefined) return cached;
  const result = z.object({ value: field }).safeParse({}).success;
  admitsOmissionCache.set(field, result);
  return result;
};

const isWrapper = (value: z.ZodType) =>
  value instanceof z.ZodOptional ||
  value instanceof z.ZodExactOptional ||
  value instanceof z.ZodDefault ||
  value instanceof z.ZodPrefault ||
  value instanceof z.ZodNullable ||
  value instanceof z.ZodReadonly;

export const core = (value: z.ZodType): z.ZodType => {
  let current = value;
  while (isWrapper(current)) current = current.unwrap() as z.ZodType;
  return current;
};

/**
 * The description of a field, read through wrappers such as `.optional()`:
 * zod does not carry a wrapped schema's description to its wrapper, and the
 * advertised JSON Schema shows the wrapped description.
 */
export const describedThroughWrappers = (
  value: z.ZodType,
): string | undefined => {
  let current = value;
  while (current.description === undefined && isWrapper(current))
    current = current.unwrap() as z.ZodType;
  return current.description;
};

/**
 * JSON text for a structured contract field. Argv carries text; the decoded
 * value is admitted by the contract field itself, so `--schema` advertises
 * the contract's structure.
 */
export const jsonTextField = (declared: z.ZodType, flag: string): z.ZodType => {
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

export const assertArgvField = (
  contract: string,
  field: string,
  schema: z.ZodType,
) => {
  const current = core(schema);
  // A union of text forms, such as `auto` or a provider ID, is one token.
  const text = (member: z.ZodType): boolean =>
    member instanceof z.ZodString ||
    member instanceof z.ZodEnum ||
    (member instanceof z.ZodLiteral &&
      [...member.values].every((value) => typeof value === "string"));
  const scalar =
    current instanceof z.ZodString ||
    isNumericCore(current) ||
    current instanceof z.ZodBoolean ||
    current instanceof z.ZodEnum ||
    (current instanceof z.ZodUnion &&
      (current.options as readonly z.ZodType[]).every(text));
  const element =
    current instanceof z.ZodArray ? core(current.element as z.ZodType) : null;
  if (
    !scalar &&
    !(
      element instanceof z.ZodString ||
      element instanceof z.ZodEnum ||
      element instanceof z.ZodNumber
    )
  )
    throw new Error(
      `${contract}.${field} has no argv projection; declare one before exposing it on the CLI`,
    );
};

/**
 * The inbound view of a transformed contract field, such as an endpoint or
 * an origin list the contract normalizes: argv carries the text the
 * contract transforms when it admits the input, as tools/list advertises
 * it. Undefined when the field has no transform.
 */
export const inboundView = (field: z.ZodType): z.ZodType | undefined => {
  const inbound = (schema: z.ZodType): z.ZodType | undefined => {
    if (schema instanceof z.ZodPipe && schema.out instanceof z.ZodTransform)
      return inbound(schema.in as z.ZodType) ?? (schema.in as z.ZodType);
    if (schema instanceof z.ZodArray) {
      const element = inbound(schema.element as z.ZodType);
      return element === undefined
        ? undefined
        : (schema.clone({ ...schema.def, element }) as z.ZodType);
    }
    return undefined;
  };
  const view = inbound(core(field));
  if (view === undefined) return undefined;
  // The contract applies its own default when it admits the input.
  const optional = admitsOmission(field) ? view.optional() : view;
  const description = field.description ?? view.description;
  return description === undefined ? optional : optional.describe(description);
};

/**
 * The argv schema of a field: a number, or each element of an array of
 * numbers, takes decimal tokens only. An array keeps its own bounds.
 */
export const argvDecimal = (field: z.ZodType): z.ZodType => {
  const array = core(field);
  if (
    !(array instanceof z.ZodArray) ||
    !(core(array.element as z.ZodType) instanceof z.ZodNumber)
  )
    return cliDecimalShape({ field }).field;
  if (field instanceof z.ZodDefault)
    throw new Error("A defaulted number array has no argv projection");
  const decimal = new z.ZodArray({
    ...array._zod.def,
    element: cliDecimalField(array.element as z.ZodType),
  });
  const admitted = admitsOmission(field) ? decimal.optional() : decimal;
  return field.description === undefined
    ? admitted
    : admitted.describe(field.description);
};

/**
 * Argv cannot carry an explicit undefined, so an exact-optional field admits
 * the same values as an optional one. Renderers such as Incur's help read
 * boolean flags and enum choices only through `optional`.
 */
export const argvOptional = (field: z.ZodType): z.ZodType => {
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

export const projectObjectConstraints = (
  contract: ProjectedContract,
  rename: (field: string) => string,
  discriminatorFields: ReadonlySet<string>,
  cliOptionDependencies: Readonly<Record<string, readonly string[]>>,
  nullFlagLimits: readonly (readonly [flag: string, limit: string])[],
): Record<string, unknown> | undefined => {
  const metadata = contract.inputSchema.meta() ?? {};
  for (const keyword of Object.keys(metadata))
    if (
      !ROOT_ANNOTATIONS.has(keyword) &&
      !(OBJECT_CONSTRAINTS as readonly string[]).includes(keyword)
    )
      throw new Error(
        `${contract.name} input keyword ${keyword} has no CLI projection`,
      );
  // A root discriminator is checked with the delivery, left to the contract
  // when the projection omits the discriminator, or is the option that
  // selects the input branch.
  const { rootDiscriminator } = schemaAnnotations(contract.inputSchema) ?? {};
  if (
    rootDiscriminator !== undefined &&
    !discriminatorFields.has(rootDiscriminator)
  )
    throw new Error(
      `${contract.name} root discriminator ${rootDiscriminator} has no CLI projection`,
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
 * A boolean whose `true` and `false` literals each select one input branch,
 * such as whether to capture script sources, is one flag. Omission takes the
 * default of the branch that admits it; the contract selects the branch when
 * it admits the input.
 */
const branchSelectingFlag = (
  branches: readonly (z.ZodType | undefined)[],
): z.ZodType | undefined => {
  const values = branches.map((branch) => {
    const value = branch === undefined ? undefined : core(branch);
    return value instanceof z.ZodLiteral && value.values.size === 1
      ? [...value.values][0]
      : undefined;
  });
  if (
    values.some((value) => typeof value !== "boolean") ||
    new Set(values).size !== 2
  )
    return undefined;
  const omissions = branches.filter((branch) => admitsOmission(branch!));
  if (omissions.length > 1) return undefined;
  const flag = z.boolean();
  return omissions.length === 0
    ? flag
    : flag.default(omissions[0]!.parse(undefined) as boolean);
};

/** The text values a literal or enum field admits, or undefined for other fields. */
const textValues = (
  field: z.ZodType | undefined,
): readonly string[] | undefined => {
  const value = field === undefined ? undefined : core(field);
  const values =
    value instanceof z.ZodLiteral
      ? [...value.values]
      : value instanceof z.ZodEnum
        ? value.options
        : undefined;
  return values?.every((entry) => typeof entry === "string")
    ? values
    : undefined;
};

/**
 * A field every input branch declares as distinct text values, a literal in
 * one branch or an enum in another, such as `action` or `operation`: the
 * option names the branch it selects. Omission takes the default of the one
 * branch that admits it.
 */
const branchSelectingChoice = (
  branches: readonly (z.ZodType | undefined)[],
): z.ZodType | undefined => {
  const valueSets = branches.map(textValues);
  if (valueSets.some((values) => values === undefined)) return undefined;
  const values = valueSets.flatMap((values) => values!);
  const omissions = branches.filter((branch) => admitsOmission(branch!));
  if (new Set(values).size !== values.length || omissions.length > 1)
    return undefined;
  const choice = z.enum(values as [string, ...string[]]);
  const omitted = omissions[0]?.parse(undefined) as string | undefined;
  const chosen =
    omissions.length === 0
      ? choice
      : omitted === undefined
        ? choice.optional()
        : choice.default(omitted);
  const described = branches.find((branch) => branch!.description);
  return described === undefined
    ? chosen
    : chosen.describe(described.description!);
};

/**
 * A field only some input branches declare, with one schema there. The CLI
 * takes it as an optional option without a parse-time default, so another
 * branch never receives it; the selected branch's contract parse applies
 * its default, or refuses the field when that branch does not declare it.
 */
const branchOnlyField = (
  branches: readonly (z.ZodType | undefined)[],
): z.ZodType | undefined => {
  const declared = branches.filter(
    (branch): branch is z.ZodType => branch !== undefined,
  );
  const [first] = declared;
  if (
    first === undefined ||
    declared.length === branches.length ||
    declared.some((branch) => branch !== first)
  )
    return undefined;
  if (admitsOmission(first)) return withoutDefault(first);
  const optional = first.optional();
  return first.description === undefined
    ? optional
    : optional.describe(first.description);
};

/**
 * An option that must stay omitted when the caller omits it, because the
 * input branch or route the caller selects applies its own default on
 * admission. Help and `--schema` still state the default through the
 * schema metadata.
 */
export const withoutDefault = (schema: z.ZodType): z.ZodType => {
  if (!(schema instanceof z.ZodDefault)) return schema;
  const value: unknown = schema.parse(undefined);
  const omittable = (schema.removeDefault() as z.ZodType).optional();
  return omittable.meta({ ...schema.meta(), default: value });
};

/**
 * The union branches a projection takes, and the field it fixes when it
 * selects one value.
 */
export const selectInputBranches = (
  contract: ProjectedContract,
  selection: CliInputBranches | undefined,
): {
  readonly inputSchema: ProjectedContract["inputSchema"];
  readonly fixed: readonly [field: string, value: string] | undefined;
} => {
  const schema = contract.inputSchema;
  if (selection === undefined) return { inputSchema: schema, fixed: undefined };
  const { field, values } = selection;
  if (schema instanceof z.ZodObject)
    throw new Error(`${contract.name} has one input branch`);
  const covered = new Set<string>();
  const selected = schema.options.filter((branch) => {
    const admitted = textValues(
      (branch.shape as Record<string, z.ZodType>)[field],
    );
    if (admitted === undefined)
      throw new Error(`${contract.name}.${field} does not tell branches apart`);
    const chosen = admitted.filter((value) => values.includes(value));
    if (chosen.length > 0 && chosen.length !== admitted.length)
      throw new Error(`${contract.name}.${field} would narrow an input branch`);
    for (const value of chosen) covered.add(value);
    return chosen.length > 0;
  });
  if (covered.size !== new Set(values).size)
    throw new Error(`${contract.name}.${field} selects no branch for a value`);
  return {
    inputSchema: selected.length === 1 ? selected[0]! : z.union(selected),
    fixed: values.length === 1 ? [field, values[0]] : undefined,
  };
};

/**
 * Each input field's schema. Branches of a union input must share each field
 * the CLI takes as an argument; only delivery-owned fields, and omitted
 * fields the CLI never supplies, may differ, and they admit any branch's
 * value here. The delivery is then checked against the whole union.
 */
export const inputFields = (
  contract: ProjectedContract,
  unprojectedFields: ReadonlySet<string>,
): {
  readonly shape: Record<string, z.ZodType>;
  /** Fields whose value selects an input branch. */
  readonly selectors: ReadonlySet<string>;
} => {
  const schema = contract.inputSchema;
  if (schema instanceof z.ZodObject)
    return {
      shape: schema.shape as Record<string, z.ZodType>,
      selectors: new Set(),
    };
  const shapes = schema.options.map(
    (option) => option.shape as Record<string, z.ZodType>,
  );
  const names = new Set(shapes.flatMap((shape) => Object.keys(shape)));
  const selectors = new Set<string>();
  const shape = Object.fromEntries(
    [...names].map((field) => {
      const branches = shapes.map((shape) => shape[field]);
      const [first] = branches;
      if (branches.every((branch) => branch === first)) return [field, first!];
      const selector =
        branchSelectingFlag(branches) ?? branchSelectingChoice(branches);
      if (selector !== undefined) {
        selectors.add(field);
        return [field, selector];
      }
      const branchOnly = branchOnlyField(branches);
      if (branchOnly !== undefined) return [field, branchOnly];
      if (
        !unprojectedFields.has(field) ||
        branches.some((branch) => branch === undefined)
      )
        throw new Error(
          `${contract.name}.${field} differs between input branches and has no argv projection`,
        );
      return [field, z.union(branches as z.ZodType[])];
    }),
  );
  return { shape, selectors };
};

/**
 * Describe the options that supply fields of an opening or source contract,
 * and admit what the caller selected with a target as that contract's
 * `path`. Each option admits its field's own schema, narrowed to the
 * projected values.
 */
const describeTargetOpening = (
  opening: CliTargetOpening | undefined,
): {
  readonly options: readonly ContractCliOpeningOption[];
  readonly admit: (
    operation: string,
    values: Readonly<Record<string, unknown>>,
    target: string,
  ) => Result<Readonly<Record<string, unknown>>, AnalysisInputError>;
} => {
  const opener = opening?.contract.name ?? "";
  const shape = (opening?.contract.inputSchema.shape ?? {}) as Record<
    string,
    z.ZodType
  >;
  const options: readonly ContractCliOpeningOption[] = Object.entries(
    opening?.fields ?? {},
  ).map(([field, projected]) => {
    const declared = shape[field];
    if (declared === undefined || field === SESSION_TARGET_KEY)
      throw new Error(`${opener} has no option field ${field}`);
    if (!admitsOmission(declared))
      throw new Error(`${opener}.${field} is required`);
    let schema: z.ZodType;
    if (projected.callerPath === true) {
      if (!(core(declared) instanceof z.ZodString))
        throw new Error(`${opener}.${field} is not a path`);
      schema = localPathStringSchema.optional();
    } else if (projected.values === undefined) {
      assertArgvField(opener, field, declared);
      schema = argvDecimal(argvOptional(declared));
    } else {
      for (const value of projected.values)
        if (!declared.safeParse(value).success)
          throw new Error(`${opener}.${field} does not admit ${value}`);
      schema = z.enum(projected.values).optional();
    }
    const description =
      projected.description ?? describedThroughWrappers(declared);
    if (description !== undefined) schema = schema.describe(description);
    return {
      field,
      key: projected.name ?? camelCase(field),
      description,
      schema,
      callerPath: projected.callerPath === true,
    };
  });
  const keyOf = new Map(options.map(({ field, key }) => [field, key]));
  const callerPaths: ReadonlySet<string> = new Set(
    options.flatMap(({ field, callerPath }) => (callerPath ? [field] : [])),
  );
  return {
    options,
    admit: (operation, values, target) => {
      if (opening === undefined) return ok({});
      const selected = Object.fromEntries(
        options.flatMap(({ field, key }) =>
          values[key] === undefined ? [] : [[field, values[key]]],
        ),
      );
      // The target itself was admitted as its positional.
      if (Object.keys(selected).length === 0) return ok({});
      const candidate = {
        ...Object.fromEntries(
          Object.entries(selected).map(([field, value]) => [
            field,
            callerPaths.has(field)
              ? absoluteCallerPath(value as string)
              : value,
          ]),
        ),
        [SESSION_TARGET_KEY]: absoluteCallerPath(target),
      };
      const admitted = opening.contract.inputSchema.safeParse(candidate);
      if (!admitted.success)
        return err(
          analysisInputErrorFromIssues(
            operation,
            admitted.error.issues.map((issue) => {
              const [field, ...rest] = issue.path;
              const key =
                typeof field === "string" ? keyOf.get(field) : undefined;
              return key === undefined
                ? issue
                : { ...issue, path: [key, ...rest] };
            }),
            selected,
          ),
        );
      const data = admitted.data as Readonly<Record<string, unknown>>;
      return ok(
        Object.fromEntries(
          Object.keys(selected).map((field) => [
            field,
            callerPaths.has(field) ? selected[field] : data[field],
          ]),
        ),
      );
    },
  };
};

/** Describe the target positional and its opening options. */
export const describeSessionTarget = (
  target: CliSessionTarget | undefined,
): ContractCliSessionTarget | undefined => {
  if (target === undefined) return undefined;
  const { options, admit } = describeTargetOpening(target.open);
  return {
    key: SESSION_TARGET_KEY,
    schema: localPathStringSchema.describe(target.description),
    opening: target.open?.contract.name,
    options,
    admitOpening: (operation, values) =>
      admit(operation, values, values[SESSION_TARGET_KEY] as string),
  };
};

/**
 * Describe the Evidence target positionals of required contract fields and
 * the options of their shared source contract. Every target is admitted by
 * the source input, so a source option holds for each one.
 */
export const describeEvidenceTargets = (
  contract: ProjectedContract,
  shape: Readonly<Record<string, z.ZodType>>,
  targets: CliEvidenceTargets<string> | undefined,
): ContractCliEvidenceTargets | undefined => {
  if (targets === undefined) return undefined;
  const { options, admit } = describeTargetOpening(targets.source);
  const described = Object.entries(targets.fields).flatMap(
    ([field, projected]) => {
      if (projected === undefined) return [];
      const declared = shape[field];
      if (declared === undefined)
        throw new Error(`${contract.name} has no input field ${field}`);
      if (admitsOmission(declared))
        throw new Error(`${contract.name}.${field} is not a required field`);
      return [
        {
          field,
          key: projected.name ?? camelCase(field),
          schema: localPathStringSchema.describe(projected.description),
        },
      ];
    },
  );
  if (described.length === 0)
    throw new Error(`${contract.name} declares no Evidence target`);
  return {
    source: targets.source.contract.name,
    targets: described,
    options,
    sourceFlags: Object.fromEntries(
      options.map(({ field, key }) => [field, `--${optionFlagName(key)}`]),
    ),
    admitSource: (operation, values) => {
      let admitted: Result<
        Readonly<Record<string, unknown>>,
        AnalysisInputError
      > = ok({});
      for (const { key } of described) {
        admitted = admit(operation, values, values[key] as string);
        if (!admitted.ok) return admitted;
      }
      return admitted;
    },
  };
};
