import { IL2CPP_METADATA_SECTION_NAMES } from "../domain/il2cpp/il2cppMetadata.js";
import { observeIl2cppMetadataHeaderPrefix } from "../domain/il2cpp/il2cppMetadataHeaderPrefix.js";
import { Il2cppMetadataFormatFailure } from "./Il2cppMetadataFormat.js";

// Header order follows LibCpp2IL's Il2CppGlobalMetadataHeader (v108):
// https://github.com/SamboyCoding/Cpp2IL/blob/development/LibCpp2IL/Metadata/Il2CppGlobalMetadataHeader.cs
// Record layouts and native registration are deliberately outside this observation.
const SECTION_NAMES = [
  ...IL2CPP_METADATA_SECTION_NAMES.slice(0, 20),
  "typeInlineArrays",
  ...IL2CPP_METADATA_SECTION_NAMES.slice(20),
  "methodSpecsOnGenericType",
  "genericMethodSpecsOnType",
  "methodSpecs",
  "genericMethodFunctionsDefinitions",
  "genericMethodFunctionsDefinitionsWithAdjustor",
  "invokerIndices",
  "rgctxRanges",
  "rgctxValues",
  "staticConstructorTypeIndices",
] as const;
const HEADER_BYTES = 8 + SECTION_NAMES.length * 12;
const SAMPLE_STRINGS = 16;
const SAMPLE_BYTES = 128;
const SCAN_BATCH_BYTES = 64 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A bounded, header-only observation; never a decoded metadata report. */
export const inspectIl2cppMetadataV108 = async (
  bytes: Buffer,
  afterBatch?: () => Promise<void>,
) => {
  const prefix = observeIl2cppMetadataHeaderPrefix(bytes);
  if (prefix.kind !== "il2cpp" || prefix.version !== 108) return null;
  if (bytes.length < HEADER_BYTES)
    throw new Il2cppMetadataFormatFailure(
      "unsupported-version",
      `version 108 layout is unverified; the file has ${bytes.length} bytes, fewer than the assumed ${HEADER_BYTES}-byte header`,
    );
  const sections = SECTION_NAMES.map((name, index) => {
    const at = 8 + index * 12;
    return {
      name,
      offset: bytes.readInt32LE(at),
      size: bytes.readInt32LE(at + 4),
      count: bytes.readInt32LE(at + 8),
    };
  });
  for (const section of sections) {
    if (
      section.offset < 0 ||
      section.size < 0 ||
      section.count < 0 ||
      section.offset + section.size > bytes.length ||
      (section.size > 0 && section.offset < HEADER_BYTES)
    )
      throw new Il2cppMetadataFormatFailure(
        "unsupported-version",
        `version 108 layout is unverified; assumed section ${section.name} (offset ${section.offset}, size ${section.size}, count ${section.count}) is invalid for the ${bytes.length}-byte file`,
      );
  }
  const occupied = sections
    .filter((section) => section.size > 0)
    .sort((a, b) => a.offset - b.offset);
  for (let index = 1; index < occupied.length; index++) {
    const previous = occupied[index - 1]!;
    const current = occupied[index]!;
    if (previous.offset + previous.size > current.offset)
      throw new Il2cppMetadataFormatFailure(
        "unsupported-version",
        `version 108 layout is unverified; assumed sections ${previous.name} and ${current.name} overlap at ${current.offset}`,
      );
  }
  const strings = sections[2]!;
  const end = strings.offset + strings.size;
  const sample: Array<{
    offset: number;
    value: string | null;
    value_base64: string | null;
    truncated: boolean;
  }> = [];
  let start = strings.offset;
  let terminatedCount = 0;
  for (let batch = start; batch < end; batch += SCAN_BATCH_BYTES) {
    const batchEnd = Math.min(end, batch + SCAN_BATCH_BYTES);
    for (let at = batch; at < batchEnd; at++) {
      if (bytes[at] !== 0) continue;
      terminatedCount++;
      if (sample.length < SAMPLE_STRINGS) {
        const length = at - start;
        const raw = bytes.subarray(
          start,
          start + Math.min(length, SAMPLE_BYTES),
        );
        let value: string | null;
        try {
          value = utf8.decode(raw);
        } catch {
          value = null;
        }
        sample.push({
          offset: start - strings.offset,
          value,
          value_base64: value === null ? raw.toString("base64") : null,
          truncated: length > SAMPLE_BYTES,
        });
      }
      start = at + 1;
    }
    await afterBatch?.();
  }
  return {
    magic: prefix.magic,
    metadata_version: 108,
    header_bytes: HEADER_BYTES,
    layout_status: "unverified-with-real-v108-artifact",
    sections,
    strings: {
      terminated_count: terminatedCount,
      unterminated_tail_bytes: end - start,
      sample,
      sample_limit: SAMPLE_STRINGS,
      sample_bytes_per_string: SAMPLE_BYTES,
    },
    coverage: "header-and-bounded-string-sample-only",
  } as const;
};
