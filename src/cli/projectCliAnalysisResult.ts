import type { z } from "zod";

import { recordedControlSchemas } from "../domain/analysisSettingDefinitions.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Result } from "../domain/result.js";
import {
  cliCommandForOperation,
  type CliCommandEntry,
  type CliCommandOperation,
} from "./commandRegistry.js";

interface CliInputFieldBinding {
  readonly operation: string;
  readonly fields: Readonly<Record<string, string>>;
  /** Each contract field, or `field.member`, the command takes as a flag. */
  readonly flags: Readonly<Record<string, string>>;
  /**
   * Operations the selected command route runs, including its session-target
   * opener and Evidence-target source. When supplied, recovery flags fall back
   * across these operations when an error omits `details.operation` or names
   * its opener.
   */
  readonly operations?: readonly CliCommandOperation[] | undefined;
}

export interface CliCommandOutputProjectionContext {
  readonly operations: readonly CliCommandOperation[];
  readonly commands: readonly CliCommandEntry[];
  readonly cliName?: string | undefined;
  readonly recordedCommands?: Readonly<Record<string, string>> | undefined;
}

/** Flatten a finalized outcome only when returning the command's JSON output. */
export const projectCliAnalysisResult = <Value>(
  result: Result<Value, JsonValue>,
): Value | JsonValue => (result.ok ? result.value : result.error);

export const isObject = (
  value: JsonValue | undefined,
): value is Record<string, JsonValue> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const orderedOperations = (
  operations: readonly CliCommandOperation[],
  errorOperation: JsonValue | undefined,
): readonly CliCommandOperation[] => {
  if (typeof errorOperation !== "string" || operations.length <= 1)
    return operations;
  const matching = operations.filter(({ name }) => name === errorOperation);
  if (matching.length === 0) return operations;
  return [
    ...matching,
    ...operations.filter(({ name }) => name !== errorOperation),
  ];
};

/**
 * Name a contract command's input fields by their CLI spelling in its
 * output: a direct failure, a delivered failure or a refused publication.
 * Issue paths owned by this operation take the CLI key, and a per-call
 * control a failure reports (`details.limit.parameter`, which services name
 * by contract field) gains `cli_flag`, the option that sets it on this
 * command, and the fields its recovery names (`details.related_parameters`)
 * gain `related_cli_flags`, each field's option. Any other output is returned
 * unchanged.
 */
export const projectCliInputFields = <Output>(
  output: Output,
  binding: CliInputFieldBinding,
): Output => {
  const error = output as JsonValue;
  if (
    !isObject(error) ||
    typeof error.code !== "string" ||
    !isObject(error.details)
  )
    return output;
  const operations =
    binding.operations === undefined
      ? [{ name: binding.operation, flags: binding.flags }]
      : orderedOperations(binding.operations, error.details.operation);
  const issues = renamedIssues(error, error.details, binding);
  const limit = flaggedLimit(error.details.limit, operations);
  const relatedFlags =
    binding.operations === undefined &&
    error.details.operation !== binding.operation
      ? undefined
      : relatedCliFlagsFromOperations(error.details, operations);
  if (issues === undefined && limit === undefined && relatedFlags === undefined)
    return output;
  return {
    ...error,
    details: {
      ...error.details,
      ...(issues === undefined ? {} : { issues }),
      ...(limit === undefined ? {} : { limit }),
      ...(relatedFlags === undefined
        ? {}
        : { related_cli_flags: relatedFlags }),
    },
  } as Output;
};

/**
 * Render `cli_flag`, `related_cli_flags`, and `related_cli_commands` on any
 * CLI command's error output from its registered operations and the CLI's
 * command registry. Preserves existing route-specific bindings and untouched
 * references.
 */
export const projectCliCommandOutput = <Output>(
  output: Output,
  context: CliCommandOutputProjectionContext,
): Output => {
  const candidate = output as JsonValue;
  if (!isObject(candidate)) return output;
  if (typeof candidate.code === "string" && isObject(candidate.details))
    return projectErrorRecord(candidate, context) as Output;
  if (
    isObject(candidate.error) &&
    typeof candidate.error.code === "string" &&
    isObject(candidate.error.details)
  ) {
    const nested = projectErrorRecord(candidate.error, context);
    return nested === candidate.error
      ? output
      : ({ ...candidate, error: nested } as Output);
  }
  return output;
};

