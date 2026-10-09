import { constants } from "node:buffer";

import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import { safeParseJson, type SafeJsonParseResult } from "../domain/safeJson.js";

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
          remediationAction:
            "Provide a smaller JSON document. For Evidence-based workflows, re-analyze a smaller selection of the original target and use its Evidence; splitting JSON text alone does not produce a valid workflow input.",
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
