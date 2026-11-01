import { isAbsolute } from "node:path";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { DwarfUnitsPort } from "./DwarfUnitsPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { metadataReportSubjectFormat } from "../../domain/apple/machoTargetSelection.js";
import { binaryMetadataArchitecture } from "../../domain/binaryMetadataArchitecture.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  dwarfUnitsSchema,
  inspectDwarfUnitsInputSchema,
  type DwarfUnitsReport,
  type InspectDwarfUnitsInput,
} from "../../domain/native/dwarfUnits.js";
import { err, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { parseAnalysisInput } from "../AnalysisInput.js";

const OPERATION = "inspect_dwarf_units";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class DwarfUnitsService {
  constructor(readonly provider: DwarfUnitsPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const input = parseAnalysisInput(
      OPERATION,
      rawInput,
      inspectDwarfUnitsInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    if (!isAbsolute(input.value.path))
      return err(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute filesystem path on this host.",
          },
        ]),
      );
    const result = await this.provider.inspect(input.value, options);
    if (!result.ok) return result;
    const report = dwarfUnitsSchema.safeParse(result.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      !validReport(report.data, input.value)
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "DWARF compile-unit provider returned malformed output or changed artifact identity.",
        ),
      );
    const value = report.data;
    const architecture =
      value.architecture === null
        ? undefined
        : binaryMetadataArchitecture(value.architecture);
    const locations = [
      { kind: "artifact-path" as const, path: value.artifact.path },
      ...value.sections.flatMap((section) =>
        section.size === 0
          ? []
          : [
              {
                kind: "file-offset-range" as const,
                start: section.offset,
                end: section.offset + section.size,
              },
            ],
      ),
      ...value.units.flatMap((unit) =>
        unit.file_offset === null
          ? []
          : [
              {
                kind: "file-offset-range" as const,
                start: unit.file_offset,
                end: unit.file_offset + unit.length,
              },
            ],
      ),
    ];
    return completeProviderEvidence(
      createEvidence(
        {
          path: value.artifact.path,
          format: metadataReportSubjectFormat(value),
          sha256: value.artifact.sha256,
          ...(architecture === undefined ? {} : { architecture }),
        },
        this.provider.identity,
        {
          operation: OPERATION,
          parameters: input.value,
          result: value,
          confidence: "observed",
          limitations: value.limitations,
          locations,
        },
      ),
      options?.signal,
    );
  }
}

const validReport = (
  report: DwarfUnitsReport,
  input: InspectDwarfUnitsInput,
): boolean => {
  if (report.artifact.bytes > input.max_file_bytes) return false;
  if (report.page.offset !== input.offset || report.page.limit !== input.limit)
    return false;
  const requested = input.architecture;
  const slice = report.selected_slice;
  if ((requested === undefined) !== (slice === undefined)) return false;
  return requested === undefined || report.architecture === requested;
};