const projectErrorRecord = (
  error: Record<string, JsonValue>,
  context: CliCommandOutputProjectionContext,
): Record<string, JsonValue> => {
  const { details } = error;
  if (!isObject(details)) return error;
  const operations = orderedOperations(context.operations, details.operation);
  const limit =
    isObject(details.limit) && Object.hasOwn(details.limit, "cli_flag")
      ? undefined
      : flaggedLimit(details.limit, operations);
  const relatedFlags = Object.hasOwn(details, "related_cli_flags")
    ? undefined
    : relatedCliFlagsFromOperations(details, operations);
  const relatedCommands = Object.hasOwn(details, "related_cli_commands")
    ? undefined
    : relatedCliCommands(details, context);
  const secondaryFailures = projectedSecondaryFailures(
    details.secondary_failures,
    context,
  );
  if (
    limit === undefined &&
    relatedFlags === undefined &&
    relatedCommands === undefined &&
    secondaryFailures === undefined
  )
    return error;
  return {
    ...error,
    details: {
      ...details,
      ...(limit === undefined ? {} : { limit }),
      ...(relatedFlags === undefined
        ? {}
        : { related_cli_flags: relatedFlags }),
      ...(relatedCommands === undefined
        ? {}
        : { related_cli_commands: relatedCommands }),
      ...(secondaryFailures === undefined
        ? {}
        : { secondary_failures: secondaryFailures }),
    },
  };
};

const projectedSecondaryFailures = (
  secondary: JsonValue | undefined,
  context: CliCommandOutputProjectionContext,
): JsonValue[] | undefined => {
  if (!Array.isArray(secondary) || secondary.length === 0) return undefined;
  let changed = false;
  const mapped = secondary.map((item) => {
    if (!isObject(item) || typeof item.code !== "string") return item;
    const next = projectErrorRecord(item, context);
    if (next !== item) changed = true;
    return next;
  });
  return changed ? mapped : undefined;
};

/**
 * The option of each field a failure names for its recovery, keyed by contract
 * field, or undefined when the command takes none of them.
 */
const relatedCliFlagsFromOperations = (
  details: Record<string, JsonValue>,
  operations: readonly CliCommandOperation[],
): Record<string, JsonValue> | undefined => {
  if (!Array.isArray(details.related_parameters) || operations.length === 0)
    return undefined;
  const flags: Record<string, JsonValue> = {};
  for (const parameter of details.related_parameters) {
    if (typeof parameter !== "string") continue;
    const flag = cliFlagForOperations(parameter, operations);
    if (flag !== undefined) flags[parameter] = flag;
  }
  return Object.keys(flags).length === 0 ? undefined : flags;
};

const relatedCliCommands = (
  details: Record<string, JsonValue>,
  context: CliCommandOutputProjectionContext,
): Record<string, JsonValue> | undefined => {
  if (!Array.isArray(details.related_operations)) return undefined;
  const cliName = context.cliName ?? "rea";
  const commands: Record<string, JsonValue> = {};
  for (const operation of details.related_operations) {
    if (typeof operation !== "string") continue;
    const command = cliCommandForOperation(
      operation,
      context.commands,
      cliName,
      context.recordedCommands,
    );
    if (command !== undefined) commands[operation] = command;
  }
  return Object.keys(commands).length === 0 ? undefined : commands;
};

/** Issue paths renamed to CLI keys, or undefined when none changes. */
const renamedIssues = (
  error: Record<string, JsonValue>,
  details: Record<string, JsonValue>,
  binding: CliInputFieldBinding,
): JsonValue[] | undefined => {
  if (
    details.operation !== binding.operation ||
    !Array.isArray(details.issues) ||
    (error.code !== "invalid_request" &&
      !(
        error.code === "cleanup_incomplete" &&
        details.execution_failure === "invalid_request"
      ))
  )
    return undefined;
  let changed = false;
  const issues = details.issues.map((issue) => {
    if (!isObject(issue) || !Array.isArray(issue.path)) return issue;
    const field = issue.path[0];
    if (typeof field !== "string" || !Object.hasOwn(binding.fields, field))
      return issue;
    const alias = binding.fields[field];
    if (alias === undefined || alias === field) return issue;
    changed = true;
    return { ...issue, path: [alias, ...issue.path.slice(1)] };
  });
  // Keep retained output, partial Evidence and cleanup history by reference;
  // their source fields are not CLI parameter names.
  return changed ? issues : undefined;
};

/**
 * The request parameter a limit names, when a caller selects it per call: a
 * parameter control, or a registered setting a request argument can also
 * select.
 */
const limitParameter = (limit: JsonValue | undefined): string | undefined =>
  isObject(limit) &&
  typeof limit.parameter === "string" &&
  (limit.control_kind === "parameter" || typeof limit.setting === "string")
    ? limit.parameter
    : undefined;

