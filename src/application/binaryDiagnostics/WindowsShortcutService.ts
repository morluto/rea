import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { WindowsShortcutPort } from "./WindowsShortcutPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectWindowsShortcutInputSchema,
  windowsShortcutSchema,
  type InspectWindowsShortcutInput,
  type WindowsShortcut,
} from "../../domain/native/windowsShortcut.js";
import { err, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { parseAnalysisInput } from "../AnalysisInput.js";

const OPERATION = "inspect_windows_shortcut";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class WindowsShortcutService {
  constructor(readonly provider: WindowsShortcutPort) {}

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
      inspectWindowsShortcutInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    const result = await this.provider.inspect(input.value, options);
    if (!result.ok) return result;
    const report = windowsShortcutSchema.safeParse(result.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      !validReport(report.data, input.value)
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Windows shortcut provider returned malformed output or changed artifact identity.",
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
          locations: locationsOf(value),
        },
      ),
      options?.signal,
    );
  }
}

const locationsOf = (
  report: WindowsShortcut,
): readonly (
  | { kind: "artifact-path"; path: string }
  | { kind: "file-offset-range"; start: number; end: number }
)[] => {
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
  return [{ kind: "artifact-path", path: report.artifact.path }, ...ranges];
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
  const inside = ({ offset, bytes }: { offset: number; bytes: number }) =>
    offset <= report.artifact.bytes - bytes;
  if (!inside(report.header.location)) return false;
  if (report.id_list !== null && !inside(report.id_list.location)) return false;
  if (report.link_info !== null && !inside(report.link_info.location))
    return false;
  return report.extra_data.blocks.every((block) =>
    inside({ offset: block.offset, bytes: block.size }),
  );
};
