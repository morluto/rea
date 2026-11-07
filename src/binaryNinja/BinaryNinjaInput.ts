import { TOOL_CONTRACTS } from "../contracts/toolContracts.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { jsonObjectSchema, type JsonValue } from "../domain/jsonValue.js";
import { err, ok } from "../domain/result.js";
import {
  binaryNinjaAddressSchema,
  sameBinaryNinjaHostPath,
} from "./BinaryNinjaProtocolValues.js";

const issue = (
  operation: string,
  path: string,
  reason: "missing_argument" | "invalid_format" | "invalid_value",
  message: string,
) =>
  err(
    new AnalysisInputError(operation, undefined, [
      { path: [path], reason, message },
    ]),
  );

/** An optional document argument must name the REA-bound target. */
const admitsDocument = (
  document: JsonValue | undefined,
  target: BinaryTarget,
): boolean =>
  document === undefined ||
  (typeof document === "string" &&
    (sameBinaryNinjaHostPath(document, target.path) ||
      (target.sourcePath !== undefined &&
        sameBinaryNinjaHostPath(document, target.sourcePath))));

/** Apply the named public contract and Binary Ninja's explicit-address boundary before startup. */
export const parseBinaryNinjaInput = (
  operation: string,
  parameters: Readonly<Record<string, JsonValue>>,
  target: BinaryTarget,
) => {
  const contract = TOOL_CONTRACTS.find(({ name }) => name === operation);
  const parsed = contract?.inputSchema.safeParse(parameters);
  if (parsed?.success !== true)
    return err(
      analysisInputErrorFromIssues(
        operation,
        parsed?.error?.issues ?? [],
        parameters,
        { cause: parsed?.error },
      ),
    );
  if (operation === "xrefs" && typeof parameters.address !== "string")
    return issue(
      operation,
      "address",
      "missing_argument",
      "Binary Ninja requires an explicit hexadecimal address.",
    );
  if (
    parameters.address !== undefined &&
    !binaryNinjaAddressSchema.safeParse(parameters.address).success
  )
    return issue(
      operation,
      "address",
      "invalid_format",
      "Binary Ninja requires a 0x-prefixed hexadecimal address.",
    );
  if (
    typeof parameters.procedure === "string" &&
    parameters.procedure.length === 0
  )
    return issue(
      operation,
      "procedure",
      "invalid_value",
      "Supply a function name or entry address.",
    );
  if (parameters.mode === "regex" && typeof parameters.pattern === "string") {
    try {
      new RegExp(
        parameters.pattern,
        parameters.case_sensitive === true ? "u" : "iu",
      );
    } catch (cause: unknown) {
      return err(
        new AnalysisInputError(operation, { cause }, [
          {
            path: ["pattern"],
            reason: "invalid_format",
            message: "Supply a valid regular expression.",
          },
        ]),
      );
    }
  }
  if (!admitsDocument(parameters.document, target))
    return issue(
      operation,
      "document",
      "invalid_value",
      "The document must be the REA-bound target; omit document or use its admitted path.",
    );
  return ok(jsonObjectSchema.parse(parsed.data));
};
