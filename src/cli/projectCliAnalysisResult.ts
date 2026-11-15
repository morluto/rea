import type { JsonValue } from "../domain/jsonValue.js";
import type { Result } from "../domain/result.js";

interface CliInputFieldBinding {
  readonly operation: string;
  readonly fields: Readonly<Record<string, string>>;
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
 * Rename only the actionable parameter paths owned by this operation binding
 * in a contract command's output: a direct failure, a delivered failure or a
 * refused publication. Any other output is returned unchanged.
 */
export const projectCliInputFields = <Output>(
  output: Output,
  binding: CliInputFieldBinding,
): Output => {
  const error = output as JsonValue;
  if (!isObject(error)) return output;
  const details = error.details;
  if (
    !isObject(details) ||
    details.operation !== binding.operation ||
    !Array.isArray(details.issues) ||
    (error.code !== "invalid_request" &&
      !(
        error.code === "cleanup_incomplete" &&
        details.execution_failure === "invalid_request"
      ))
  )
    return output;

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
  return changed
    ? ({ ...error, details: { ...details, issues } } as Output)
    : output;
};
