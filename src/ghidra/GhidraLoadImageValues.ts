import { createHash } from "node:crypto";
import {
  nativeLoadImageSchema,
  type NativeLoadImage,
  type NativeLoadImageObservation,
} from "../domain/nativeLoadImage.js";
import { parseDosMzHeader, type DosMzHeader } from "../domain/dosMz.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";

const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
const address = (offset: number): string => `0x${offset.toString(16)}`;
const limitations = [
  "Verification covers original/modified FileBytes, every initialized target-backed header/module mapping, relocation records and the external entry point. Mapping ends are inclusive.",
  "Appended overlay bytes are identified by file extent and included in FileBytes identity; they must not be mapped as initialized header/module memory. Uninitialized allocations are reported but their contents and DOS runtime behavior are not verified.",
  "The fixed load segment 0x1000 describes Ghidra's analysis image, not a running DOS process. Verified import does not establish original source ownership or recovered program behavior.",
  "A mismatching memory digest identifies the reported source range; it does not locate the first differing byte inside that range.",
];

/** Verify measured MZ import state against the session's immutable snapshot. */
export const attestGhidraDosLoadImage = (
  bytes: Buffer,
  targetSha256: string,
  observations: NativeLoadImageObservation,
): Result<NativeLoadImage, string> => {
  if (sha256(bytes) !== targetSha256)
    return err(
      "Ghidra load-image snapshot digest does not match the admitted target",
    );
  const parsed = parseDosMzHeader(bytes);
  if (!parsed.ok) return parsed;
  const header = parsed.value;
  const loadSegment = 0x1000;
  const modified = Buffer.from(bytes);
  const expectedRelocations = [];
  for (let index = 0; index < header.relocationCount; index += 1) {
    const table = header.relocationTableOffset + index * 4;
    const offset = bytes.readUInt16LE(table);
    const segment = bytes.readUInt16LE(table + 2);
    const fileOffset = header.headerBytes + segment * 16 + offset;
    const original = modified
      .subarray(fileOffset, fileOffset + 2)
      .toString("hex");
    const relocated =
      (modified.readUInt16LE(fileOffset) + loadSegment) & 0xffff;
    modified.writeUInt16LE(relocated, fileOffset);
    expectedRelocations.push({
      address: address(loadSegment * 16 + segment * 16 + offset),
      segment: (loadSegment + segment) & 0xffff,
      offset,
      status: "APPLIED",
      type: 0,
      values: [segment, offset, relocated],
      original_bytes_hex: original,
      memory_bytes_hex: modified
        .subarray(fileOffset, fileOffset + 2)
        .toString("hex"),
    });
  }
  const checks: Extract<NativeLoadImage, { format: "dos-mz" }>["checks"] = [];
  const check = (
    name: string,
    expected: JsonValue,
    observed: JsonValue,
    fileOffset: number | null = null,
    location: string | null = null,
  ): void => {
    checks.push({
      name,
      matched: JSON.stringify(expected) === JSON.stringify(observed),
      expected,
      observed,
      file_offset: fileOffset,
      address: location,
    });
  };
  check(
    "executable_format",
    "Old-style DOS Executable (MZ)",
    observations.executable_format,
  );
  check("language_id", "x86:LE:16:Real Mode", observations.language_id);
  check("compiler_spec_id", "default", observations.compiler_spec_id);
  check("image_base", "0x0", observations.image_base);
  check("default_address_space", "ram", observations.default_address_space);
  check("source_file_count", 1, observations.source_files.length);
  const source = observations.source_files[0];
  check("source_file_size", bytes.length, source?.size ?? null);
  check("original_file_sha256", targetSha256, source?.original_sha256 ?? null);
  check(
    "modified_file_sha256",
    sha256(modified),
    source?.modified_sha256 ?? null,
  );
  const entryAddress = address(
    ((loadSegment + header.entrySegment) & 0xffff) * 16 + header.entryOffset,
  );
  check("entry_points", [entryAddress], [...observations.entry_points].sort());
  // A multiset preserves duplicate relocations and aliases; iteration order is not semantic.
  const rows = (values: NativeLoadImageObservation["relocations"]): string[] =>
    values
      .map(({ segment: _segment, offset: _offset, ...value }) =>
        JSON.stringify(value),
      )
      .sort();
  check(
    "relocation_address_aliases",
    [],
    observations.relocations.filter(
      (row) =>
        row.segment === null ||
        row.offset === null ||
        address(row.segment * 16 + row.offset) !== row.address,
    ),
  );
  check(
    "relocation_records",
    rows(expectedRelocations),
    rows(observations.relocations),
  );

  checkMappings(header, loadSegment, bytes, modified, observations, check);
  return ok(
    nativeLoadImageSchema.parse({
      status: checks.every((item) => item.matched) ? "verified" : "mismatch",
      format: "dos-mz",
      target_sha256: targetSha256,
      load_segment: loadSegment,
      header_bytes: header.headerBytes,
      module_bytes: header.moduleBytes,
      overlay_bytes: header.overlayBytes,
      entry: {
        relative_segment: header.entrySegment,
        offset: header.entryOffset,
        linear_address: entryAddress,
      },
      observations,
      checks,
      limitations,
    }),
  );
};

