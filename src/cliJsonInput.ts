import { constants as bufferConstants } from "node:buffer";
import { resolve } from "node:path";

import {
  NonRegularFileReadError,
  readRegularFile,
} from "./application/RegularFileRead.js";
import { parseUtf8Json } from "./application/Utf8JsonInput.js";
import {
  AnalysisAccessDeniedError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "./domain/analysisErrorCore.js";
import { projectAnalysisError } from "./domain/analysisErrorProjection.js";
import type { JsonValue } from "./domain/jsonValue.js";
import { safeParseJson } from "./domain/safeJson.js";

/** Parse inline JSON or one local JSON file for a CLI workflow. */
export const parseCliJsonInput = async (
  value: string,
  operation: string,
): Promise<
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: JsonValue }
> => {
  const inline = safeParseJson(value);
  if (inline.ok) return { ok: true, value: inline.value };
  if (isStringLengthLimit(inline.cause))
    return jsonTooLargeError(undefined, operation);
  try {
    // Read raw bytes so invalid UTF-8 is rejected instead of
    // being silently replaced by lossy "utf8" decoding.
    const parsed = parseUtf8Json(
      await readRegularFile(value),
      operation,
      value,
      "cli-json-input",
    );
    return parsed.ok
      ? { ok: true, value: parsed.value }
      : jsonFileError(value, operation, "invalid-json");
  } catch (cause: unknown) {
    if (cause instanceof AnalysisResourceConstraintError)
      return {
        ok: false,
        error: {
          error: "Application workflow failed",
          ...projectAnalysisError(cause),
          input_path: value,
          input_reason: "too-large",
        },
      };
    const systemCode = accessDeniedSystemCode(cause);
    if (systemCode !== undefined)
      return jsonAccessDeniedError(value, operation, systemCode, cause);
    if (
      ["{", "["].includes(value.trimStart()[0] ?? "") &&
      cannotBeAnExistingFile(cause) &&
      !hasExplicitJsonFileExtension(value)
    )
      return { ok: false, error: inputError(operation) };
    return jsonFileError(value, operation, "read-failed", cause);
  }
};

const accessDeniedSystemCode = (
  cause: unknown,
): "EACCES" | "EPERM" | undefined => {
  if (!(cause instanceof Error) || !("code" in cause)) return undefined;
  return cause.code === "EACCES" || cause.code === "EPERM"
    ? cause.code
    : undefined;
};

/**
 * Resolve named string fields of CLI-supplied JSON against the operator
 * working directory. Each entry is a key path from the document root; only
 * fields holding nonblank strings are resolved, everything else passes through
 * untouched so shared schemas can reject blank paths. Shared MCP contracts reject
 * relative paths, so CLI workflows resolve operator-relative values before validation.
 */
export const resolveCliJsonPaths = (
  value: unknown,
  paths: ReadonlyArray<ReadonlyArray<string>>,
): unknown => {
  let resolved = value;
  for (const keys of paths) resolved = resolveJsonPath(resolved, keys);
  return resolved;
};

const resolveJsonPath = (
  value: unknown,
  keys: ReadonlyArray<string>,
): unknown => {
  const [head, ...tail] = keys;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return value;
  const entries = Object.entries(value).map(
    ([key, entry]: readonly [string, unknown]): readonly [string, unknown] => {
      if (key !== head) return [key, entry];
      if (tail.length === 0)
        return [
          key,
          typeof entry === "string" && entry.trim().length > 0
            ? resolve(entry)
            : entry,
        ];
      return [key, resolveJsonPath(entry, tail)];
    },
  );
  return Object.fromEntries(entries);
};

const cannotBeAnExistingFile = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause.code === "ENOENT" ||
    cause.code === "ENAMETOOLONG" ||
    cause.code === "ENOTDIR");

const hasExplicitJsonFileExtension = (value: string): boolean =>
  value.toLowerCase().endsWith(".json");

const isStringLengthLimit = (cause: unknown): boolean =>
  cause instanceof Error &&
  (("code" in cause && cause.code === "ERR_STRING_TOO_LONG") ||
    /cannot create a string longer than|invalid string length/i.test(
      cause.message,
    ));

const inputError = (operation: string): JsonValue => ({
  error: "Application workflow failed",
  ...projectAnalysisError(
    new AnalysisInputError(operation, undefined, [
      { path: [], reason: "invalid_format", expected: "JSON" },
    ]),
  ),
});

const jsonFileError = (
  path: string | undefined,
  operation: string,
  reason: "invalid-json" | "read-failed",
  cause?: unknown,
) => ({
  ok: false as const,
  error: {
    error: "Application workflow failed",
    ...projectAnalysisError(
      new AnalysisInputError(
        operation,
        cause === undefined ? undefined : { cause },
        reason === "invalid-json"
          ? [{ path: [], reason: "invalid_format", expected: "JSON" }]
          : [readFailureIssue(path, cause)],
      ),
    ),
    ...(path === undefined ? {} : { input_path: path }),
    input_reason: reason,
  },
});

const jsonAccessDeniedError = (
  path: string,
  operation: string,
  systemCode: "EACCES" | "EPERM",
  cause: unknown,
) => ({
  ok: false as const,
  error: {
    error: "Application workflow failed",
    ...projectAnalysisError(
      new AnalysisAccessDeniedError(operation, path, systemCode, { cause }),
    ),
    input_path: path,
    input_reason: "read-failed" as const,
  },
});

/** Preserve file-selection and system failures alongside the requested path. */
const readFailureIssue = (path: string | undefined, cause: unknown) => {
  const code =
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string"
      ? ` (${cause.code})`
      : "";
  return {
    path: [],
    reason: "invalid_value" as const,
    message:
      cause instanceof NonRegularFileReadError && cause.code === "ENOTFILE"
        ? `The JSON input must be a regular file${code}: ${path ?? ""}`
        : `The JSON input file could not be read${code}: ${path ?? ""}`,
  };
};

const jsonTooLargeError = (
  path: string | undefined,
  operation: string,
): { readonly ok: false; readonly error: JsonValue } => ({
  ok: false,
  error: {
    error: "Application workflow failed",
    ...projectAnalysisError(
      new AnalysisResourceConstraintError(
        operation,
        "memory",
        `The JSON input exceeds this Node.js runtime's maximum string length (${bufferConstants.MAX_STRING_LENGTH} UTF-16 code units) and cannot be parsed as one value.`,
        {
          boundary: "cli-json-input",
          max_string_code_units: bufferConstants.MAX_STRING_LENGTH,
        },
        {
          remediationAction:
            "Provide a smaller JSON document or rerun its producer on a smaller selection. Splitting JSON text alone does not produce a valid workflow input.",
        },
      ),
    ),
    ...(path === undefined ? {} : { input_path: path }),
    input_reason: "too-large",
  },
});
