import { readFile, stat } from "node:fs/promises";

import { AnalysisInputError, projectAnalysisError } from "./domain/errors.js";
import type { JsonValue } from "./domain/jsonValue.js";

const MAX_JSON_INPUT_BYTES = 64 * 1_024 * 1_024;

/** Parse bounded inline JSON or one bounded local JSON file for a CLI workflow. */
export const parseCliJsonInput = async (
  value: string,
  operation: string,
): Promise<
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: JsonValue }
> => {
  const inline = parseJson(value);
  if (inline !== undefined) return { ok: true, value: inline };
  if (["{", "["].includes(value.trimStart()[0] ?? ""))
    return { ok: false, error: inputError(operation) };
  try {
    const metadata = await stat(value);
    if (!metadata.isFile()) return jsonFileError(value, operation, "not-file");
    if (metadata.size > MAX_JSON_INPUT_BYTES)
      return jsonFileError(value, operation, "too-large");
    const bytes = await readFile(value);
    if (bytes.byteLength > MAX_JSON_INPUT_BYTES)
      return jsonFileError(value, operation, "too-large");
    const parsed = parseJson(bytes.toString("utf8"));
    return parsed === undefined
      ? jsonFileError(value, operation, "invalid-json")
      : { ok: true, value: parsed };
  } catch {
    return jsonFileError(value, operation, "read-failed");
  }
};

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const inputError = (operation: string): JsonValue => ({
  error: "Application workflow failed",
  ...projectAnalysisError(
    new AnalysisInputError(operation, undefined, [
      { path: [], reason: "invalid_format", expected: "JSON" },
    ]),
  ),
});

const jsonFileError = (
  path: string,
  operation: string,
  reason: "not-file" | "too-large" | "invalid-json" | "read-failed",
) => ({
  ok: false as const,
  error: {
    error: "Application workflow failed",
    ...projectAnalysisError(
      new AnalysisInputError(
        operation,
        undefined,
        reason === "invalid-json"
          ? [{ path: [], reason: "invalid_format", expected: "JSON" }]
          : [],
      ),
    ),
    input_path: path,
    input_reason: reason,
    maximum_input_bytes: MAX_JSON_INPUT_BYTES,
  },
});
