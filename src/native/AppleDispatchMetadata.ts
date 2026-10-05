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
import { decodeSwiftClassVtables } from "./AppleSwiftVtables.js";
import { createObjcProtocolReader } from "./AppleObjcProtocols.js";

interface Segment {
  address: bigint;
  size: bigint;
  offset: number;
  executable: boolean;
}
interface Section {
  name: string;
  address: bigint;
  size: number;
}
const hex = (value: bigint) => `0x${value.toString(16)}`;
const decoded = { status: "decoded" as const, reason: null };

/** Decode validated little-endian 64-bit Apple Objective-C metadata without loading target code. */
export const decodeAppleDispatchMetadata = (
  bytes: Buffer,
  maxRecords: number,
  provenance: { path: string; sha256: string },
  architecture = "arm64",
): ObjcSwiftMetadata => {
  if (bytes.length < 4) throw new RangeError("Truncated Mach-O header");
  const { slice, sliceEnd } = selectMachoSlice(bytes, architecture);
  if (slice === 0 && sliceEnd === bytes.length && bytes.length < 32)
    throw new RangeError("Truncated Mach-O header");
  if (slice + 32 > sliceEnd || bytes.readUInt32LE(slice) !== 0xfeedfacf)
    throw new TypeError(
      "Only little-endian 64-bit Mach-O metadata is supported",
    );
  const commands = bytes.readUInt32LE(slice + 16);
  const commandEnd = slice + 32 + bytes.readUInt32LE(slice + 20);
  if (commands > 4096 || commandEnd > sliceEnd)
    throw new RangeError("Malformed Mach-O command bounds");
  const segments: Segment[] = [];
  const sections: Section[] = [];
  let cursor = slice + 32;
  for (let index = 0; index < commands; index++) {
    if (cursor + 8 > commandEnd) throw new RangeError("Truncated load command");
    const kind = bytes.readUInt32LE(cursor),
      size = bytes.readUInt32LE(cursor + 4);
    if (size < 8 || cursor + size > commandEnd)
      throw new RangeError("Invalid load command size");
    if (kind === 0x19) {
      if (size < 72) throw new RangeError("Truncated segment command");
      const address = bytes.readBigUInt64LE(cursor + 24),
        fileSize = bytes.readBigUInt64LE(cursor + 48),
        fileOffset = bytes.readBigUInt64LE(cursor + 40);
      if (fileOffset + fileSize > BigInt(sliceEnd - slice))
        throw new RangeError("Segment file range exceeds target bytes");
      segments.push({
        address,
        size: fileSize,
        offset: slice + Number(fileOffset),
        executable: (bytes.readUInt32LE(cursor + 60) & 4) !== 0,
      });
      const count = bytes.readUInt32LE(cursor + 64);
      if (72 + count * 80 > size)
        throw new RangeError("Truncated section table");
      for (let section = 0; section < count; section++) {
        const position = cursor + 72 + section * 80;
        const sectionSize = bytes.readBigUInt64LE(position + 40);
        if (sectionSize > BigInt(Number.MAX_SAFE_INTEGER))
          throw new RangeError("Section size exceeds exact numeric range");
        sections.push({
          name: bytes
            .subarray(position, position + 16)
            .toString("ascii")
            .replace(/\0.*$/u, ""),
          address: bytes.readBigUInt64LE(position + 32),
          size: Number(sectionSize),
        });
      }
    }
    cursor += size;
  }
  const offset = (address: bigint, size = 1): number => {
    const matches = segments.filter(
      (segment) =>
        address >= segment.address &&
        address + BigInt(size) <= segment.address + segment.size,
    );
    if (matches.length !== 1)
      throw new RangeError(
        `Unmapped or ambiguous metadata pointer ${hex(address)}`,
      );
    const segment = matches[0];
    if (segment === undefined) throw new RangeError("Missing metadata segment");
    return segment.offset + Number(address - segment.address);
  };
  const u32 = (address: bigint) => bytes.readUInt32LE(offset(address, 4));
  const pointer = (address: bigint) =>
    bytes.readBigUInt64LE(offset(address, 8));
  const location = (address: bigint) => ({
    address: hex(address),
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
  const failures: string[] = [];
  let records = 0,
    examined = 0,
    truncated = false;
  const admit = () => {
    if (records >= maxRecords) {
      truncated = true;
      return false;
    }
    records++;
    return true;
  };
  const methods = (
    list: bigint,
    className: string,
    methodType: "instance" | "class",
  ) => {
    if (list === 0n) return;
    const flags = u32(list),
      count = u32(list + 4n),
      relative = (flags & 0x80000000) !== 0;
    const stride = flags & 0xfffc;
    if (stride !== (relative ? 12 : 24))
      throw new TypeError(`Unsupported method stride/flags at ${hex(list)}`);
    for (let index = 0; index < count; index++) {
      if (!admit()) break;
      const entry = list + 8n + BigInt(index * stride);
      const rel = (field: bigint) => {
        const displacement = bytes.readInt32LE(offset(field, 4));
        const target = field + BigInt(displacement);
        let fileOffset: number | null = null;
        try {
          fileOffset = offset(target);
        } catch (cause: unknown) {
          // best-effort cleanup: serialized target remains unresolved.
          void cause;
        }
        if (admit())
          result.relative_pointers.push({
            field: location(field),
            target: { address: hex(target), file_offset: fileOffset },
            displacement,
            indirectable: false,
            indirect: false,
            decode:
              fileOffset === null
                ? { status: "partial", reason: "relative_target_unmapped" }
                : decoded,
            evidence: evidence(
              field,
              "Signed-relative Objective-C method-list pointer",
            ),
          });
        return target;
      };
      let selectorAddress = relative ? rel(entry) : pointer(entry);
      if (relative && (flags & 0x40000000) === 0)
        selectorAddress = pointer(selectorAddress);
      const implementation = relative ? rel(entry + 8n) : pointer(entry + 16n);
      let implementationLocation: {
        address: string;
        file_offset: number;
      } | null = null;
      try {
        if (
          !segments.some(
            (segment) =>
              segment.executable &&
              implementation >= segment.address &&
              implementation < segment.address + segment.size,
          )
        )
          throw new RangeError(
            "Method implementation is not in an executable segment",
          );
        implementationLocation = location(implementation);
      } catch (cause: unknown) {
        // best-effort cleanup: external/chained pointers remain unresolved.
        void cause;
      }
      result.objc_dispatch_implementations.push({
        class_name: className,
        selector: string(selectorAddress),
        method_type: methodType,
        implementation_address: implementationLocation?.address ?? null,
        location: location(entry),
        decode:
          implementationLocation === null
            ? {
                status: "partial",
                reason: "implementation_pointer_unmapped_or_encoded",
              }
            : decoded,
        evidence: evidence(
          entry,
          relative
            ? "Encoded relative Objective-C method entry"
            : "Encoded absolute Objective-C method entry",
        ),
      });
    }
  };
  const protocolReader = createObjcProtocolReader({
    readers: {
      u32,
      pointer,
      string,
      location,
      evidence,
      admit,
      i32: (address) => bytes.readInt32LE(offset(address, 4)),
    },
    result,
    failures,
  });
  for (const section of sections.filter(
    ({ name }) => name === "__objc_protolist",
  )) {
    if (section.size % 8 !== 0)
      throw new RangeError("Misaligned Objective-C protocol list");
    for (let index = 0; index < section.size / 8; index++) {
      if (records >= maxRecords) {
        truncated = true;
        break;
      }
      protocolReader.record(pointer(section.address + BigInt(index * 8)));
    }
  }
  const visited = new Set<string>();
  const readClass = (address: bigint, meta = false) => {
    if (address === 0n || visited.has(hex(address)) || !admit()) return;
    visited.add(hex(address));
    const ro = pointer(address + 32n) & ~7n;
    const name = string(pointer(ro + 24n));
    const superclass = pointer(address + 8n);
    const root = (u32(ro) & 2) !== 0;
    let superclassName: string | null = null;
    if (superclass !== 0n) {
      try {
        superclassName = string(
          pointer((pointer(superclass + 32n) & ~7n) + 24n),
        );
      } catch (cause: unknown) {
        // Superclass resolution failure is recorded; the cause adds no identity.
        void cause;
        failures.push(
          `Superclass pointer ${hex(superclass)} of ${name} requires unsupported binding/fixup resolution`,
        );
      }
    }
    if (superclass === 0n && !root)
      failures.push(
        `Superclass of ${name} requires external binding resolution`,
      );
    const ivarList = pointer(ro + 48n);
    let ivarCount = 0;
    if (ivarList !== 0n && !meta) {
      const stride = u32(ivarList),
        count = u32(ivarList + 4n);
      if (stride !== 32)
        throw new TypeError("Unsupported Objective-C ivar entry size");
      ivarCount = count;
      for (let index = 0; index < count; index++) {
        if (!admit()) break;
        const entry = ivarList + 8n + BigInt(index * stride);
        const encodedOffset = pointer(entry);
        let value: number | null = null;
        try {
          value = u32(encodedOffset);
        } catch (cause: unknown) {
          // Unresolved offsets are recorded; the cause adds no identity.
          void cause;
          failures.push(`Unresolved ivar offset pointer ${hex(encodedOffset)}`);
        }
        result.objc_ivars.push({
          class_name: name,
          name: string(pointer(entry + 8n)),
          type_encoding: string(pointer(entry + 16n)),
          offset: value,
          size: u32(entry + 28n),
          alignment: u32(entry + 24n) < 31 ? 2 ** u32(entry + 24n) : null,
          location: location(entry),
          decode:
            value === null
              ? { status: "partial", reason: "ivar_offset_pointer_unresolved" }
              : decoded,
          evidence: evidence(
            entry,
            "Objective-C ivar entry and encoded offset storage",
          ),
        });
      }
    }
    methods(pointer(ro + 32n), name, meta ? "class" : "instance");
    result.objc_classes.push({
      name,
      super_class: superclassName,
      is_meta_class: meta,
      is_root_class: root,
      methods: result.objc_dispatch_implementations
        .filter(
          (item) =>
            item.class_name === name &&
            item.method_type === (meta ? "class" : "instance"),
        )
        .map((item) => ({
          selector: item.selector,
          method_type: item.method_type,
          address:
            item.implementation_address !== null &&
            BigInt(item.implementation_address) <=
              BigInt(Number.MAX_SAFE_INTEGER)
              ? Number(BigInt(item.implementation_address))
              : null,
          is_required: false,
          is_optional: false,
        })),
      properties: [],
      protocols: protocolReader.list(pointer(ro + 40n)),
      ivar_count: ivarCount,
      instance_size: u32(ro + 8n),
      location: location(address),
      superclass_address: superclass === 0n ? null : hex(superclass),
      metaclass_address: meta ? null : hex(pointer(address)),
      decode:
        superclassName === null && !root
          ? { status: "partial", reason: "superclass_binding_unresolved" }
          : decoded,
      evidence: evidence(address, "Objective-C class and class_ro_t records"),
    });
    if (!meta) {
      try {
        readClass(pointer(address), true);
      } catch (cause) {
        failures.push(
          `Metaclass of ${name}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
  };
  for (const section of sections.filter(
    ({ name }) => name === "__objc_classlist",
  )) {
    if (section.size % 8 !== 0)
      throw new RangeError("Misaligned Objective-C class-list size");
    for (let index = 0; index < section.size / 8; index++) {
      if (records >= maxRecords) {
        truncated = true;
        break;
      }
      examined++;
      const field = section.address + BigInt(index * 8);
      try {
        readClass(pointer(field));
      } catch (cause) {
        failures.push(
          `${hex(field)}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
  }
  const swiftRelative = (field: bigint, indirectable = false): bigint => {
    const displacement = bytes.readInt32LE(offset(field, 4));
    const indirect = indirectable && (displacement & 1) !== 0;
    let target =
      displacement === 0
        ? 0n
        : field + BigInt(indirectable ? displacement & ~1 : displacement);
    let fileOffset: number | null = null;
    let reason: string | null = null;
    try {
      if (indirect && target !== 0n) target = pointer(target);
      if (target !== 0n) fileOffset = offset(target);
    } catch (cause) {
      reason = cause instanceof Error ? cause.message : String(cause);
    }
    if (admit())
      result.relative_pointers.push({
        field: location(field),
        target: {
          address: target === 0n ? null : hex(target),
          file_offset: fileOffset,
        },
        displacement,
        indirectable,
        indirect,
        decode: reason === null ? decoded : { status: "partial", reason },
        evidence: evidence(field, "Swift ABI signed-relative metadata pointer"),
      });
    if (reason !== null) throw new RangeError(reason);
    return target;
  };
  const swiftFailures: string[] = [];
  let swiftExamined = 0;
  for (const section of sections.filter(
    ({ name }) => name === "__swift5_proto",
  )) {
    if (section.size % 4 !== 0)
      throw new RangeError("Misaligned Swift conformance section");
    for (let index = 0; index < section.size / 4; index++) {
      if (!admit()) break;
      swiftExamined++;
      const field = section.address + BigInt(index * 4);
      try {
        const descriptor = swiftRelative(field);
        const flags = u32(descriptor + 12n);
        const protocol = swiftRelative(descriptor, true);
        if ((u32(protocol) & 31) !== 3)
          throw new TypeError("Unsupported Swift protocol descriptor kind");
        const protocolName = string(swiftRelative(protocol + 8n));
        const typeKind = (flags >>> 3) & 7;
        if (typeKind !== 0 && typeKind !== 1)
          throw new TypeError(
            "Unsupported Swift conformance type-reference kind",
          );
        let type = swiftRelative(descriptor + 4n);
        if (typeKind === 1) type = pointer(type);
        if (![16, 17, 18].includes(u32(type) & 31))
          throw new TypeError("Unsupported Swift type descriptor kind");
        const typeName = string(swiftRelative(type + 8n));
        const witness = swiftRelative(descriptor + 8n);
        const staticWitness =
          witness !== 0n && (flags & ~0x38) === 0 && (u32(type) & 0x80) === 0;
        let witnessReason: string | null = staticWitness
          ? null
          : "Conditional, generic, resilient or missing static witness table is not decoded";
        if (staticWitness && pointer(witness) !== descriptor)
          witnessReason =
            "Witness-table conformance header is unresolved or encoded";
        result.swift_conformances.push({
          type_name: typeName,
          protocol_name: protocolName,
          module: null,
          witness_table:
            witness === 0n
              ? { address: null, file_offset: null }
              : location(witness),
          location: location(descriptor),
          decode:
            witnessReason === null
              ? decoded
              : {
                  status: "partial",
                  reason: witnessReason,
                },
          evidence: evidence(
            descriptor,
            "Swift protocol conformance descriptor and directly encoded type/protocol names",
          ),
        });
        if (witnessReason !== null) {
          swiftFailures.push(`${typeName}: ${witnessReason}`);
          continue;
        }
        const count = u32(protocol + 16n);
        const signatureCount = u32(protocol + 12n);
        if (count > 20_000 || signatureCount > 20_000)
          throw new RangeError("Swift witness requirement count exceeds 20000");
        for (let slot = 0; slot < count; slot++) {
          if (!admit()) break;
          const entry = witness + BigInt((slot + 1) * 8);
          const implementation = pointer(entry);
          const requirementFlags = u32(
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
            location: location(entry),
            decode: executable
              ? decoded
              : {
                  status: "partial",
                  reason:
                    "Witness slot is non-function, async, nil, external, authenticated or encoded; implementation target is unresolved",
                },
            evidence: evidence(
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
    status: swiftFailures.length > 0 || truncated ? "partial" : "complete",
    reason:
      [...swiftFailures, ...(truncated ? ["max_records_reached"] : [])].join(
        "; ",
      ) || null,
    examined: swiftExamined,
    decoded: result.swift_conformances.length,
  });
  const typeEntries: bigint[] = [];
  for (const section of sections.filter(
    ({ name }) => name === "__swift5_types",
  )) {
    if (section.size % 4 !== 0)
      throw new RangeError("Misaligned Swift type section");
    for (let index = 0; index < section.size / 4 && index < maxRecords; index++)
      typeEntries.push(section.address + BigInt(index * 4));
    if (section.size / 4 > maxRecords) truncated = true;
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
      admit,
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
    status: failures.length > 0 || truncated ? "partial" : "complete",
    reason:
      [...failures, ...(truncated ? ["max_records_reached"] : [])].join("; ") ||
      null,
    examined,
    decoded: result.objc_classes.length,
  });
  result.coverage.push({
    facet: "binary_relative_pointers",
    status:
      truncated ||
      result.relative_pointers.some((item) => item.decode.status !== "decoded")
        ? "partial"
        : "complete",
    reason: truncated
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

const selectMachoSlice = (bytes: Buffer, architecture: string) => {
  const magic = bytes.readUInt32BE(0);
  const header = fatHeaderFormat(magic);
  if (header === null) return { slice: 0, sliceEnd: bytes.length };
  const { littleEndian, fat64 } = header;
  const stride = fat64 ? 32 : 20;
  const readUInt32 = littleEndian
    ? (offset: number) => bytes.readUInt32LE(offset)
    : (offset: number) => bytes.readUInt32BE(offset);
  const readUInt64 = littleEndian
    ? (offset: number) => bytes.readBigUInt64LE(offset)
    : (offset: number) => bytes.readBigUInt64BE(offset);
  const byteOrder = littleEndian ? "little-endian" : "big-endian";
  const malformed = (reason: string) =>
    new RangeError(`${reason} (FAT header byte order: ${byteOrder})`);
  const invalid = (reason: string) =>
    new TypeError(`${reason} (FAT header byte order: ${byteOrder})`);
  if (bytes.length < 8) throw malformed("Malformed FAT architecture table");
  const count = readUInt32(4);
  const headerEnd = 8 + count * stride;
  if (count > 128 || headerEnd > bytes.length)
    throw malformed("Malformed FAT architecture table");
  const cpu = architecture === "arm64" ? 0x0100000c : 0x01000007;
  let selected: { slice: number; sliceEnd: number } | undefined;
  for (let index = 0; index < count; index++) {
    const offset = 8 + index * stride;
    if (readUInt32(offset) !== cpu) continue;
    if (selected !== undefined)
      throw invalid("Ambiguous FAT architecture slice");
    const start = fat64
      ? readUInt64(offset + 8)
      : BigInt(readUInt32(offset + 8));
    const size = fat64
      ? readUInt64(offset + 16)
      : BigInt(readUInt32(offset + 12));
    if (start < BigInt(headerEnd) || start + size > BigInt(bytes.length))
      throw malformed("FAT slice exceeds file");
    selected = { slice: Number(start), sliceEnd: Number(start + size) };
  }
  if (selected === undefined)
    throw invalid("Requested FAT architecture is absent");
  return selected;
};

const fatHeaderFormat = (
  magic: number,
): { readonly littleEndian: boolean; readonly fat64: boolean } | null => {
  switch (magic) {
    case 0xcafebabe:
      return { littleEndian: false, fat64: false };
    case 0xcafebabf:
      return { littleEndian: false, fat64: true };
    case 0xbebafeca:
      return { littleEndian: true, fat64: false };
    case 0xbfbafeca:
      return { littleEndian: true, fat64: true };
    default:
      return null;
  }
};