/**
 * The option that sets a contract field or member on this command, or
 * undefined when it takes no flag for it. The longest bound prefix of the
 * parameter path names the flag: a flattened member option, else the option
 * of the whole field (such as `--producer-limits` JSON).
 */
const cliFlagForFlags = (
  parameter: string,
  flags: Readonly<Record<string, string>>,
): string | undefined => {
  const segments = parameter.split(".");
  for (let length = segments.length; length > 0; length -= 1) {
    const flag = flags[segments.slice(0, length).join(".")];
    if (flag !== undefined) return flag;
  }
  return undefined;
};

const cliFlagFor = (
  parameter: string,
  binding: Pick<CliInputFieldBinding, "flags">,
): string | undefined => cliFlagForFlags(parameter, binding.flags);

const cliFlagForOperations = (
  parameter: string,
  operations: readonly CliCommandOperation[],
): string | undefined => {
  for (const operation of operations) {
    const flag = cliFlagForFlags(parameter, operation.flags);
    if (flag !== undefined) return flag;
  }
  return undefined;
};

/** The reported per-call control with the flag that sets it. */
const flaggedLimit = (
  limit: JsonValue | undefined,
  operations: readonly CliCommandOperation[],
): Record<string, JsonValue> | undefined => {
  const parameter = limitParameter(limit);
  const flag =
    parameter === undefined
      ? undefined
      : cliFlagForOperations(parameter, operations);
  return flag === undefined || !isObject(limit)
    ? undefined
    : { ...limit, cli_flag: flag };
};

/** Wrappers whose value is their inner schema's value. */
const WRAPPER_TYPES = new Set([
  "optional",
  "nonoptional",
  "nullable",
  "default",
  "prefault",
  "readonly",
  "catch",
]);

type SchemaDef = Record<string, unknown> & { readonly type: string };

const schemaDef = (node: z.ZodType): SchemaDef =>
  node._zod.def as unknown as SchemaDef;

/** The schemas the walk enters below a node, for each type it enters. */
const enteredChildren = (def: SchemaDef): readonly z.ZodType[] => {
  if (WRAPPER_TYPES.has(def.type)) return [def.innerType as z.ZodType];
  if (def.type === "pipe") return [def.out as z.ZodType];
  if (def.type === "union") return def.options as z.ZodType[];
  if (def.type === "array") return [def.element as z.ZodType];
  if (def.type === "object")
    return Object.values(def.shape as Record<string, z.ZodType>);
  return [];
};

// Output schemas are fixed module-level values, so whether a node can reach
// a recorded control is computed once per node.
const controlReach = new WeakMap<z.ZodType, boolean>();

/**
 * Whether a control lies at or below `node`, and the shallowest node still
 * being visited that its subtree refers back to. A result that depends on an
 * unfinished ancestor of a recursive schema is not cached until that
 * ancestor finishes.
 */
const visitControlReach = (
  node: z.ZodType,
  visiting: Map<z.ZodType, number>,
): { readonly reaches: boolean; readonly lowest: number } => {
  const known = controlReach.get(node);
  if (known !== undefined) return { reaches: known, lowest: Infinity };
  const active = visiting.get(node);
  if (active !== undefined) return { reaches: false, lowest: active };
  if (recordedControlSchemas.has(node)) {
    controlReach.set(node, true);
    return { reaches: true, lowest: Infinity };
  }
  const depth = visiting.size;
  visiting.set(node, depth);
  let lowest = Infinity;
  let reaches = false;
  for (const child of enteredChildren(schemaDef(node))) {
    const visited = visitControlReach(child, visiting);
    lowest = Math.min(lowest, visited.lowest);
    if (visited.reaches) {
      reaches = true;
      break;
    }
  }
  visiting.delete(node);
  if (reaches || lowest >= depth) controlReach.set(node, reaches);
  return { reaches, lowest: reaches ? Infinity : lowest };
};

/** Whether a recorded control position lies at or below this schema node. */
const reachesRecordedControl = (node: z.ZodType): boolean =>
  visitControlReach(node, new Map()).reaches;

/**
 * Whether a value cannot satisfy an option, judged without parsing it: an
 * object option rejects a non-object, a missing required key, a key a strict
 * object does not declare, or a key whose literal values exclude the value's;
 * a union rejects what every option rejects. Anything else may satisfy it.
 */
