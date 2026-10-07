import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import {
  objcSwiftMetadataSchema,
  nativeDispatchMetadataResultSchema,
  type ObjcSwiftMetadata,
} from "../domain/objcSwiftMetadata.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { EvidenceIntegrityError } from "../domain/evidenceErrors.js";
import { parseMachoLayout } from "./AppleMachoSelection.js";
import { decodeObjcDispatchFacets } from "./AppleObjcDispatchFacets.js";
import {
  createSwiftRelativeReader,
  decodeSwiftDispatchFacets,
  type DispatchRecordBudget,
} from "./AppleSwiftDispatchFacets.js";
import { decodeSwiftClassVtables } from "./AppleSwiftVtables.js";

/** Decode validated little-endian 64-bit Apple Objective-C metadata without loading target code. */
export const decodeAppleDispatchMetadata = (
  bytes: Buffer,
  maxRecords: number,
  provenance: { path: string; sha256: string },
  architecture = "arm64",
): ObjcSwiftMetadata => {
  const { segments, sections, offset } = parseMachoLayout(bytes, architecture);
  const u32 = (address: bigint) => bytes.readUInt32LE(offset(address, 4));
  const pointer = (address: bigint) =>
    bytes.readBigUInt64LE(offset(address, 8));
  const location = (address: bigint) => ({
    address: `0x${address.toString(16)}`,
    file_offset: offset(address),
  });
  const evidence = (address: bigint, description: string) => [
    {
      kind: "binary_metadata" as const,
      description,
      location: location(address),
      artifact_path: provenance.path,
      artifact_sha256: provenance.sha256,
    },
  ];
  const string = (address: bigint) => {
    const start = offset(address);
    let end = start;
    while (end < bytes.length && end - start < 4096 && bytes[end] !== 0) end++;
    if (end === bytes.length || end - start >= 4096)
      throw new RangeError("Unterminated or oversized metadata string");
    offset(address, end - start + 1);
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(start, end),
    );
  };
  const result = objcSwiftMetadataSchema.parse({ db_save_result: null });
  let records = 0;
  const budget: DispatchRecordBudget = {
    truncated: false,
    isFull: () => records >= maxRecords,
    markTruncated: () => {
      budget.truncated = true;
    },
    admit: () => {
      if (records >= maxRecords) {
        budget.truncated = true;
        return false;
      }
      records++;
      return true;
    },
  };
  const readers = {
    u32,
    i32: (address: bigint) => bytes.readInt32LE(offset(address, 4)),
    pointer,
    string,
    location,
    evidence,
    offset,
  };
  const { failures, examined } = decodeObjcDispatchFacets({
    bytes,
    sections,
    segments,
    readers,
    budget,
    result,
  });
  const swiftRelative = createSwiftRelativeReader({
    bytes,
    readers,
    budget,
    result,
  });
  decodeSwiftDispatchFacets({
    sections,
    segments,
    readers,
    relative: swiftRelative,
    budget,
    result,
  });
  const typeEntries: bigint[] = [];
  for (const section of sections.filter(
    ({ name }) => name === "__swift5_types",
  )) {
    if (section.size % 4 !== 0)
      throw new RangeError("Misaligned Swift type section");
    for (let index = 0; index < section.size / 4 && index < maxRecords; index++)
      typeEntries.push(section.address + BigInt(index * 4));
    if (section.size / 4 > maxRecords) budget.truncated = true;
  }
  decodeSwiftClassVtables({
    entries: typeEntries,
    result,
    readers: {
      u32,
      relative: swiftRelative,
      string,
      location,
      evidence,
      admit: () => budget.admit(),
      executable: (address) =>
        segments.some(
          (segment) =>
            segment.executable &&
            address >= segment.address &&
            address < segment.address + segment.size,
        ),
    },
  });
  result.coverage.push({
    facet: "objc_class_method_ivar_metadata",
    status: failures.length > 0 || budget.truncated ? "partial" : "complete",
    reason:
      [...failures, ...(budget.truncated ? ["max_records_reached"] : [])].join(
        "; ",
      ) || null,
    examined,
    decoded: result.objc_classes.length,
  });
  result.coverage.push({
    facet: "binary_relative_pointers",
    status:
      budget.truncated ||
      result.relative_pointers.some((item) => item.decode.status !== "decoded")
        ? "partial"
        : "complete",
    reason: budget.truncated
      ? "max_records_reached"
      : result.relative_pointers.some(
            (item) => item.decode.status !== "decoded",
          )
        ? "relative_pointer_targets_unresolved"
        : null,
    examined: result.relative_pointers.length,
    decoded: result.relative_pointers.filter(
      (item) => item.decode.status === "decoded",
    ).length,
  });
  for (const facet of [
    "objc_properties_categories",
    "swift_generic_resilient_witnesses_overrides_async_coroutines",
  ])
    result.coverage.push({
      facet,
      status: "unsupported",
      reason:
        "This reader admits validated 64-bit Objective-C class/ivar/method lists and simple Swift conformance/static witness records; chained fixups, generic/resilient tables and other metadata families are not decoded",
      examined: 0,
      decoded: 0,
    });
  return objcSwiftMetadataSchema.parse(result);
};

/** Read digest-verified target bytes under a 64 MiB static metadata budget. */
export const inspectAppleDispatchMetadata = async (
  target: BinaryTarget,
  maxRecords: number,
  signal?: AbortSignal,
) => {
  if (target.kind !== "executable" || target.format !== "mach-o")
    throw new TypeError("Apple dispatch metadata requires a Mach-O target");
  const handle = await open(
    target.path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 64 * 1024 * 1024)
      throw new RangeError(
        "Apple metadata target must be a regular file no larger than 64 MiB",
      );
    if (signal?.aborted)
      throw new AnalysisCancelledError("inspect_native_dispatch_metadata");
    const bytes = await handle.readFile({ signal });
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== target.sha256)
      throw new EvidenceIntegrityError(
        "Apple metadata target digest changed after session binding",
      );
    return nativeDispatchMetadataResultSchema.parse({
      target_sha256: target.sha256,
      provider: {
        id: "native-macos",
        name: "macOS native inspection utilities",
        version: "apple-metadata-reader-1",
      },
      analysis_profile_digest: null,
      result: decodeAppleDispatchMetadata(
        bytes,
        maxRecords,
        { path: target.path, sha256: digest },
        target.architecture,
      ),
    });
  } finally {
    await handle.close();
  }
};
