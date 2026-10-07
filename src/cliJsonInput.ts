import { readFile } from "node:fs/promises";

import { AnalysisInputError } from "./domain/analysisErrorCore.js";
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
  const inline = parseJson(value);
  if (inline !== undefined) return { ok: true, value: inline };
  try {
    // Read raw bytes so invalid UTF-8 is rejected by parseJson instead of
    // being silently replaced by lossy "utf8" decoding.
    const parsed = parseJson(await readFile(value));
    return parsed === undefined
      ? jsonFileError(value, operation, "invalid-json")
      : { ok: true, value: parsed };
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

const cannotBeAnExistingFile = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ENAMETOOLONG");

const hasExplicitJsonFileExtension = (value: string): boolean =>
  value.toLowerCase().endsWith(".json");

const parseJson = (value: string | Uint8Array): unknown => {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(value);
    } catch (cause: unknown) {
      // Decoding failure means the bytes are not valid UTF-8 JSON input.
      void cause;
      return undefined;
    }
  }
  const parsed = safeParseJson(text);
  return parsed.ok ? parsed.value : undefined;
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
          : [],
      ),
    ),
    ...(path === undefined ? {} : { input_path: path }),
    input_reason: reason,
  },
});
