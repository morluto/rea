import { readFile } from "node:fs/promises";

import { AnalysisInputError, projectAnalysisError } from "./domain/errors.js";
import type { JsonValue } from "./domain/jsonValue.js";

/** Parse inline JSON or one local JSON file for a CLI workflow. */
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
    const parsed = parseJson(await readFile(value));
    return parsed === undefined
      ? jsonFileError(value, operation, "invalid-json")
      : { ok: true, value: parsed };
  } catch {
    return jsonFileError(value, operation, "read-failed");
  }
};

const parseJson = (value: string | Uint8Array): unknown => {
  try {
    return JSON.parse(
      typeof value === "string"
        ? value
        : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            value,
          ),
    );
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
  path: string | undefined,
  operation: string,
  reason: "invalid-json" | "read-failed",
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
    ...(path === undefined ? {} : { input_path: path }),
    input_reason: reason,
  },
});
