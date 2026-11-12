import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { NativeInitializersPort } from "./NativeInitializersPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectNativeInitializersInputSchema,
  nativeInitializersSchema,
  type InspectNativeInitializersInput,
  type NativeInitializers,
} from "../../domain/native/nativeInitializers.js";
import { err, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { parseAnalysisInput } from "../AnalysisInput.js";
import {
  machoSelectionAnswersArchitecture,
  machoSliceFamily,
} from "../../domain/apple/machoTargetSelection.js";

const OPERATION = "inspect_native_initializers";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class NativeInitializersService {
  constructor(readonly provider: NativeInitializersPort) {}

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
      inspectNativeInitializersInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    const result = await this.provider.inspect(input.value, options);
    if (!result.ok) return result;
    const report = nativeInitializersSchema.safeParse(result.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      !validReport(report.data, input.value)
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Native initializer provider returned malformed output or changed artifact identity.",
        ),
      );
    const value = report.data;
    const locations = [
      { kind: "artifact-path" as const, path: value.artifact.path },
      ...value.entries.flatMap((entry) =>
        entry.slot_file_offset === null
          ? []
          : [
              {
                kind: "file-offset-range" as const,
                start: entry.slot_file_offset,
                end: entry.slot_file_offset + entry.slot_bytes,
              },
            ],
      ),
    ];
    return completeProviderEvidence(
      createEvidence(
        {
          path: value.artifact.path,
          format: value.slice === null ? value.format : "mach-o-universal",
          sha256: value.artifact.sha256,
          ...(value.architecture === null
            ? {}
            : { architecture: value.architecture }),
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
  report: NativeInitializers,
  input: InspectNativeInitializersInput,
): boolean => {
  const { coverage } = report;
  const slice = report.slice;
  if (!machoSelectionAnswersArchitecture(slice, input.architecture))
    return false;
  // Slice and report labels name the CPU family; arm64e selects an arm64 slice.
  if (
    slice !== null &&
    input.architecture !== undefined &&
    (report.format !== "mach-o" ||
      slice.architecture !== machoSliceFamily(input.architecture) ||
      report.machine !== slice.cpu_type ||
      report.architecture !== machoSliceFamily(input.architecture))
  )
    return false;
  const insideArtifact = (offset: number, bytes: number): boolean =>
    offset <= report.artifact.bytes - bytes;
  // Entry file offsets name the selected image, not another slice in the container.
  const imageStart = slice?.file_offset ?? 0;
  const imageEnd =
    slice === null ? report.artifact.bytes : slice.file_offset + slice.size;
  const insideImage = (offset: number | null, bytes: number): boolean =>
    offset === null || (offset >= imageStart && bytes <= imageEnd - offset);
  if (
    (slice !== null && !insideArtifact(slice.file_offset, slice.size)) ||
    report.artifact.bytes > input.max_file_bytes ||
    coverage.offset !== input.offset ||
    coverage.limit !== input.limit ||
    report.entries.length !== coverage.returned_entries ||
    report.entries.length > input.limit ||
    coverage.returned_entries + coverage.offset >
      Math.max(coverage.examined_entries, coverage.offset) ||
    (coverage.status === "complete") !== (report.status === "parsed")
  )
    return false;
  return report.entries.every(
    (entry, position) =>
      entry.index === coverage.offset + position &&
      insideImage(entry.slot_file_offset, entry.slot_bytes) &&
      insideImage(entry.value_file_offset, 1),
  );
};
