import { resolve } from "node:path";

import { readCliJsonFile } from "./cliJsonFile.js";
import { NonRegularFileReadError } from "./filesystem/RegularFile.js";
import {
  AnalysisAccessDeniedError,
  AnalysisInputError,
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
  try {
    const parsed = await readCliJsonFile(value, operation);
    return parsed.ok
      ? { ok: true, value: parsed.value }
      : {
          ok: false,
          error: {
            error: "Application workflow failed",
            ...projectAnalysisError(parsed.error),
            input_path: value,
            input_reason:
              parsed.error._tag === "AnalysisInputError"
                ? "invalid-json"
                : "too-large",
          },
        };
  } catch (cause: unknown) {
    const systemCode = accessDeniedSystemCode(cause);
    if (systemCode !== undefined)
      return jsonAccessDeniedError(value, operation, systemCode, cause);
    if (
      ["{", "["].includes(value.trimStart()[0] ?? "") &&
      cannotBeAnExistingFile(cause) &&
      !hasExplicitJsonFileExtension(value)
    )
      return { ok: false, error: inputError(operation) };
    if (
      !(cause instanceof Error) ||
      !("code" in cause) ||
      typeof cause.code !== "string"
    )
      throw cause;
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
