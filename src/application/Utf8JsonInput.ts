import { constants } from "node:buffer";

import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import { safeParseJson, type SafeJsonParseResult } from "../domain/safeJson.js";

/** Recovery that preserves complete, authenticated Evidence workflow inputs. */
export const JSON_INPUT_RESOURCE_REMEDIATION =
  "Provide a smaller valid JSON value. For Evidence workflows, re-analyze a smaller selection of the original target and use its complete Evidence; splitting JSON text or trimming Evidence fields does not produce valid workflow input.";

/** Decode JSON bytes without confusing a runtime string limit with malformed input. */
export const parseUtf8Json = (
  bytes: Uint8Array,
  operation: string,
  path: string,
): SafeJsonParseResult => {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch (cause: unknown) {
    const code =
      typeof cause === "object" && cause !== null && "code" in cause
        ? cause.code
        : undefined;
    if (code === "ERR_STRING_TOO_LONG")
      throw new AnalysisResourceConstraintError(
        operation,
        "file-size",
        "JSON input exceeds the runtime's maximum decoded string length",
        {
          input_path: path,
          input_bytes: bytes.byteLength,
          max_string_utf16_code_units: constants.MAX_STRING_LENGTH,
        },
        {
          cause,
          remediationAction: JSON_INPUT_RESOURCE_REMEDIATION,
        },
      );
    if (code !== "ERR_ENCODING_INVALID_ENCODED_DATA") throw cause;
    return {
      ok: false,
      error: "JSON input is not valid UTF-8",
      cause,
    };
  }
  return safeParseJson(text);
};
