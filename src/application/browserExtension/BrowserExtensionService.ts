import { isAbsolute } from "node:path";

import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { BrowserExtensionPort } from "../../ports/browserExtension/BrowserExtensionPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisOutputError,
  cancelledBy,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  browserExtensionSchema,
  inspectBrowserExtensionInputSchema,
  type BrowserExtensionReport,
} from "../../domain/browserExtension/browserExtension.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class BrowserExtensionService {
  constructor(readonly provider: BrowserExtensionPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "inspect_browser_extension";
    const signal = options?.signal;
    if (signal?.aborted === true) return err(cancelledBy(operation, signal));
    const input = inspectBrowserExtensionInputSchema.safeParse(rawInput);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(operation, input.error.issues, rawInput, {
          cause: input.error,
        }),
      );
    if (!isAbsolute(input.data.path))
      return err(
        new AnalysisInputError(operation, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute filesystem path on this host.",
          },
        ]),
      );
    const result = await this.provider.inspect(input.data, options);
    if (!result.ok) return result;
    const report = browserExtensionSchema.safeParse(result.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.data.path ||
      !validReport(report.data, input.data)
    )
      return err(
        new AnalysisOutputError(
          operation,
          "Browser extension provider returned malformed output or changed artifact identity.",
        ),
      );
    const value = report.data;
    return completeProviderEvidence(
      createEvidence(
        {
          path: value.artifact.path,
          format: value.format === "zip" ? "zip" : "file",
          sha256: value.artifact.sha256,
        },
        this.provider.identity,
        {
          operation,
          parameters: input.data,
          result: value,
          confidence: "observed",
          limitations: value.limitations,
          locations: [{ kind: "artifact-path", path: value.artifact.path }],
        },
      ),
      options?.signal,
    );
  }
}

const validReport = (
  report: BrowserExtensionReport,
  input: {
    readonly max_file_bytes: number;
    readonly max_manifest_bytes: number;
  },
): boolean =>
  report.artifact.bytes <= input.max_file_bytes &&
  report.manifest.bytes <= input.max_manifest_bytes &&
  (report.container === null
    ? report.format === "unpacked"
    : report.container.zip_offset <= report.artifact.bytes &&
      report.container.header_bytes === report.container.zip_offset &&
      (report.format === "zip"
        ? report.container.crx_version === null
        : report.container.crx_version === (report.format === "crx2" ? 2 : 3)));
