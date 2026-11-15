import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { RpmPackagePort } from "../../ports/rpm/RpmPackagePort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectRpmPackageInputSchema,
  rpmPackageSchema,
  type RpmPackage,
} from "../../domain/rpm/package.js";
import { err, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { parseAnalysisInput } from "../AnalysisInput.js";

const OPERATION = "inspect_rpm_package";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class RpmPackageService {
  constructor(readonly provider: RpmPackagePort) {}

  close(): Promise<void> {
    return this.provider.close();
  }

  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const input = parseAnalysisInput(
      OPERATION,
      rawInput,
      inspectRpmPackageInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    const result = await this.provider.inspect(input.value, options);
    if (!result.ok) return result;
    const report = rpmPackageSchema.safeParse(result.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      !validReport(report.data, input.value)
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "RPM package provider returned malformed output or changed artifact identity.",
        ),
      );
    const value = report.data;
    return completeProviderEvidence(
      createEvidence(
        {
          path: value.artifact.path,
          format: "file",
          sha256: value.artifact.sha256,
        },
        this.provider.identity,
        {
          operation: OPERATION,
          parameters: input.value,
          result: value,
          confidence: "observed",
          limitations: value.limitations,
          locations: [
            { kind: "artifact-path" as const, path: value.artifact.path },
            {
              kind: "file-offset-range" as const,
              start: value.lead.location.offset,
              end: value.lead.location.offset + value.lead.location.bytes,
            },
            ...(value.signature === null
              ? []
              : [
                  {
                    kind: "file-offset-range" as const,
                    start: value.signature.location.offset,
                    end:
                      value.signature.location.offset +
                      value.signature.location.bytes,
                  },
                ]),
            {
              kind: "file-offset-range" as const,
              start: value.header.location.offset,
              end: value.header.location.offset + value.header.location.bytes,
            },
            {
              kind: "file-offset-range" as const,
              start: value.payload.offset,
              end: value.payload.offset + value.payload.size,
            },
          ],
        },
      ),
      options?.signal,
    );
  }
}

const validReport = (
  report: RpmPackage,
  input: {
    readonly max_file_bytes: number;
    readonly max_header_index_entries: number;
    readonly max_files: number;
    readonly max_script_bytes: number;
    readonly include_script_text: boolean;
  },
): boolean => {
  if (report.artifact.bytes > input.max_file_bytes) return false;
  if (report.header.index_entries > input.max_header_index_entries)
    return false;
  if (
    report.signature !== null &&
    report.signature.index_entries > input.max_header_index_entries
  )
    return false;
  if (report.files !== null && report.files.length > input.max_files)
    return false;
  if (
    report.coverage.files !==
    (report.files === null ? null : report.files.length)
  )
    return false;
  if (report.scriptlets !== null) {
    for (const scriptlet of report.scriptlets) {
      if (input.include_script_text) {
        if (scriptlet.text === null) return false;
        // The parser decodes stored UTF-8 exactly (fatal, BOM kept), so the
        // stored byte count is the text's UTF-8 length.
        if (scriptlet.bytes > input.max_script_bytes) return false;
        if (scriptlet.bytes !== Buffer.byteLength(scriptlet.text, "utf8"))
          return false;
      } else if (scriptlet.text !== null) return false;
    }
  }
  return (
    report.payload.listing_source === "header" &&
    report.payload.offset + report.payload.size === report.artifact.bytes
  );
};
