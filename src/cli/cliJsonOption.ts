import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";
import { safeParseJson } from "../domain/safeJson.js";

/** Decode one named CLI option before using the selected inputs. */
export const parseCliJsonOption = (
  operation: string,
  name: string,
  text: string | undefined,
  message: string,
): Result<unknown, AnalysisInputError> => {
  if (text === undefined) return ok(undefined);
  const parsed = safeParseJson(text);
  return parsed.ok
    ? parsed
    : err(
        new AnalysisInputError(operation, { cause: parsed.cause }, [
          { path: [name], reason: "invalid_format", message },
        ]),
      );
};
