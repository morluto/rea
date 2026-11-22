import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { PeOverlayPort } from "../../ports/binaryDiagnostics/PeOverlayPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectPeOverlayInputSchema,
  PE_OVERLAY_ENTROPY_WINDOW_BYTES,
  PE_OVERLAY_MAX_REPORTED_SECTIONS,
  PE_OVERLAY_PREFIX_BYTES,
  peOverlayDirectoryLayout,
  peOverlaySchema,
  peSectionExtendsImage,
  peSectionRawEnd,
  roundPeRawPointer,
  type PeOverlay,
} from "../../domain/native/peOverlay.js";
import { peSubjectArchitecture } from "../../domain/peMachine.js";
import { err, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { parseAnalysisInput } from "../AnalysisInput.js";

const OPERATION = "inspect_pe_overlay";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class PeOverlayService {
  constructor(readonly provider: PeOverlayPort) {}

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
      inspectPeOverlayInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    const result = await this.provider.inspect(input.value, options);
    if (!result.ok) return result;
    const report = peOverlaySchema.safeParse(result.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      !validReport(report.data, input.value)
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "PE overlay provider returned malformed output or changed artifact identity.",
        ),
      );
    const value = report.data;
    const architecture = peSubjectArchitecture(value.machine, value.format);
    const locations = [
      { kind: "artifact-path" as const, path: value.artifact.path },
      ...value.ranges.map((range) => ({
        kind: "file-offset-range" as const,
        start: range.offset,
        end: range.offset + range.size,
      })),
    ];
    return completeProviderEvidence(
      createEvidence(
        {
          path: value.artifact.path,
          format: "pe",
          sha256: value.artifact.sha256,
          ...(architecture === undefined ? {} : { architecture }),
        },
        this.provider.identity,
        {
          operation: OPERATION,
          parameters: input.value,
          result: value,
          confidence: "derived",
          limitations: value.limitations,
          locations,
        },
      ),
      options?.signal,
    );
  }
}

/** Complete coverage lists every section; partial lists exactly the budget. */
const coverageMatches = ({ sections, section_coverage }: PeOverlay): boolean =>
  section_coverage.reported === sections.length &&
  (section_coverage.status === "complete"
    ? section_coverage.declared === sections.length
    : sections.length === PE_OVERLAY_MAX_REPORTED_SECTIONS &&
      section_coverage.declared > sections.length);

const sectionsMatch = (report: PeOverlay): boolean => {
  if (!coverageMatches(report)) return false;
  let imageEnd = report.size_of_headers;
  for (const [index, section] of report.sections.entries()) {
    const rounded = roundPeRawPointer(
      section.pointer_to_raw_data,
      report.raw_pointer_rounding.alignment,
    );
    const extendsImage = peSectionExtendsImage(
      section.size_of_raw_data,
      section.characteristics,
    );
    if (
      section.index !== index ||
      section.rounded_pointer_to_raw_data !== rounded ||
      section.raw_pointer_rounded !==
        (rounded !== section.pointer_to_raw_data) ||
      section.extends_image !== extendsImage
    )
      return false;
    if (!extendsImage) continue;
    const end = peSectionRawEnd(
      section.pointer_to_raw_data,
      section.size_of_raw_data,
    );
    if (end > imageEnd) imageEnd = end;
  }
  // Unlisted sections may still move the image end past the listed ones.
  const endMatches =
    report.section_coverage.status === "complete"
      ? imageEnd === report.image_end
      : imageEnd <= report.image_end;
  return endMatches && report.image_end >= report.size_of_headers;
};

const directoryLayoutMatches = (report: PeOverlay): boolean => {
  const directory = report.security_directory;
  const expected = peOverlayDirectoryLayout(
    directory.status === "absent"
      ? undefined
      : { address: directory.offset, size: directory.size },
    report.size_of_headers,
    report.image_end,
    report.file_size,
    report.section_coverage,
  );
  if (
    directory.status !== expected.security_directory.status ||
    (directory.status === "malformed" &&
      expected.security_directory.status === "malformed" &&
      directory.defect !== expected.security_directory.defect) ||
    report.limitations.length !== expected.limitations.length ||
    !expected.limitations.every(
      (note, index) => note === report.limitations[index],
    ) ||
    report.ranges.length !== expected.ranges.length
  )
    return false;
  for (const [index, range] of report.ranges.entries()) {
    const span = expected.ranges[index];
    if (
      !span ||
      range.role !== span.role ||
      range.offset !== span.offset ||
      range.size !== span.size
    )
      return false;
    if (range.role === "other") {
      const sampled = Math.min(range.size, PE_OVERLAY_ENTROPY_WINDOW_BYTES);
      const prefixBytes = Math.min(range.size, PE_OVERLAY_PREFIX_BYTES);
      if (
        range.entropy.sampled_bytes !== sampled ||
        range.prefix_hex.length !== prefixBytes * 2
      )
        return false;
    }
  }
  return true;
};

const validReport = (
  report: PeOverlay,
  input: { max_file_bytes: number },
): boolean =>
  report.artifact.bytes <= input.max_file_bytes &&
  report.file_size === report.artifact.bytes &&
  report.size_of_headers <= report.file_size &&
  report.image_end <= report.file_size &&
  report.present === report.image_end < report.file_size &&
  sectionsMatch(report) &&
  directoryLayoutMatches(report);
