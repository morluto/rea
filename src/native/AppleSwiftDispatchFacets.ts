import type { ObjcSwiftMetadata } from "../domain/native/objcSwiftMetadata.js";
import type { Segment, Section } from "./AppleMachoSelection.js";

/** Resolved file-backed metadata location from the Mach-O layout. */
export interface ResolvedMetadataLocation {
  address: string;
  file_offset: number;
}

/** Binary-metadata evidence produced by the Apple dispatch readers. */
export type BinaryMetadataEvidence = {
  kind: "binary_metadata";
  description: string;
  location: ResolvedMetadataLocation;
  artifact_path: string;
  artifact_sha256: string;
}[];

/** Shared admission budget for max_records truncation across decode facets. */
export interface DispatchRecordBudget {
  truncated: boolean;
  isFull(): boolean;
  markTruncated(): void;
  admit(): boolean;
}

/** Byte readers for Swift relative-pointer and conformance decode facets. */
export interface SwiftDispatchReaders {
  u32(address: bigint): number;
  pointer(address: bigint): bigint;
  string(address: bigint): string;
  location(address: bigint): ResolvedMetadataLocation;
  evidence(address: bigint, description: string): BinaryMetadataEvidence;
  offset(address: bigint, size?: number): number;
}

const hex = (value: bigint) => `0x${value.toString(16)}`;
const decoded = { status: "decoded" as const, reason: null };

/** Create a Swift ABI signed-relative pointer decoder that records relative_pointers. */
export const createSwiftRelativeReader = (input: {
  bytes: Buffer;
  readers: SwiftDispatchReaders;
  budget: DispatchRecordBudget;
  result: ObjcSwiftMetadata;
}) => {
  const { bytes, readers: read, budget, result } = input;
  return (field: bigint, indirectable = false): bigint => {
    const displacement = bytes.readInt32LE(read.offset(field, 4));
    const indirect = indirectable && (displacement & 1) !== 0;
    let target =
      displacement === 0
        ? 0n
        : field + BigInt(indirectable ? displacement & ~1 : displacement);
    let fileOffset: number | null = null;
    let reason: string | null = null;
    try {
      if (indirect && target !== 0n) target = read.pointer(target);
      if (target !== 0n) fileOffset = read.offset(target);
    } catch (cause) {
      reason = cause instanceof Error ? cause.message : String(cause);
    }
    if (budget.admit())
      result.relative_pointers.push({
        field: read.location(field),
        target: {
          address: target === 0n ? null : hex(target),
          file_offset: fileOffset,
        },
        displacement,
        indirectable,
        indirect,
        decode: reason === null ? decoded : { status: "partial", reason },
        evidence: read.evidence(
          field,
          "Swift ABI signed-relative metadata pointer",
        ),
      });
    if (reason !== null) throw new RangeError(reason);
    return target;
  };
};

/** Decode `__swift5_proto` conformances and static witness slots into `result`. */
export const decodeSwiftDispatchFacets = (input: {
  sections: readonly Section[];
  segments: readonly Segment[];
  readers: SwiftDispatchReaders;
  relative: (field: bigint, indirectable?: boolean) => bigint;
  budget: DispatchRecordBudget;
  result: ObjcSwiftMetadata;
}): void => {
  const { sections, segments, readers: read, relative, budget, result } = input;
  const swiftFailures: string[] = [];
  let swiftExamined = 0;
  for (const section of sections.filter(
    ({ name }) => name === "__swift5_proto",
  )) {
    if (section.size % 4 !== 0)
      throw new RangeError("Misaligned Swift conformance section");
    for (let index = 0; index < section.size / 4; index++) {
      if (!budget.admit()) break;
      swiftExamined++;
      const field = section.address + BigInt(index * 4);
      try {
        const descriptor = relative(field);
        const flags = read.u32(descriptor + 12n);
        const protocol = relative(descriptor, true);
        if ((read.u32(protocol) & 31) !== 3)
          throw new TypeError("Unsupported Swift protocol descriptor kind");
        const protocolName = read.string(relative(protocol + 8n));
        const typeKind = (flags >>> 3) & 7;
        if (typeKind !== 0 && typeKind !== 1)
          throw new TypeError(
            "Unsupported Swift conformance type-reference kind",
          );
        let type = relative(descriptor + 4n);
        if (typeKind === 1) type = read.pointer(type);
        if (![16, 17, 18].includes(read.u32(type) & 31))
          throw new TypeError("Unsupported Swift type descriptor kind");
        const typeName = read.string(relative(type + 8n));
        const witness = relative(descriptor + 8n);
        const staticWitness =
          witness !== 0n &&
          (flags & ~0x38) === 0 &&
          (read.u32(type) & 0x80) === 0;
        let witnessReason: string | null = staticWitness
          ? null
          : "Conditional, generic, resilient or missing static witness table is not decoded";
        if (staticWitness && read.pointer(witness) !== descriptor)
          witnessReason =
            "Witness-table conformance header is unresolved or encoded";
        result.swift_conformances.push({
          type_name: typeName,
          protocol_name: protocolName,
          module: null,
          witness_table:
            witness === 0n
              ? { address: null, file_offset: null }
              : read.location(witness),
          location: read.location(descriptor),
          decode:
            witnessReason === null
              ? decoded
              : {
                  status: "partial",
                  reason: witnessReason,
                },
          evidence: read.evidence(
            descriptor,
            "Swift protocol conformance descriptor and directly encoded type/protocol names",
          ),
        });
        if (witnessReason !== null) {
          swiftFailures.push(`${typeName}: ${witnessReason}`);
          continue;
        }
        const count = read.u32(protocol + 16n);
        const signatureCount = read.u32(protocol + 12n);
        if (count > 20_000 || signatureCount > 20_000)
          throw new RangeError("Swift witness requirement count exceeds 20000");
        for (let slot = 0; slot < count; slot++) {
          if (!budget.admit()) break;
          const entry = witness + BigInt((slot + 1) * 8);
          const implementation = read.pointer(entry);
          const requirementFlags = read.u32(
            protocol + 24n + BigInt(signatureCount * 12 + slot * 8),
          );
          const kind = requirementFlags & 15;
          const synchronousFunction =
            kind >= 1 && kind <= 4 && (requirementFlags & 0x20) === 0;
          const executable =
            synchronousFunction &&
            segments.some(
              (segment) =>
                segment.executable &&
                implementation >= segment.address &&
                implementation < segment.address + segment.size,
            );
          result.swift_dispatch_slots.push({
            owner: `${typeName}: ${protocolName}`,
            table_kind: "witness_table",
            slot_index: slot + 1,
            requirement: null,
            implementation: null,
            implementation_address: executable ? hex(implementation) : null,
            thunk_address: null,
            location: read.location(entry),
            decode: executable
              ? decoded
              : {
                  status: "partial",
                  reason:
                    "Witness slot is non-function, async, nil, external, authenticated or encoded; implementation target is unresolved",
                },
            evidence: read.evidence(
              entry,
              "Static Swift witness slot, indexed after the conformance-descriptor header",
            ),
          });
        }
      } catch (cause) {
        swiftFailures.push(
          `${hex(field)}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
  }
  result.coverage.push({
    facet: "swift_conformances_static_witness_slots",
    status:
      swiftFailures.length > 0 || budget.truncated ? "partial" : "complete",
    reason:
      [
        ...swiftFailures,
        ...(budget.truncated ? ["max_records_reached"] : []),
      ].join("; ") || null,
    examined: swiftExamined,
    decoded: result.swift_conformances.length,
  });
};
