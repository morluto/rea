import type { AnalysisInputIssue } from "./analysisErrorCore.js";

/** Deterministic correction metadata for a known neighboring-tool argument name mistake. */
export interface ArgumentMistakeGuidance {
  readonly expected: string;
  readonly message: string;
  readonly remediation: string;
}

const PROCEDURE_OPERATIONS: ReadonlySet<string> = new Set([
  "analyze_function",
  "annotate_native_function",
  "inspect_native_api",
  "procedure_address",
  "procedure_assembly",
  "procedure_callees",
  "procedure_callers",
  "procedure_info",
  "procedure_pseudo_code",
  "procedure_references",
  "read_function_instructions",
  "trace_native_values",
]);

const ADDRESS_OPERATIONS: ReadonlySet<string> = new Set([
  "address_name",
  "address_to_file_offset",
  "comment",
  "get_call_graph",
  "goto_address",
  "inline_comment",
  "inspect_address_context",
  "inspect_native_instruction",
  "next_address",
  "prev_address",
  "read_bytes",
  "resolve_containing_procedure",
  "resolve_native_call_targets",
  "set_address_name",
  "set_bookmark",
  "set_comment",
  "set_inline_comment",
  "unset_bookmark",
  "xrefs",
]);

const PATTERN_OPERATIONS: ReadonlySet<string> = new Set([
  "analyze_swift_types",
  "get_objc_classes",
  "search_bytes",
  "search_procedures",
  "search_strings",
]);

const QUERY_OPERATIONS: ReadonlySet<string> = new Set([
  "search_guidance",
  "trace_feature",
]);

const PROCEDURE_INSTEAD_OF_ADDRESS: ArgumentMistakeGuidance = {
  expected: "procedure",
  message: "Unrecognized argument 'address'; did you mean 'procedure'?",
  remediation:
    "Use 'procedure' (a procedure name or address) instead of 'address'.",
};

const ADDRESS_INSTEAD_OF_PROCEDURE: ArgumentMistakeGuidance = {
  expected: "address",
  message: "Unrecognized argument 'procedure'; did you mean 'address'?",
  remediation: "Use 'address' instead of 'procedure'.",
};

const PATTERN_INSTEAD_OF_QUERY: ArgumentMistakeGuidance = {
  expected: "pattern",
  message: "Unrecognized argument 'query'; did you mean 'pattern'?",
  remediation: "Use 'pattern' instead of 'query'.",
};

const QUERY_INSTEAD_OF_PATTERN: ArgumentMistakeGuidance = {
  expected: "query",
  message: "Unrecognized argument 'pattern'; did you mean 'query'?",
  remediation: "Use 'query' instead of 'pattern'.",
};

/** Lookup known neighboring-tool argument-name confusion for one top-level key. */
export const knownArgumentMistakeGuidance = (
  operation: string | undefined,
  argumentName: string,
): ArgumentMistakeGuidance | undefined => {
  if (operation === undefined) return undefined;
  if (argumentName === "address" && PROCEDURE_OPERATIONS.has(operation))
    return PROCEDURE_INSTEAD_OF_ADDRESS;
  if (argumentName === "procedure" && ADDRESS_OPERATIONS.has(operation))
    return ADDRESS_INSTEAD_OF_PROCEDURE;
  if (argumentName === "query" && PATTERN_OPERATIONS.has(operation))
    return PATTERN_INSTEAD_OF_QUERY;
  if (argumentName === "pattern" && QUERY_OPERATIONS.has(operation))
    return QUERY_INSTEAD_OF_PATTERN;
  return undefined;
};

/** Combine distinct argument-name replacement hints for an operation's rejected issues. */
export const knownArgumentMistakeRemediation = (
  operation: string,
  issues: readonly AnalysisInputIssue[],
): string | undefined => {
  const hints: string[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    if (issue.reason !== "unknown_argument" || issue.path.length !== 1)
      continue;
    const key = issue.path[0];
    if (typeof key !== "string") continue;
    const guidance = knownArgumentMistakeGuidance(operation, key);
    if (
      guidance !== undefined &&
      issue.expected === guidance.expected &&
      !seen.has(guidance.remediation)
    ) {
      seen.add(guidance.remediation);
      hints.push(guidance.remediation);
    }
  }
  return hints.length === 0 ? undefined : hints.join(" ");
};
