import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { ElfUnwindRangesPort } from "./ElfUnwindRangesPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { elfObjectTypeName } from "../../domain/native/elfNotes.js";
import {
  ELF_UNWIND_LIMITATIONS,
  elfEhPointerEncodingName,
  inspectElfUnwindRangesInputSchema,
  elfUnwindRangesSchema,
  MAX_INSPECT_ELF_UNWIND_RANGES,
  type ElfUnwindRanges,
} from "../../domain/native/elfUnwindRanges.js";
import { BINARY_ARCHITECTURES } from "../../domain/binaryTargetTypes.js";
import { elfArchitecture } from "../../domain/elfFixedHeader.js";
import { err, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { parseAnalysisInput } from "../AnalysisInput.js";

const OPERATION = "inspect_elf_unwind_ranges";
const {
  cfa: CFA_LIMITATION,
  untrusted: UNTRUSTED_LIMITATION,
  indirect: INDIRECT_LIMITATION,
  headerMismatch: HEADER_MISMATCH,
  frameAbsent: FRAME_ABSENT,
  headerAbsent: HEADER_ABSENT,
  debugPresent: DEBUG_PRESENT,
  debugAbsent: DEBUG_ABSENT,
  debugUnknown: DEBUG_UNKNOWN,
  debugOutside: DEBUG_OUTSIDE,
} = ELF_UNWIND_LIMITATIONS;

type Range = { readonly offset: number; readonly bytes: number };
type Encoding = { readonly raw: number; readonly name: string };

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class ElfUnwindRangesService {
  constructor(readonly provider: ElfUnwindRangesPort) {}

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
      inspectElfUnwindRangesInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    const result = await this.provider.inspect(input.value, options);
    if (!result.ok) return result;
    const report = elfUnwindRangesSchema.safeParse(result.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      !validReport(
        report.data,
        input.value.max_ranges,
        input.value.max_file_bytes,
        input.value.offset,
        input.value.limit,
      )
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "ELF unwind provider returned malformed output or changed artifact identity.",
        ),
      );
    const value = report.data;
    const architecture = BINARY_ARCHITECTURES.find(
      (supported) => supported === elfArchitecture(value.machine),
    );
    const locations = [
      { kind: "artifact-path" as const, path: value.artifact.path },
      ...rangesOf(value).map((range) => ({
        kind: "file-offset-range" as const,
        start: range.offset,
        end: range.offset + range.bytes,
      })),
    ];
    return completeProviderEvidence(
      createEvidence(
        {
          path: value.artifact.path,
          format: "elf",
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

const inside =
  (fileBytes: number) =>
  (range: Range): boolean =>
    range.bytes <= fileBytes && range.offset <= fileBytes - range.bytes;

const rangesOf = (report: ElfUnwindRanges): Range[] => {
  const found: Range[] = [];
  const add = (range: Range | null): void => {
    if (range !== null) found.push(range);
  };
  add(report.eh_frame.location);
  add(report.eh_frame_hdr.location);
  add(report.debug_frame.location);
  for (const cie of report.cies) add(cie.location);
  for (const range of report.ranges) add(range.location);
  return found;
};

const encodingOk = (encoding: Encoding | null): boolean =>
  encoding === null || encoding.name === elfEhPointerEncodingName(encoding.raw);

const has = (report: ElfUnwindRanges, text: string): boolean =>
  report.limitations.includes(text);

const frameOk = (report: ElfUnwindRanges): boolean => {
  const frame = report.eh_frame;
  if (frame.status === "absent" || frame.status === "unknown") {
    if (
      frame.source !== null ||
      frame.location !== null ||
      report.cies.length !== 0 ||
      report.coverage.total_cies !== 0 ||
      report.coverage.total_ranges !== 0
    )
      return false;
    if (frame.status === "unknown")
      return report.coverage.status === "incomplete";
    return has(report, FRAME_ABSENT);
  }
  if (frame.status === "present")
    return frame.source !== null && frame.location !== null;
  return (
    report.coverage.status === "incomplete" &&
    (frame.location === null || frame.source !== null)
  );
};

const headerOk = (report: ElfUnwindRanges, maxRanges: number): boolean => {
  const header = report.eh_frame_hdr;
  const encodings = [
    header.eh_frame_pointer_encoding,
    header.fde_count_encoding,
    header.table_encoding,
  ];
  // A declared fde_count may exceed the budget, but decoded rows never may.
  if (!encodings.every(encodingOk) || header.table_entries > maxRanges)
    return false;
  if (header.status === "absent" || header.status === "unknown") {
    if (
      header.location !== null ||
      header.version !== null ||
      header.eh_frame_pointer !== null ||
      header.fde_count !== null ||
      header.table_entries !== 0 ||
      encodings.some((encoding) => encoding !== null) ||
      report.coverage.eh_frame_hdr_agreement !== "unavailable"
    )
      return false;
    return (
      header.status === "unknown" ||
      report.eh_frame.status === "unknown" ||
      has(report, HEADER_ABSENT)
    );
  }
  if (header.status === "incomplete")
    return (
      report.coverage.status === "incomplete" &&
      report.coverage.eh_frame_hdr_agreement === "unavailable" &&
      (header.fde_count === null || header.table_entries <= header.fde_count)
    );
  if (
    header.location === null ||
    header.version !== 1 ||
    header.eh_frame_pointer === null ||
    encodings.some((encoding) => encoding === null)
  )
    return false;
  // A header whose count encoding is DW_EH_PE_omit carries no search table.
  if (header.fde_count_encoding?.raw === 0xff)
    return (
      header.fde_count === null &&
      header.table_entries === 0 &&
      report.coverage.eh_frame_hdr_agreement === "unavailable"
    );
  // A header may declare a count but omit its search table.
  if (header.table_encoding?.raw === 0xff)
    return (
      header.fde_count !== null &&
      header.table_entries === 0 &&
      report.coverage.eh_frame_hdr_agreement === "unavailable"
    );
  if (
    header.fde_count === null ||
    header.table_entries !== header.fde_count ||
    encodings.some((encoding) => encoding === null)
  )
    return false;
  if (report.coverage.eh_frame_hdr_agreement === "agree")
    return !has(report, HEADER_MISMATCH);
  if (report.coverage.eh_frame_hdr_agreement === "disagree")
    return has(report, HEADER_MISMATCH);
  return false;
};

const debugOk = (report: ElfUnwindRanges): boolean => {
  const debug = report.debug_frame;
  if (debug.status === "present")
    return debug.location !== null && has(report, DEBUG_PRESENT);
  if (debug.location !== null) return false;
  if (debug.status === "incomplete")
    return (
      report.coverage.status === "incomplete" && has(report, DEBUG_OUTSIDE)
    );
  return has(report, debug.status === "absent" ? DEBUG_ABSENT : DEBUG_UNKNOWN);
};

// The page returns exactly the CIEs its ranges name, in ascending index order,
// so CIE output is bounded by the page size rather than by max_ranges.
const cieOk = (report: ElfUnwindRanges): boolean => {
  const named = new Set(report.ranges.map((range) => range.cie_index));
  if (report.cies.length !== named.size) return false;
  let previous = -1;
  for (const cie of report.cies) {
    if (
      !named.has(cie.index) ||
      cie.index <= previous ||
      cie.index >= report.coverage.total_cies ||
      !cieEncodingsOk(cie)
    )
      return false;
    previous = cie.index;
  }
  return true;
};

const cieEncodingsOk = (cie: ElfUnwindRanges["cies"][number]): boolean =>
  encodingOk(cie.pointer_encoding) &&
  encodingOk(cie.lsda_encoding) &&
  (cie.personality === null ||
    (encodingOk(cie.personality.encoding) &&
      personalityIndirectOk(cie.personality)));

/**
 * Only an indirect encoding yields an indirect personality, but a raw zero is
 * a null pointer the decoder never dereferences, so it stays direct.
 */
const personalityIndirectOk = (
  personality: NonNullable<ElfUnwindRanges["cies"][number]["personality"]>,
): boolean => {
  const indirectEncoding = (personality.encoding.raw & 0x80) !== 0;
  return personality.indirect
    ? indirectEncoding
    : !indirectEncoding || personality.address === "0x0";
};

/** `end` is `start + size` wrapped at the ELF address width, as libgcc computes it. */
const addressSpan = (
  bits: 32 | 64,
  start: string,
  end: string,
  size: string,
): boolean => {
  const length = BigInt(size);
  return (
    length < 1n << BigInt(bits) &&
    BigInt(end) === BigInt.asUintN(bits, BigInt(start) + length)
  );
};

const rangeOk = (report: ElfUnwindRanges): boolean => {
  const byIndex = new Map(report.cies.map((cie) => [cie.index, cie]));
  return report.ranges.every((range, position) => {
    const cie = byIndex.get(range.cie_index);
    if (cie === undefined || range.index !== report.page.offset + position)
      return false;
    if (
      !addressSpan(
        report.format === "elf32" ? 32 : 64,
        range.start,
        range.end,
        range.size,
      )
    )
      return false;
    if (cie.personality === null)
      return range.personality === null && lsdaOk(cie, range);
    return (
      range.personality !== null &&
      range.personality.address === cie.personality.address &&
      range.personality.indirect === cie.personality.indirect &&
      lsdaOk(cie, range)
    );
  });
};

const lsdaOk = (
  cie: ElfUnwindRanges["cies"][number],
  range: ElfUnwindRanges["ranges"][number],
): boolean => {
  // A CIE with an LSDA encoding still admits a zero (null) LSDA per FDE.
  const encoding = cie.lsda_encoding;
  return range.lsda === null || (encoding !== null && encoding.raw !== 0xff);
};

const pageOk = (report: ElfUnwindRanges): boolean => {
  const { page, coverage, ranges } = report;
  if (
    page.total !== coverage.total_ranges ||
    page.returned !== ranges.length ||
    page.returned > page.limit
  )
    return false;
  const available = page.offset >= page.total ? 0 : page.total - page.offset;
  if (page.returned !== Math.min(page.limit, available)) return false;
  const end = page.offset + page.returned;
  if (page.returned === 0)
    return page.offset >= page.total && page.next_offset === null;
  if (end > page.total) return false;
  return page.next_offset === (end >= page.total ? null : end);
};

const coverageOk = (report: ElfUnwindRanges, maxRanges: number): boolean => {
  const { coverage, cies, ranges } = report;
  const pageSymbols = ranges.filter((range) => range.symbol !== null).length;
  if (
    coverage.ranges_with_symbols + coverage.ranges_without_symbols !==
      coverage.total_ranges ||
    coverage.ranges_with_symbols > coverage.total_ranges ||
    cies.length > ranges.length ||
    coverage.total_cies > maxRanges ||
    coverage.total_ranges > maxRanges ||
    coverage.examined_records > maxRanges * 2 ||
    coverage.examined_records < coverage.total_cies + coverage.total_ranges ||
    pageSymbols > coverage.ranges_with_symbols ||
    ranges.length - pageSymbols > coverage.ranges_without_symbols
  )
    return false;
  if (report.page.offset === 0 && report.page.returned === report.page.total)
    return pageSymbols === coverage.ranges_with_symbols;
  return true;
};

const indirectVisible = (report: ElfUnwindRanges): boolean =>
  report.cies.some((cie) => cie.personality?.indirect === true) ||
  report.ranges.some(
    (range) =>
      range.lsda?.indirect === true || range.personality?.indirect === true,
  );

const validReport = (
  report: ElfUnwindRanges,
  maxRanges: number,
  maxBytes: number,
  offset: number,
  limit: number,
): boolean => {
  if (maxRanges > MAX_INSPECT_ELF_UNWIND_RANGES) return false;
  if (
    report.artifact.bytes > maxBytes ||
    report.type_name !== elfObjectTypeName(report.type) ||
    report.page.offset !== offset ||
    report.page.limit !== limit ||
    !rangesOf(report).every(inside(report.artifact.bytes)) ||
    !has(report, CFA_LIMITATION) ||
    !has(report, UNTRUSTED_LIMITATION) ||
    (indirectVisible(report) && !has(report, INDIRECT_LIMITATION))
  )
    return false;
  return (
    frameOk(report) &&
    headerOk(report, maxRanges) &&
    debugOk(report) &&
    cieOk(report) &&
    rangeOk(report) &&
    pageOk(report) &&
    coverageOk(report, maxRanges)
  );
};
