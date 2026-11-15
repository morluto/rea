import type { JsonValue } from "../domain/jsonValue.js";
import type { Result } from "../domain/result.js";

interface CliInputFieldBinding {
  readonly operation: string;
  readonly fields: Readonly<Record<string, string>>;
  /** Each contract field, or `field.member`, the command takes as a flag. */
  readonly flags: Readonly<Record<string, string>>;
}

/** Flatten a finalized outcome only when returning the command's JSON output. */
export const projectCliAnalysisResult = <Value>(
  result: Result<Value, JsonValue>,
): Value | JsonValue => (result.ok ? result.value : result.error);

export const isObject = (
  value: JsonValue | undefined,
): value is Record<string, JsonValue> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Name a contract command's input fields by their CLI spelling in its
 * output: a direct failure, a delivered failure or a refused publication.
 * Issue paths owned by this operation take the CLI key, and a per-call
 * control a failure reports (`details.limit.parameter`, which services name
 * by contract field) gains `cli_flag`, the option that sets it on this
 * command. Any other output is returned unchanged.
 */
export const projectCliInputFields = <Output>(
  output: Output,
  binding: CliInputFieldBinding,
): Output => {
  const error = output as JsonValue;
  if (!isObject(error) || !isObject(error.details)) return output;
  const issues = renamedIssues(error, error.details, binding);
  const limit = flaggedLimit(error.details.limit, binding);
  if (issues === undefined && limit === undefined) return output;
  return {
    ...error,
    details: {
      ...error.details,
      ...(issues === undefined ? {} : { issues }),
      ...(limit === undefined ? {} : { limit }),
    },
  } as Output;
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
 * The reported per-call control with the flag that sets it, or undefined
 * when the command takes no flag for it. The longest bound prefix of the
 * parameter path names the flag: a flattened member option, else the option
 * of the whole field (such as `--producer-limits` JSON).
 */
const flaggedLimit = (
  limit: JsonValue | undefined,
  binding: CliInputFieldBinding,
): Record<string, JsonValue> | undefined => {
  if (
    !isObject(limit) ||
    limit.control_kind !== "parameter" ||
    typeof limit.parameter !== "string"
  )
    return undefined;
  const segments = limit.parameter.split(".");
  for (let length = segments.length; length > 0; length -= 1) {
    const flag = binding.flags[segments.slice(0, length).join(".")];
    if (flag !== undefined) return { ...limit, cli_flag: flag };
  }
  return undefined;
};