const checkMappings = (
  header: DosMzHeader,
  loadSegment: number,
  bytes: Buffer,
  modified: Buffer,
  observations: NativeLoadImageObservation,
  check: (
    name: string,
    expected: JsonValue,
    observed: JsonValue,
    fileOffset?: number | null,
    location?: string | null,
  ) => void,
): void => {
  const backed = observations.mappings.filter(
    (mapping) => mapping.source_file_index !== null,
  );
  const sorted = [...backed].sort(
    (left, right) => (left.file_offset ?? -1) - (right.file_offset ?? -1),
  );
  let covered = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const mapping = sorted[index];
    if (mapping === undefined) continue;
    const start = mapping.file_offset;
    const end = start === null ? null : start + mapping.length;
    const headerMapping =
      start !== null && end !== null && start >= 0 && end <= header.headerBytes;
    const moduleMapping =
      start !== null &&
      end !== null &&
      start >= header.headerBytes &&
      end <= header.imageBytes;
    const at = `mapping[${index}]`;
    check(
      `${at}.source_file_index`,
      0,
      mapping.source_file_index,
      start,
      mapping.start,
    );
    check(`${at}.file_coverage_start`, covered, start, start, mapping.start);
    check(
      `${at}.partition`,
      true,
      headerMapping || moduleMapping,
      start,
      mapping.start,
    );
    check(`${at}.initialized`, true, mapping.initialized, start, mapping.start);
    check(`${at}.loaded`, moduleMapping, mapping.loaded, start, mapping.start);
    check(
      `${at}.overlay`,
      headerMapping,
      mapping.overlay,
      start,
      mapping.start,
    );
    check(
      `${at}.address_space`,
      headerMapping ? "HEADER" : observations.default_address_space,
      mapping.address_space,
      start,
      mapping.start,
    );
    const expectedStart =
      start === null
        ? null
        : headerMapping
          ? `HEADER:${address(start)}`
          : address(loadSegment * 16 + start - header.headerBytes);
    const expectedEnd =
      start === null
        ? null
        : headerMapping
          ? `HEADER:${address(start + mapping.length - 1)}`
          : address(
              loadSegment * 16 +
                start -
                header.headerBytes +
                mapping.length -
                1,
            );
    check(`${at}.start`, expectedStart, mapping.start, start, mapping.start);
    check(`${at}.end`, expectedEnd, mapping.end, start, mapping.end);
    check(
      `${at}.memory_sha256`,
      start !== null && end !== null && end <= bytes.length
        ? sha256(modified.subarray(start, end))
        : null,
      mapping.sha256,
      start,
      mapping.start,
    );
    covered = end ?? covered;
  }
  check("initialized_file_coverage_end", header.imageBytes, covered);
  check(
    "initialized_unbacked_mappings",
    [],
    observations.mappings.filter(
      (mapping) => mapping.initialized && mapping.source_file_index === null,
    ),
  );
};
