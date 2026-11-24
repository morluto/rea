import { insideArtifact } from "./artifactRange.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { WindowsShortcutPort } from "../../ports/binaryDiagnostics/WindowsShortcutPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import {
  inspectWindowsShortcutInputSchema,
  windowsShortcutSchema,
  type InspectWindowsShortcutInput,
  type WindowsShortcut,
} from "../../domain/native/windowsShortcut.js";
import type { Result } from "../../domain/result.js";
import { observedFileEvidence } from "../observedFileEvidence.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_windows_shortcut";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class WindowsShortcutService {
  constructor(readonly provider: WindowsShortcutPort) {}

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
        inputSchema: inspectWindowsShortcutInputSchema,
        outputSchema: windowsShortcutSchema,
        provider: this.provider,
        invalidOutputMessage:
          "Windows shortcut provider returned malformed output or changed artifact identity.",
        toParameters: (input) => input,
        validateReport: (report, parameters) =>
          report.artifact.path === parameters.path &&
          validReport(report, parameters),
        buildEvidence: (value, identity, parameters) =>
          observedFileEvidence(
            value,
            identity,
            OPERATION,
            parameters,
            fileRanges(value),
          ),
      },
      rawInput,
      options,
    );
  }
}

const fileRanges = (report: WindowsShortcut) => {
  const ranges: {
    kind: "file-offset-range";
    start: number;
    end: number;
  }[] = [
    {
      kind: "file-offset-range",
      start: report.header.location.offset,
      end: report.header.location.offset + report.header.location.bytes,
    },
  ];
  if (report.id_list !== null)
    ranges.push({
      kind: "file-offset-range",
      start: report.id_list.location.offset,
      end: report.id_list.location.offset + report.id_list.location.bytes,
    });
  if (report.link_info !== null)
    ranges.push({
      kind: "file-offset-range",
      start: report.link_info.location.offset,
      end: report.link_info.location.offset + report.link_info.location.bytes,
    });
  return ranges;
};

const validReport = (
  report: WindowsShortcut,
  input: InspectWindowsShortcutInput,
): boolean => {
  if (
    report.artifact.bytes > input.max_file_bytes ||
    report.coverage.examined_id_list_items > input.max_id_list_items ||
    report.coverage.examined_extra_data_blocks > input.max_extra_data_blocks ||
    (report.id_list?.items.length ?? 0) !==
      report.coverage.examined_id_list_items ||
    report.extra_data.blocks.length !==
      report.coverage.examined_extra_data_blocks
  )
    return false;
  const complete = report.coverage.status === "complete";
  if (complete !== (report.issues.length === 0)) return false;
  if (complete && report.coverage.failing_offset !== null) return false;
  if (!complete && report.coverage.reason === null) return false;
  const inside = insideArtifact(report.artifact.bytes);
  if (!inside(report.header.location)) return false;
  if (report.id_list !== null && !inside(report.id_list.location)) return false;
  if (report.link_info !== null && !inside(report.link_info.location))
    return false;
  return report.extra_data.blocks.every((block) =>
    inside({ offset: block.offset, bytes: block.size }),
  );
};
