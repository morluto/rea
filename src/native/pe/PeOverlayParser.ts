import {
  createXmlPlistSignatureProbe,
  MAX_XML_PLIST_PROBE_BYTES,
} from "../../domain/apple/appleArchiveFormat.js";
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
import {
  readPeImage,
  type PeImageSection,
} from "../../domain/native/peImage.js";
import { requirePeExtent } from "../../domain/pe/peImageHeaders.js";
import { sha256Hex } from "../../kernel/sha256Hex.js";

/** The same bounded XML signature probe artifact inventory runs. */
const hasXmlPlistSignature = (bytes: Buffer): boolean => {
  const probe = createXmlPlistSignatureProbe();
  probe.write(bytes.subarray(0, MAX_XML_PLIST_PROBE_BYTES));
  return probe.state === "matched";
};

const recognizeLeadingFormat = (bytes: Buffer): PeOverlayLeadingFormat => {
  const format = recognizeBoundedArtifactFormat({
    prefix: bytes.subarray(0, PE_OVERLAY_ENTROPY_WINDOW_BYTES),
    fileSize: bytes.length,
    suffix: bytes.subarray(Math.max(0, bytes.length - DFUSE_SUFFIX_BYTES)),
    xmlPlistSignature: hasXmlPlistSignature(bytes),
  });
  // The overlay samples 4 KiB. ISO 9660 recognition requires a sector 16 probe.
  return format === "iso9660" ? "unrecognized" : (format ?? "unrecognized");
};

/** Project the shared PE owner's declared section facts onto overlay inputs. */
function* overlaySections(
  sections: readonly PeImageSection[],
): Generator<PeOverlaySectionInput, void, undefined> {
  for (const [index, section] of sections.entries())
    yield {
      index,
      name: section.name,
      pointerToRawData: section.raw_offset,
      sizeOfRawData: section.raw_size,
      characteristics: section.characteristics,
    };
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
  requirePeExtent(bytes.length, range.offset, range.size);
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
  // Header admission only: section raw ranges are checked by computePeOverlay,
  // which names the section whose bytes leave the artifact.
  const image = readPeImage(bytes, "headers");
  const facts: PeOverlayHeaderFacts = {
    sizeOfHeaders: image.pe_size_of_headers,
    sectionAlignment: image.pe_section_alignment,
    fileAlignment: image.pe_file_alignment,
    sections: overlaySections(image.sections),
  };
  const layout = computePeOverlay(
    facts,
    bytes.length,
    image.pe_data_directories[4],
  );
  return {
    artifact,
    format: image.bits === 64 ? "pe32-plus" : "pe32",
    machine: image.pe_machine,
    size_of_headers: layout.size_of_headers,
    image_end: layout.image_end,
    file_size: layout.file_size,
    present: layout.present,
    raw_pointer_rounding: layout.raw_pointer_rounding,
    sections: layout.sections,
    section_coverage: layout.section_coverage,
    security_directory: layout.security_directory,
    ranges: layout.ranges.map((range) => describeRange(bytes, range)),
    header_anomalies: [...image.pe_header_anomalies],
    limitations: [...layout.limitations],
  };
};
