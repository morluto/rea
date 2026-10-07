import { redactExplicitFailure } from "../domain/explicitSensitiveFailure.js";
import { excludeCaptureCoordinates } from "../domain/webNetworkCaptureCoordinates.js";
import { redactExplicitText } from "../domain/explicitSensitiveValues.js";
import { isAbsolute } from "node:path";
import type { ExecutionOptions } from "./AnalysisProvider.js";
import type { WebNetworkCapturePort } from "./WebNetworkCapturePort.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { projectInputIssues } from "../domain/inputIssueProjection.js";
import { jsonObjectSchema } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  inspectWebNetworkCaptureInputSchema,
  webNetworkCaptureSchema,
} from "../domain/webNetworkCapture.js";

const OPERATION = "inspect_web_network_capture";

/** Shared CLI/MCP historical inspection preserves caller selection and producer record identity. */
export class WebNetworkCaptureService {
  constructor(readonly port: WebNetworkCapturePort) {}

  /** Return selected complete records inline, without inventing live browser attribution. */
  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const declarations =
      inspectWebNetworkCaptureInputSchema.shape.sensitive_values.safeParse(
        typeof rawInput === "object" &&
          rawInput !== null &&
          "sensitive_values" in rawInput
          ? rawInput.sensitive_values
          : undefined,
      );
    const failure = (error: AnalysisError): Result<never, AnalysisError> =>
      err(
        redactExplicitFailure(
          error,
          declarations.success ? declarations.data : [],
        ),
      );
    const parsed = inspectWebNetworkCaptureInputSchema.safeParse(rawInput);
    if (!parsed.success)
      return failure(
        new AnalysisInputError(
          OPERATION,
          { cause: parsed.error },
          projectInputIssues(parsed.error.issues, rawInput),
        ),
      );
    const input = parsed.data;
    if (!isAbsolute(input.capture_path))
      return failure(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: ["capture_path"],
            reason: "invalid_format",
            message: "Expected an absolute filesystem path on this host.",
          },
        ]),
      );
    if (
      input.record_ordinals !== undefined &&
      new Set(input.record_ordinals).size !== input.record_ordinals.length
    )
      return failure(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: ["record_ordinals"],
            reason: "invalid_format",
            message: "Each requested producer ordinal must occur once.",
          },
        ]),
      );
    const loaded = await this.port.inspect(input, options);
    if (!loaded.ok) return failure(loaded.error);
    if (options?.signal?.aborted)
      return failure(new AnalysisCancelledError(OPERATION));
    const report = webNetworkCaptureSchema.safeParse(loaded.value);
    if (!report.success)
      return failure(
        new AnalysisOutputError(
          OPERATION,
          "Capture adapter returned malformed historical evidence.",
        ),
      );
    const value = report.data;
    if (
      value.artifact.path !== input.capture_path ||
      value.format !== input.format ||
      value.total_records !== value.records.length ||
      value.records.some((record, index) => record.ordinal !== index)
    )
      return failure(
        new AnalysisOutputError(
          OPERATION,
          "Capture adapter changed the selected artifact, format or original record sequence.",
        ),
      );
    const safeValue = excludeCaptureCoordinates(value, input.sensitive_values);
    const redactText = (text: string): string =>
      redactExplicitText(text, input.sensitive_values);
    const selected =
      input.record_ordinals ?? value.records.map(({ ordinal }) => ordinal);
    const records = [];
    for (const ordinal of selected) {
      const record = safeValue.records[ordinal];
      if (record === undefined)
        return failure(
          new AnalysisInputError(OPERATION, undefined, [
            {
              path: ["record_ordinals"],
              reason: "invalid_format",
              message: `Producer ordinal ${ordinal} is outside the retained capture (${value.total_records} records).`,
            },
          ]),
        );
      records.push({
        ...record,
        limitations: record.limitations.map(redactText),
      });
    }
    const safePath = input.sensitive_values.some((literal) =>
      input.capture_path.includes(literal),
    )
      ? ""
      : input.capture_path;
    const limitations = (
      safePath === ""
        ? [
            ...safeValue.limitations,
            "The explicitly sensitive artifact path is excluded; its observed SHA-256 and size remain available.",
          ]
        : safeValue.limitations
    ).map(redactText);
    const parameters = jsonObjectSchema.parse({
      capture_path: safePath,
      ...(input.sensitive_values.some((literal) =>
        input.format.includes(literal),
      )
        ? {}
        : { format: input.format }),
      record_ordinals: selected,
      sensitive_value_count: input.sensitive_values.length,
    });
    return ok(
      createEvidence(
        {
          path: safePath,
          sha256: value.artifact.sha256,
          format: "file",
        },
        value.decoder,
        {
          operation: OPERATION,
          parameters,
          result: {
            ...safeValue,
            artifact: { ...value.artifact, path: safePath },
            records,
            limitations,
          },
          confidence: "observed",
          authority: "historical-reference",
          limitations,
          locations:
            safePath === "" ? [] : [{ kind: "artifact-path", path: safePath }],
        },
      ),
    );
  }
}
