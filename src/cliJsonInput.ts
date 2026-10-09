import { constants as bufferConstants } from "node:buffer";
import { resolve } from "node:path";

import {
  NonRegularFileReadError,
  readRegularFile,
} from "./application/RegularFileRead.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "./domain/analysisErrorCore.js";
import { projectAnalysisError } from "./domain/analysisErrorProjection.js";
import type { JsonValue } from "./domain/jsonValue.js";
import { decodeUtf8Json, safeParseJson } from "./domain/safeJson.js";

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
  try {
    // Read raw bytes so invalid UTF-8 is rejected by decoding instead of
    // being silently replaced by lossy "utf8" decoding.
    const bytes = await readRegularFile(value);
    const decoded = decodeUtf8Json(bytes);
    if (!decoded.ok)
      return decoded.reason === "too-large"
        ? oversizedJsonInputError(value, operation, bytes.length)
        : jsonFileError(value, operation, "invalid-json");
    const parsed = safeParseJson(decoded.text);
    return parsed.ok
      ? { ok: true, value: parsed.value }
      : jsonFileError(value, operation, "invalid-json");
  } catch (cause: unknown) {
    if (
      ["{", "["].includes(value.trimStart()[0] ?? "") &&
      cannotBeAnExistingFile(cause) &&
      !hasExplicitJsonFileExtension(value)
    )
      return { ok: false, error: inputError(operation) };
    return jsonFileError(value, operation, "read-failed", cause);
  }
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

/**
 * Report JSON input the runtime cannot hold as one string. The bytes may be
 * valid JSON, so this is a size constraint with observed and limit sizes,
 * not an invalid-format rejection.
 */
const oversizedJsonInputError = (
  path: string,
  operation: string,
  bytes: number,
) => ({
  ok: false as const,
  error: {
    error: "Application workflow failed",
    ...projectAnalysisError(
      new AnalysisResourceConstraintError(
        operation,
        "memory",
        `Decoding the ${bytes}-byte JSON input would exceed Node's single-string representation limit of ${bufferConstants.MAX_STRING_LENGTH} code units, so it cannot be parsed as one JSON document.`,
        {
          boundary: "cli-json-input",
          input_bytes: bytes,
          max_string_code_units: bufferConstants.MAX_STRING_LENGTH,
        },
        {
          remediationAction:
            "Re-run the producing analysis on a smaller subset so the JSON input stays below the reported limit, or select a smaller JSON document.",
        },
      ),
    ),
    input_path: path,
    input_reason: "input-too-large",
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
