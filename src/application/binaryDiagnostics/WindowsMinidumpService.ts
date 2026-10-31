import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { WindowsMinidumpPort } from "./WindowsMinidumpPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import type { BinaryArchitecture } from "../../domain/binaryTargetTypes.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectWindowsMinidumpInputSchema,
  WINDOWS_MINIDUMP_ARCHITECTURES,
  windowsMinidumpSchema,
  type WindowsMinidump,
  type WindowsMinidumpRange,
} from "../../domain/native/windowsMinidump.js";
import { err, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { parseAnalysisInput } from "../AnalysisInput.js";

const OPERATION = "inspect_windows_minidump";

/** Shared CLI/MCP validation and Evidence composition for recorded minidumps. */
export class WindowsMinidumpService {
  constructor(readonly provider: WindowsMinidumpPort) {}

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
      inspectWindowsMinidumpInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    const result = await this.provider.inspect(input.value, options);
    if (!result.ok) return result;
    const report = windowsMinidumpSchema.safeParse(result.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      report.data.artifact.bytes > input.value.max_file_bytes ||
      report.data.coverage.examined_entries > input.value.max_entries ||
      !validRanges(report.data)
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Windows minidump provider returned malformed output or changed artifact identity.",
        ),
      );
    const value = report.data;
    const architecture =
      value.system === null
        ? undefined
        : (
            WINDOWS_MINIDUMP_ARCHITECTURES as Readonly<
              Record<number, { evidence: BinaryArchitecture }>
            >
          )[value.system.processor_architecture]?.evidence;
    return completeProviderEvidence(
      createEvidence(
        {
          path: value.artifact.path,
          format: "file",
          ...(architecture === undefined ? {} : { architecture }),
          sha256: value.artifact.sha256,
        },
        this.provider.identity,
        {
          operation: OPERATION,
          parameters: input.value,
          result: value,
          rawResult: null,
          confidence: "observed",
          limitations: value.limitations,
          locations: [{ kind: "artifact-path", path: value.artifact.path }],
        },
      ),
      options?.signal,
    );
  }
}

/** Every published source range must lie inside the original artifact. */
const validRanges = (report: WindowsMinidump): boolean => {
  const inside = ({ offset, bytes }: WindowsMinidumpRange) =>
    offset <= report.artifact.bytes - bytes;
  const contextRanges = (
    context: WindowsMinidump["threads"][number]["context"],
  ): WindowsMinidumpRange[] => [
    context.location,
    ...(context.registers ?? []).map((r) => r.location),
  ];
  const ranges: WindowsMinidumpRange[] = [
    report.header.location,
    report.header.directory_location,
    ...report.streams.flatMap((s) => [s.entry_location, s.location]),
    ...(report.system === null ? [] : [report.system.location]),
    ...report.threads.flatMap((t) => [
      t.entry_location,
      t.stack.location,
      ...contextRanges(t.context),
    ]),
    ...(report.exception === null
      ? []
      : [
          report.exception.location,
          ...contextRanges(report.exception.context),
        ]),
    ...report.modules.flatMap((m) => [
      m.entry_location,
      m.name_location,
      m.cv_record_location,
      m.misc_record_location,
    ]),
    ...report.memory.flatMap((m) => [m.descriptor_location, m.location]),
  ];
  return (
    ranges.every(inside) &&
    report.streams.every((stream, index) => stream.index === index) &&
    report.threads.every((thread, index) => thread.index === index) &&
    report.modules.every((module, index) => module.index === index) &&
    report.header.stream_count === report.streams.length &&
    report.coverage.unknown_streams ===
      report.streams.filter((s) => s.interpretation === "unknown").length
  );
};
