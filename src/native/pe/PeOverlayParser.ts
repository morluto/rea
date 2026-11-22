import { recognizeBoundedArtifactFormat } from "../../domain/artifactFormatRecognition.js";
import { DFUSE_SUFFIX_BYTES } from "../../domain/firmware/dfuse.js";
import { computeBlockEntropy } from "../../domain/native/byteEntropy.js";
import {
  computePeOverlay,
  PE_OVERLAY_ENTROPY_WINDOW_BYTES,
  PE_OVERLAY_PREFIX_BYTES,
  type PeOverlay,
  type PeOverlayHeaderFacts,
  type PeOverlayLayoutRange,
  type PeOverlayLeadingFormat,
  type PeOverlaySectionInput,
} from "../../domain/native/peOverlay.js";
import { malformedInput } from "../../domain/parseFailure.js";
import {
  readPeImageHeaders,
  requirePeRange,
} from "../../domain/pe/peImageHeaders.js";
import {
  PE_SECTION_HEADER_BYTES,
  readPeSectionHeader,
} from "../../domain/peSectionHeader.js";
import { sha256Hex } from "../../kernel/sha256Hex.js";

const recognizeLeadingFormat = (bytes: Buffer): PeOverlayLeadingFormat =>
  recognizeBoundedArtifactFormat({
    prefix: bytes.subarray(0, PE_OVERLAY_ENTROPY_WINDOW_BYTES),
    fileSize: bytes.length,
    suffix: bytes.subarray(Math.max(0, bytes.length - DFUSE_SUFFIX_BYTES)),
  }) ?? "unrecognized";

/**
 * Decode the section table one header at a time. computePeOverlay validates
 * every yielded section but keeps only the reported rows, so a table that
 * declares 65,535 sections never holds 65,535 records at once.
 */
function* readSections(
  sectionTable: Buffer,
): Generator<PeOverlaySectionInput, void, undefined> {
  for (
    let index = 0;
    index < sectionTable.length;
    index += PE_SECTION_HEADER_BYTES
  ) {
    const sectionIndex = index / PE_SECTION_HEADER_BYTES;
    const header = readPeSectionHeader(
      sectionTable.subarray(index, index + PE_SECTION_HEADER_BYTES),
    );
    if (!header.ok)
      throw malformedInput("pe", header.error.message, {
        field: `section[${String(sectionIndex)}]`,
      });
    yield {
      index: sectionIndex,
      name: header.value.name,
      pointerToRawData: header.value.offset,
      sizeOfRawData: header.value.raw_size,
      characteristics: header.value.characteristics,
    };
  }
}

const describeRange = (
  bytes: Buffer,
  range: PeOverlayLayoutRange,
): PeOverlay["ranges"][number] => {
  if (range.role === "certificate_table")
    return {
      role: "certificate_table",
      offset: range.offset,
      size: range.size,
    };
  requirePeRange(bytes, range.offset, range.size);
  const slice = bytes.subarray(range.offset, range.offset + range.size);
  const sampled = slice.subarray(
    0,
    Math.min(slice.length, PE_OVERLAY_ENTROPY_WINDOW_BYTES),
  );
  const prefix = slice.subarray(
    0,
    Math.min(slice.length, PE_OVERLAY_PREFIX_BYTES),
  );
  return {
    role: "other",
    offset: range.offset,
    size: range.size,
    sha256: sha256Hex(slice),
    entropy: {
      window_bytes: PE_OVERLAY_ENTROPY_WINDOW_BYTES,
      sampled_bytes: sampled.length,
      shannon_bits: computeBlockEntropy(sampled),
    },
    prefix_hex: prefix.toString("hex"),
    leading_format: recognizeLeadingFormat(slice),
  };
};

/**
 * Report where one PE image ends on disk and which bytes follow it.
 * Layout and extent checks belong to computePeOverlay; this parser only
 * guards the byte slices it measures. Hashes and entropy cover
 * non-certificate ranges only.
 */
export const parsePeOverlay = (
  bytes: Buffer,
  artifact: PeOverlay["artifact"],
): PeOverlay => {
  const headers = readPeImageHeaders(bytes);
  const facts: PeOverlayHeaderFacts = {
    sizeOfHeaders: headers.headerSize,
    sectionAlignment: headers.sectionAlignment,
    fileAlignment: headers.fileAlignment,
    sections: readSections(headers.sectionTable),
  };
  const layout = computePeOverlay(
    facts,
    bytes.length,
    headers.dataDirectories[4],
  );
  return {
    artifact,
    format: headers.format,
    machine: headers.machine,
    size_of_headers: layout.size_of_headers,
    image_end: layout.image_end,
    file_size: layout.file_size,
    present: layout.present,
    raw_pointer_rounding: layout.raw_pointer_rounding,
    sections: layout.sections,
    section_coverage: layout.section_coverage,
    security_directory: layout.security_directory,
    ranges: layout.ranges.map((range) => describeRange(bytes, range)),
    limitations: [...layout.limitations],
  };
};