const cannotSatisfy = (value: unknown, option: z.ZodType): boolean => {
  const def = schemaDef(option);
  if (def.type === "union")
    return (def.options as z.ZodType[]).every((nested) =>
      cannotSatisfy(value, nested),
    );
  if (def.type !== "object") return false;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return true;
  const record = value as Record<string, unknown>;
  const shape = def.shape as Record<string, z.ZodType>;
  const strict =
    (def.catchall as z.ZodType | undefined)?._zod.def.type === "never";
  const literals = Object.entries(option._zod.propValues ?? {});
  return (
    Object.entries(shape).some(
      ([key, field]) =>
        field._zod.optin === undefined && !Object.hasOwn(record, key),
    ) ||
    (strict && Object.keys(record).some((key) => !Object.hasOwn(shape, key))) ||
    literals.some(([key, values]) => !values.has(record[key] as never))
  );
};

/**
 * The option a union value was produced with, when it can hold a control:
 * the first option the value satisfies. Options the value's keys and literal
 * values rule out are not parsed; when one option remains, it is the only
 * shape the value can have and is followed without parsing it. Options after
 * the last one that can hold a control are never parsed.
 */
const producedUnionOption = (
  value: unknown,
  options: readonly z.ZodType[],
): z.ZodType | undefined => {
  const possible = options.filter((option) => !cannotSatisfy(value, option));
  if (possible.length === 1)
    return reachesRecordedControl(possible[0]!) ? possible[0] : undefined;
  const last = possible.findLastIndex(reachesRecordedControl);
  for (const option of possible.slice(0, last + 1))
    if (option.safeParse(value).success)
      return reachesRecordedControl(option) ? option : undefined;
  return undefined;
};

/**
 * The schema nodes of a value, following the result schema: each position
 * the schema declares a recorded control yields that value. Positions the
 * schema leaves open (records, unknown JSON, lazy or custom types) are not
 * entered, so captured content cannot supply a control, and subtrees whose
 * schema declares no control are skipped without reading them.
 */
const recordedControlValues = (
  output: unknown,
  schema: z.ZodType,
): unknown[] => {
  const found: unknown[] = [];
  const pending: [unknown, z.ZodType][] = [[output, schema]];
  while (pending.length > 0) {
    const [value, node] = pending.pop()!;
    if (value === undefined || !reachesRecordedControl(node)) continue;
    if (recordedControlSchemas.has(node)) {
      if (node.safeParse(value).success) found.push(value);
      continue;
    }
    const def = schemaDef(node);
    if (WRAPPER_TYPES.has(def.type)) {
      pending.push([value, def.innerType as z.ZodType]);
    } else if (def.type === "pipe") {
      pending.push([value, def.out as z.ZodType]);
    } else if (def.type === "union") {
      const option = producedUnionOption(value, def.options as z.ZodType[]);
      if (option !== undefined) pending.push([value, option]);
    } else if (def.type === "array" && Array.isArray(value)) {
      for (const item of value) pending.push([item, def.element as z.ZodType]);
    } else if (
      def.type === "object" &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const shape = def.shape as Record<string, z.ZodType>;
      const record = value as Record<string, unknown>;
      for (const [key, field] of Object.entries(shape))
        if (Object.hasOwn(record, key)) pending.push([record[key], field]);
    }
  }
  return found;
};

/**
 * A failure's partial observation, when it is Evidence of the command's own
 * operation. The command's output schema describes that Evidence, so its
 * declared control positions are read as a success result's are. A retained
 * reference, or Evidence of a source step or another operation, is not read.
 */
export const failurePartialObservation = (
  output: unknown,
  operation: string,
): Record<string, JsonValue> | undefined => {
  const failure = output as JsonValue;
  if (!isObject(failure) || !isObject(failure.details)) return undefined;
  const partial = failure.details.partial_observation;
  return isObject(partial) && partial.operation === operation
    ? partial
    : undefined;
};

/**
 * Each per-call control a result records by contract field (a `limit` in a
 * partial result's unknowns, coverage or retained Evidence), with the option
 * that sets it on this command. Only positions the command's output schema
 * declares as recorded controls count. The result is read, never changed:
 * the CLI renders these flags in its own envelope.
 */
export const cliResultControlsIn = (
  output: unknown,
  schema: z.ZodType,
  binding: CliInputFieldBinding,
): Record<string, string> => {
  const controls: Record<string, string> = {};
  for (const value of recordedControlValues(output, schema)) {
    const parameter = limitParameter(value as JsonValue);
    const flag =
      parameter === undefined ? undefined : cliFlagFor(parameter, binding);
    if (parameter !== undefined && flag !== undefined)
      controls[parameter] = flag;
  }
  return controls;
};
