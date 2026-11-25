import { insideArtifact } from "./artifactRange.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { PeLoadConfigPort } from "../../ports/binaryDiagnostics/PeLoadConfigPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import {
  inspectPeLoadConfigInputSchema,
  peLoadConfigSchema,
  type PeLoadConfig,
} from "../../domain/native/peLoadConfig.js";
import { observedPeEvidence } from "./observedPeEvidence.js";
import type { Result } from "../../domain/result.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_pe_load_config";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class PeLoadConfigService {
  constructor(readonly provider: PeLoadConfigPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeArtifactInspection(
      {
        operation: OPERATION,
        inputSchema: inspectPeLoadConfigInputSchema,
        outputSchema: peLoadConfigSchema,
        provider: this.provider,
        invalidOutputMessage:
          "PE TLS/load-config provider returned malformed output or changed artifact identity.",
        toParameters: (input) => input,
        validateReport: (report, parameters) =>
          report.artifact.path === parameters.path &&
          validReport(report, parameters),
        buildEvidence: (value, identity, parameters) =>
          observedPeEvidence(value, identity, OPERATION, parameters, [
            ...fileRange(value.tls?.directory ?? null),
            ...fileRange(value.load_config?.directory ?? null),
            ...structureRange(value.load_config),
            ...structureRange(value.tls),
            ...(value.tls?.callback_array_locations ?? []).map(
              ({ offset, bytes }) => ({
                kind: "file-offset-range" as const,
                start: offset,
                end: offset + bytes,
              }),
            ),
          ]),
      },
      rawInput,
      options,
    );
  }
}

const fileRange = (
  directory: { file_offset: number; size: number } | null,
): { kind: "file-offset-range"; start: number; end: number }[] =>
  directory === null
    ? []
    : [
        {
          kind: "file-offset-range",
          start: directory.file_offset,
          end: directory.file_offset + directory.size,
        },
      ];

/** The structure span read, when it differs from the declared directory range. */
const structureRange = (
  table: {
    readonly directory: { readonly size: number };
    readonly structure_location?:
      | { readonly offset: number; readonly bytes: number }
      | undefined;
  } | null,
): { kind: "file-offset-range"; start: number; end: number }[] =>
  table?.structure_location === undefined ||
  table.structure_location.bytes === table.directory.size
    ? []
    : [
        {
          kind: "file-offset-range",
          start: table.structure_location.offset,
          end: table.structure_location.offset + table.structure_location.bytes,
        },
      ];

const validReport = (
  report: PeLoadConfig,
  input: { max_callbacks: number },
): boolean => {
  if (
    report.examined_callbacks !== (report.tls?.callbacks.length ?? 0) ||
    report.examined_callbacks > input.max_callbacks ||
    report.bits !== (report.format === "pe32" ? 32 : 64)
  )
    return false;
  const ranges = [
    ...fileRange(report.tls?.directory ?? null),
    ...fileRange(report.load_config?.directory ?? null),
    ...structureRange(report.tls),
  ];
  const structure = report.load_config?.structure_location;
  const inside = insideArtifact(report.artifact.bytes);
  return (
    (structure === undefined ||
      (structure.offset === report.load_config?.directory.file_offset &&
        structure.bytes === report.load_config.size &&
        inside(structure))) &&
    ranges.every(
      ({ start, end }) => start <= end && end <= report.artifact.bytes,
    ) &&
    (report.tls?.callback_array_locations ?? []).every(inside) &&
    (report.tls?.callbacks ?? []).every(
      ({ file_offset }) =>
        file_offset === null || file_offset < report.artifact.bytes,
    )
  );
};
