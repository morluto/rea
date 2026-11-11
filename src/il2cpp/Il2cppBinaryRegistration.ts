import {
  BinaryFormatFailure,
  mappedFileOffset,
} from "../native/metadata/BinaryContainer.js";
import { Il2cppBinaryFormatFailure } from "./Il2cppBinaryFormat.js";
import {
  isMapped,
  hasPointerArrayCoverage,
  readPointer,
  readSlot,
  readUInt32,
  type NativeImage,
} from "./Il2cppBinaryImage.js";
import type { Il2cppMetadataDecoded } from "./Il2cppMetadataFile.js";
import {
  IL2CPP_TYPE_KIND_MAX,
  il2cppTypeKind,
  isDefinitionTypeKind,
} from "./Il2cppBinaryTypes.js";
import type { Il2cppCodeGenModule } from "./Il2cppBinaryFile.js";
// Bound the retained name-address index independently of binary size. No
// repeated name is evidence of ambiguous module ownership by itself.
const TOTAL_NAME_OCCURRENCES = 65536;
const SCAN_BYTES = 65536;

/** Index candidates by untouched bytes, retaining bounded representation space. */
const unresolvedPointerMatcher = (
  image: NativeImage,
  candidates: Iterable<bigint>,
  candidateCounts?: (candidate: bigint) => Iterable<number>,
): ((
  address: bigint,
  raw: bigint,
  count?: number,
) => number | null | undefined) => {
  const fixups = image.machoPointerFixups;
  if (fixups === undefined) return () => undefined;
  const values = [...candidates];
  const masks = new Map<
    bigint,
    Map<bigint, { counts: Set<number>; minimum: number }> | null
  >();
  const maximumEntries = 8 * TOTAL_NAME_OCCURRENCES;
  let indexedEntries = 0;
  return (address, raw, count) => {
    if (!fixups.hasUnresolvedLegacyBytes(address, 8)) return undefined;
    let knownMask = 0n;
    for (let byte = 0; byte < 8; byte++)
      if (!fixups.hasUnresolvedLegacyBytes(address + BigInt(byte), 1))
        knownMask |= 0xffn << BigInt(byte * 8);
    let matches = masks.get(knownMask);
    if (matches === undefined) {
      // Beyond the retained index budget applicability remains unknown.
      const index = new Map<bigint, { counts: Set<number>; minimum: number }>();
      let entries = 0;
      for (const candidate of values) {
        const key = candidate & knownMask;
        let candidateSet = index.get(key);
        if (candidateSet === undefined) {
          candidateSet = {
            counts: new Set(),
            minimum: Number.POSITIVE_INFINITY,
          };
          index.set(key, candidateSet);
          entries++;
        }
        for (const value of candidateCounts?.(candidate) ?? [])
          if (!candidateSet.counts.has(value)) {
            candidateSet.counts.add(value);
            candidateSet.minimum = Math.min(candidateSet.minimum, value);
            entries++;
          }
        if (entries > maximumEntries - indexedEntries) {
          masks.set(knownMask, null);
          return null;
        }
      }
      matches = index;
      indexedEntries += entries;
      masks.set(knownMask, matches);
    }
    if (matches === null) return null;
    const candidateSet = matches.get(raw & knownMask);
    if (candidateSet === undefined) return undefined;
    if (candidateCounts === undefined) return null;
    if (count !== undefined)
      return candidateSet.counts.has(count) ? count : undefined;
    return candidateSet.minimum;
  };
};

interface NameTrie {
  readonly next: Map<number, NameTrie>;
  readonly owners: number[];
}

/** Reverse byte matching permits C-string suffix sharing. Only a module's
 * declared pointer later establishes which exact candidate it actually names.
 * No decoding/alphabet guess or per-name binary rescan is needed.
 */
function* nameAddresses(
  image: NativeImage,
  names: readonly string[],
): Generator<void, Map<bigint, readonly number[]>> {
  const root: NameTrie = { next: new Map(), owners: [] };
  let nodes = 1,
    work = 0;
  for (const [index, name] of names.entries()) {
    if (++work % 256 === 0) yield;
    if (name === "") continue;
    if (Buffer.byteLength(name) > TOTAL_NAME_OCCURRENCES)
      throw new Il2cppBinaryFormatFailure(
        "native-index-capacity",
        "module-name trie exceeds its65536-node workspace",
      );
    let node = root;
    const bytes = Buffer.from(name, "utf8");
    for (let at = bytes.length - 1; at >= 0; at--) {
      if (++work % 4096 === 0) yield;
      let next = node.next.get(bytes[at]!);
      if (next === undefined) {
        if (nodes >= TOTAL_NAME_OCCURRENCES)
          throw new Il2cppBinaryFormatFailure(
            "native-index-capacity",
            "module-name trie exceeds its65536-node workspace",
          );
        next = { next: new Map(), owners: [] };
        node.next.set(bytes[at]!, next);
        nodes++;
      }
      node = next;
    }
    node.owners.push(index);
  }
  const found = new Map<bigint, readonly number[]>();
  for (const mapping of image.container.mappings) {
    const region = image.bytes.subarray(
      mapping.offset,
      mapping.offset + mapping.size,
    );
    for (let chunk = 0; chunk < region.length; chunk += SCAN_BYTES) {
      yield;
      const part = region.subarray(
        chunk,
        Math.min(chunk + SCAN_BYTES, region.length),
      );
      for (
        let end = part.indexOf(0);
        end >= 0;
        end = part.indexOf(0, end + 1)
      ) {
        let node: NameTrie | undefined = root;
        for (let at = chunk + end - 1; at >= 0; at--) {
          if (++work % 4096 === 0) yield;
          node = node.next.get(region[at]!);
          if (node === undefined) break;
          if (node.owners.length === 0) continue;
          const address = mapping.address + BigInt(at);
          if (image.elfPointerOverlay?.hasWrites(address, chunk + end - at + 1))
            continue;
          if (!found.has(address) && found.size >= TOTAL_NAME_OCCURRENCES)
            throw new Il2cppBinaryFormatFailure(
              "native-index-capacity",
              `native name-address index exceeds ${TOTAL_NAME_OCCURRENCES} entries`,
            );
          found.set(address, node.owners);
        }
      }
    }
  }
  return found;
}

/** Method count per image from its contiguous type-definition range. */
function* imageMethodCounts(
  metadata: Il2cppMetadataDecoded,
): Generator<void, number[]> {
  const counts: number[] = [];
  for (const image of metadata.images) {
    yield;
    let total = 0;
    for (let offset = 0; offset < image.type_count; offset++) {
      if (offset % 256 === 0) yield;
      total += metadata.types[image.type_start + offset]!.method_count;
    }
    counts.push(total);
  }
  return counts;
}

/**
 * Find Il2CppCodeGenModule records: a moduleName pointer to an image name
 * followed by methodPointerCount equal to that image's method count.
 */
export function* findModules(
  image: NativeImage,
  metadata: Il2cppMetadataDecoded,
): Generator<void, Il2cppCodeGenModule[]> {
  const names = yield* nameAddresses(
    image,
    metadata.images.map((entry) => entry.name),
  );
  const counts = yield* imageMethodCounts(metadata);
  const countSet = new Set(counts);
  const minimumCount = counts.reduce(
    (minimum, count) => Math.min(minimum, count),
    Number.POSITIVE_INFINITY,
  );
  const candidates = new Map<number, Il2cppCodeGenModule[]>();
  const unresolvedName = unresolvedPointerMatcher(image, names.keys(), (name) =>
    (names.get(name) ?? []).map((index) => counts[index]!),
  );
  for (const mapping of image.container.mappings) {
    const start = Number((8n - (mapping.address % 8n)) % 8n);
    for (let at = start; at + 24 <= mapping.size; at += 8) {
      if ((at & 0xffff) < 8) yield;
      const offset = mapping.offset + at;
      const address = mapping.address + BigInt(at);
      const raw = image.bytes.readBigUInt64LE(offset);
      const elfSlot =
        image.elfPointerOverlay === undefined
          ? undefined
          : readSlot(image, address);
      const unresolvedLegacy =
        image.machoPointerFixups?.hasUnresolvedLegacyBytes(address, 8) === true;
      if (elfSlot === "unknown" || unresolvedLegacy) {
        const count = readUInt32(image, address + 8n);
        let plausibleCount =
          count === "unknown"
            ? minimumCount
            : count !== null && countSet.has(count)
              ? count
              : Number.POSITIVE_INFINITY;
        if (elfSlot !== "unknown" && Number.isFinite(plausibleCount)) {
          const matched = unresolvedName(
            address,
            raw,
            count === "unknown" || count === null ? undefined : count,
          );
          plausibleCount =
            matched === undefined
              ? Number.POSITIVE_INFINITY
              : (matched ?? plausibleCount);
        }
        if (Number.isFinite(plausibleCount)) {
          const pointers = readSlot(image, address + 16n);
          if (
            pointers === "unknown" ||
            (typeof pointers === "bigint" &&
              hasPointerArrayCoverage(image, pointers, plausibleCount))
          )
            throw new Il2cppBinaryFormatFailure(
              "code-gen-modules-not-found",
              "A loader-owned module name pointer could match an additional module record",
            );
        }
      }
      if (unresolvedLegacy) continue;
      // Non-ELF images retain their stored bytes. Nominate before decoding so
      // unrelated partial fixups do not invalidate the module search.
      if (image.elfPointerOverlay === undefined && !names.has(raw)) continue;
      const target =
        elfSlot === undefined
          ? readPointer(image, address)
          : typeof elfSlot === "bigint"
            ? elfSlot
            : null;
      if (target === null) continue;
      const indices = names.get(target);
      if (indices === undefined) continue;
      let recordOffset: number;
      try {
        recordOffset = mappedFileOffset(
          image.container.mappings,
          address,
          24,
          image.container.zero_fills,
        );
      } catch (cause) {
        if (cause instanceof BinaryFormatFailure)
          throw new Il2cppBinaryFormatFailure(
            "malformed-container",
            cause.message,
          );
        throw cause;
      }
      if (recordOffset !== offset)
        throw new Il2cppBinaryFormatFailure(
          "malformed-container",
          "code generation module record disagrees with its load mapping",
        );
      let work = 0;
      for (const index of indices) {
        if (++work % 256 === 0) yield;
        const count = readUInt32(image, address + 8n);
        if (count !== "unknown" && count !== counts[index]) continue;
        const pointers = readSlot(image, address + 16n);
        if (pointers === "unknown")
          throw new Il2cppBinaryFormatFailure(
            "code-gen-modules-not-found",
            "A matching module record has an unresolved method pointer array",
          );
        if (pointers === null) continue;
        if (!hasPointerArrayCoverage(image, pointers, counts[index]!)) continue;
        if (count === "unknown")
          throw new Il2cppBinaryFormatFailure(
            "code-gen-modules-not-found",
            "A matching module record has an unresolved method count",
          );
        const list = candidates.get(index) ?? [];
        if (list.some((candidate) => candidate.address === address)) continue;
        if (list.length !== 0)
          throw new Il2cppBinaryFormatFailure(
            "ambiguous-code-gen-module",
            `multiple records match code generation module ${metadata.images[index]!.name}`,
          );
        list.push({
          image: index,
          address,
          method_pointer_count: count,
          method_pointers: pointers,
        });
        candidates.set(index, list);
      }
    }
  }
  return metadata.images.map((entry, index) => {
    const list = candidates.get(index) ?? [];
    if (list.length === 0)
      throw new Il2cppBinaryFormatFailure(
        "code-gen-modules-not-found",
        `no code generation module names ${entry.name} with ${counts[index]} method pointers`,
      );
    if (list.length > 1)
      throw new Il2cppBinaryFormatFailure(
        "ambiguous-code-gen-module",
        `${list.length} records match code generation module ${entry.name}`,
      );
    return list[0]!;
  });
}

/**
 * Find the CodeRegistration codeGenModulesCount/codeGenModules pair: a count
 * equal to the image count followed by a pointer to an array holding exactly
 * the located module records.
 */
export function* findCodeRegistration(
  image: NativeImage,
  modules: readonly Il2cppCodeGenModule[],
): Generator<void, { readonly field: bigint | null; readonly array: bigint }> {
  const expected = new Set(modules.map((module) => module.address));
  const matches: { field: bigint; array: bigint }[] = [];
  const matchedFields = new Set<bigint>();
  for (const mapping of image.container.mappings) {
    const start = Number((8n - (mapping.address % 8n)) % 8n);
    for (let at = start; at + 16 <= mapping.size; at += 8) {
      if ((at & 0xffff) < 8) yield;
      // The count owns four bytes; the following four only align its pointer.
      const field = mapping.address + BigInt(at);
      const count = readUInt32(image, field);
      if (count !== "unknown" && count !== modules.length) continue;
      const arraySlot = readSlot(image, field + 8n);
      if (arraySlot === "unknown")
        throw new Il2cppBinaryFormatFailure(
          "code-registration-not-found",
          "A possible CodeRegistration has an unresolved module array",
        );
      const array = arraySlot;
      if (array === null || !isMapped(image, array, modules.length * 8))
        continue;
      const seen = new Set<bigint>();
      let uncertain = count === "unknown";
      let viable = true;
      for (let slot = 0; slot < modules.length; slot++) {
        if (slot % 256 === 0) yield;
        const pointer = readSlot(image, array + BigInt(slot * 8));
        if (pointer === "unknown") {
          uncertain = true;
          continue;
        }
        if (pointer === null || !expected.has(pointer) || seen.has(pointer)) {
          viable = false;
          break;
        }
        seen.add(pointer);
      }
      if (viable && uncertain)
        throw new Il2cppBinaryFormatFailure(
          "code-registration-not-found",
          "A possible CodeRegistration has unresolved candidate fields",
        );
      if (viable && seen.size === modules.length) {
        // Exact load aliases can visit one virtual registration field twice.
        if (matchedFields.has(field)) continue;
        matchedFields.add(field);
        if (matches.length !== 0)
          throw new Il2cppBinaryFormatFailure(
            "code-registration-not-found",
            "multiple CodeRegistration module tables match",
          );
        matches.push({ field, array });
      }
    }
  }
  const architecture = image.container.architecture;
  if (
    matches.length === 0 &&
    (architecture === "amd64" || architecture === "arm64")
  ) {
    const array = yield* findModuleArrayByCode(image, expected);
    if (array !== null) return { field: null, array };
  }
  if (matches.length !== 1)
    throw new Il2cppBinaryFormatFailure(
      "code-registration-not-found",
      `${matches.length} CodeRegistration module tables list the ${modules.length} located modules`,
    );
  return matches[0]!;
}

/**
 * Some builds keep no static CodeRegistration: the compiler folded the module
 * array and its count into the one loop that walks it, so no data word points
 * at the array. Seen on x86-64 (a Unity 2023.2 Linux GameAssembly.so) and on
 * arm64 (a Unity 2022.3 macOS Master/LTO GameAssembly.dylib). Find every
 * pointer array that lists exactly the located modules, then require exactly
 * one of them to be the target of an address-forming instruction in an
 * executable range: on x86-64 a RIP-relative `lea`/`mov` (REX.W 8D/8B with a
 * disp32 operand), on arm64 an `adrp` immediately followed by an `add` of its
 * page offset to the same register. Anything else stays
 * code-registration-not-found.
 */
const MODULE_ARRAY_CANDIDATES = 64;

function* findModuleArrayByCode(
  image: NativeImage,
  expected: ReadonlySet<bigint>,
): Generator<void, bigint | null> {
  const arrays = new Set<bigint>();
  const unresolvedModule = unresolvedPointerMatcher(image, expected);
  let expectedXor = 0n;
  for (const candidate of expected) expectedXor ^= candidate;
  for (const mapping of image.container.mappings) {
    const start = Number((8n - (mapping.address % 8n)) % 8n);
    let runStart = start;
    const lastPosition = new Map<bigint, number>();
    const possible = new Map<number, bigint | null>();
    const occurrences = new Map<bigint, number>();
    const unknownPositions = new Set<number>();
    let possibleXor = 0n;
    let duplicateValues = 0;
    for (let at = start; at + 8 <= mapping.size; at += 8) {
      if ((at & 0xffff) < 8) yield;
      const raw = image.bytes.readBigUInt64LE(mapping.offset + at);
      const address = mapping.address + BigInt(at);
      const elfSlot =
        image.elfPointerOverlay === undefined
          ? undefined
          : readSlot(image, address);
      const unknown =
        elfSlot === "unknown" || unresolvedModule(address, raw) !== undefined;
      const value =
        !unknown && (image.elfPointerOverlay !== undefined || expected.has(raw))
          ? elfSlot === undefined
            ? readPointer(image, address)
            : typeof elfSlot === "bigint"
              ? elfSlot
              : null
          : null;
      if (!unknown && (value === null || !expected.has(value))) {
        possible.clear();
        occurrences.clear();
        unknownPositions.clear();
        possibleXor = 0n;
        duplicateValues = 0;
      } else {
        const candidate = unknown ? null : value;
        possible.set(at, candidate);
        if (candidate === null) unknownPositions.add(at);
        else {
          possibleXor ^= candidate;
          const count = (occurrences.get(candidate) ?? 0) + 1;
          occurrences.set(candidate, count);
          if (count === 2) duplicateValues++;
        }
        const expired = at - expected.size * 8;
        if (possible.has(expired)) {
          const previous = possible.get(expired)!;
          possible.delete(expired);
          if (previous === null) unknownPositions.delete(expired);
          else {
            possibleXor ^= previous;
            const count = occurrences.get(previous)!;
            if (count === 2) duplicateValues--;
            if (count === 1) occurrences.delete(previous);
            else occurrences.set(previous, count - 1);
          }
        }
        if (
          possible.size === expected.size &&
          unknownPositions.size > 0 &&
          duplicateValues === 0
        ) {
          if (unknownPositions.size === 1) {
            const unknownAt = unknownPositions.values().next().value!;
            if (
              image.elfPointerOverlay !== undefined ||
              unresolvedPointerMatcher(image, [expectedXor ^ possibleXor])(
                mapping.address + BigInt(unknownAt),
                image.bytes.readBigUInt64LE(mapping.offset + unknownAt),
              ) !== undefined
            )
              return null;
          } else return null;
        }
      }
      if (value === null || !expected.has(value)) {
        runStart = at + 8;
        lastPosition.clear();
        continue;
      }
      const previous = lastPosition.get(value);
      if (previous !== undefined && previous >= runStart)
        runStart = previous + 8;
      lastPosition.set(value, at);
      if (at - runStart === (expected.size - 1) * 8) {
        arrays.add(mapping.address + BigInt(runStart));
        // Retain overlapping windows; at most one position per expected module.
        if (arrays.size > MODULE_ARRAY_CANDIDATES)
          throw new Il2cppBinaryFormatFailure(
            "native-index-capacity",
            `module-array index exceeds ${MODULE_ARRAY_CANDIDATES} entries`,
          );
      }
    }
  }
  if (arrays.size === 0) return null;
  const referenced =
    image.container.architecture === "arm64"
      ? yield* arm64PageReferences(image, arrays)
      : yield* ripRelativeReferences(image, arrays);
  return referenced.size === 1 ? [...referenced][0]! : null;
}

function* ripRelativeReferences(
  image: NativeImage,
  arrays: ReadonlySet<bigint>,
): Generator<void, Set<bigint>> {
  const referenced = new Set<bigint>();
  for (const mapping of image.container.executable_mappings ?? []) {
    const bytes = image.bytes;
    const loaded =
      image.elfPointerOverlay?.hasWrites(mapping.address, mapping.size) ===
      true;
    const end = mapping.offset + mapping.size - 7;
    for (let at = mapping.offset; at <= end; at++) {
      if ((at & 0xffff) < 8) yield;
      const address = mapping.address + BigInt(at - mapping.offset);
      const prefix = loaded
        ? readUInt32(image, address)
        : bytes.readUInt32LE(at);
      if (typeof prefix !== "number") continue;
      const rex = prefix & 0xff;
      if ((rex & 0xfb) !== 0x48) continue; // REX.W, optionally REX.R
      const opcode = (prefix >>> 8) & 0xff;
      if (opcode !== 0x8d && opcode !== 0x8b) continue;
      if (((prefix >>> 16) & 0xc7) !== 0x05) continue; // mod 00, rm 101: RIP + disp32
      const next = mapping.address + BigInt(at - mapping.offset + 7);
      const displacement = loaded
        ? readUInt32(image, address + 3n)
        : bytes.readUInt32LE(at + 3);
      if (typeof displacement !== "number") continue;
      const target = next + BigInt(displacement | 0);
      if (arrays.has(target)) referenced.add(target);
    }
  }
  return referenced;
}

/**
 * arm64 instructions are 4-byte aligned words, so only aligned addresses are
 * decoded. `adrp xd, page` forms the 4 KiB page of pc plus a signed 21-bit
 * page delta; the next word must be `add xd, xd, #imm12` (64-bit, unshifted),
 * which adds the offset within that page. Pairs split by other instructions or
 * loads through `ldr` are not followed.
 */
function* arm64PageReferences(
  image: NativeImage,
  arrays: ReadonlySet<bigint>,
): Generator<void, Set<bigint>> {
  const referenced = new Set<bigint>();
  const bytes = image.bytes;
  for (const mapping of image.container.executable_mappings ?? []) {
    const loaded =
      image.elfPointerOverlay?.hasWrites(mapping.address, mapping.size) ===
      true;
    const start = Number((4n - (mapping.address % 4n)) % 4n);
    for (let at = start; at + 8 <= mapping.size; at += 4) {
      if ((at & 0xffff) < 4) yield;
      const address = mapping.address + BigInt(at);
      const adrp = loaded
        ? readUInt32(image, address)
        : bytes.readUInt32LE(mapping.offset + at);
      if (typeof adrp !== "number") continue;
      if ((adrp & 0x9f000000) >>> 0 !== 0x90000000) continue;
      const add = loaded
        ? readUInt32(image, address + 4n)
        : bytes.readUInt32LE(mapping.offset + at + 4);
      if (typeof add !== "number") continue;
      if ((add & 0xffc00000) >>> 0 !== 0x91000000) continue;
      const register = adrp & 0x1f;
      // Register 31 is xzr for ADRP and sp for ADD, so no address is formed.
      if (register === 31) continue;
      if ((add & 0x1f) !== register || ((add >>> 5) & 0x1f) !== register)
        continue;
      const pages =
        (((((adrp >>> 5) & 0x7ffff) << 2) | ((adrp >>> 29) & 3)) << 11) >> 11;
      const pc = mapping.address + BigInt(at);
      const target =
        (pc & ~0xfffn) + (BigInt(pages) << 12n) + BigInt((add >>> 10) & 0xfff);
      if (arrays.has(target)) referenced.add(target);
    }
  }
  return referenced;
}

/**
 * Find MetadataRegistration by its two TypeDefinitionIndex-sized counts:
 * fieldOffsetsCount and typeDefinitionsSizesCount (words 10 and 12) both equal
 * the metadata type-definition count and are followed by mapped pointers.
 * typesCount and types are words 6 and 7. Counts are int32 in 8-byte slots.
 * Linking reads only the type table, so when no static registration matches on
 * x86-64 or arm64 the table is inferred from code instead (field null).
 */
export function* findMetadataRegistration(
  image: NativeImage,
  typeDefinitions: number,
  requiredTypes: number,
): Generator<
  void,
  {
    readonly field: bigint | null;
    readonly count: number;
    readonly types: bigint;
  }
> {
  const matches: { field: bigint; count: number; types: bigint }[] = [];
  const matchedFields = new Set<bigint>();
  // A record whose two counts match is static evidence even when its other
  // fields are unusable; code is then not asked to stand in for it.
  let countsMatched = false;
  for (const mapping of image.container.mappings) {
    const start = Number((8n - (mapping.address % 8n)) % 8n);
    // The fields used below end at byte 112. The full 128-byte registration
    // must still have loader coverage, including any declared zero-fill tail.
    for (let at = start; at + 112 <= mapping.size; at += 8) {
      if ((at & 0xffff) < 8) yield;
      const address = mapping.address + BigInt(at);
      const fieldCount = readUInt32(image, address + 80n);
      if (fieldCount !== "unknown" && fieldCount !== typeDefinitions) continue;
      const sizeCount = readUInt32(image, address + 96n);
      if (sizeCount !== "unknown" && sizeCount !== typeDefinitions) continue;
      if (!hasPointerArrayCoverage(image, address, 16)) continue;
      if (fieldCount !== "unknown" && sizeCount !== "unknown")
        countsMatched = true;
      const count = readUInt32(image, address + 48n);
      const types = readSlot(image, address + 56n);
      const fieldOffsets = readSlot(image, address + 88n);
      const typeSizes = readSlot(image, address + 104n);
      if (
        count === null ||
        (typeof count === "number" && (count === 0 || count > 0x7fffffff)) ||
        types === null ||
        fieldOffsets === null ||
        typeSizes === null ||
        (typeof fieldOffsets === "bigint" &&
          !isMapped(image, fieldOffsets, 8)) ||
        (typeof typeSizes === "bigint" && !isMapped(image, typeSizes, 8)) ||
        (typeof types === "bigint" &&
          !isMapped(image, types, typeof count === "number" ? count * 8 : 8))
      )
        continue;
      if (
        fieldCount === "unknown" ||
        sizeCount === "unknown" ||
        count === "unknown" ||
        types === "unknown" ||
        fieldOffsets === "unknown" ||
        typeSizes === "unknown"
      )
        throw new Il2cppBinaryFormatFailure(
          "metadata-registration-not-found",
          "A possible MetadataRegistration has unresolved candidate fields",
        );
      const field = mapping.address + BigInt(at + 48);
      // Exact load aliases can visit one virtual registration field twice.
      if (matchedFields.has(field)) continue;
      matchedFields.add(field);
      if (matches.length !== 0)
        throw new Il2cppBinaryFormatFailure(
          "metadata-registration-not-found",
          "multiple MetadataRegistration candidates match",
        );
      matches.push({
        field,
        count,
        types,
      });
    }
  }
  const architecture = image.container.architecture;
  let inferred = false;
  if (
    !countsMatched &&
    requiredTypes > 0 &&
    (architecture === "amd64" || architecture === "arm64")
  ) {
    inferred = true;
    const table = yield* findTypeTableByCode(
      image,
      typeDefinitions,
      requiredTypes,
    );
    if (table !== null) return { field: null, ...table };
  }
  if (matches.length !== 1)
    throw new Il2cppBinaryFormatFailure(
      "metadata-registration-not-found",
      countsMatched && matches.length === 0
        ? `a MetadataRegistration counts ${typeDefinitions} type definitions, but its type table, field offsets or type sizes are not mapped`
        : inferred
          ? `no MetadataRegistration counts ${typeDefinitions} type definitions, and no single code-loaded run of Il2CppType pointers covers every referenced type index`
          : `${matches.length} MetadataRegistration candidates count ${typeDefinitions} type definitions`,
    );
  return matches[0]!;
}

/**
 * An inlined MetadataRegistration leaves the Il2CppType pointer table loaded
 * directly by code. Candidates are maximal runs of pointers to Il2CppType-shaped
 * records (a defined Il2CppTypeEnum kind; class and value-type data below the
 * metadata type-definition count) long enough for every type index the
 * metadata references. Exactly one such run may exist in the image, it must
 * end inside its mapping, and code must load its start with the same
 * instruction forms as the module-array fallback; anything else fails closed.
 * The run length becomes the count: never below what the metadata needs, but
 * not an observed typesCount.
 */
/** Il2CppTypeEnum values 0x01 to 0x1e; 0x17 and 0x1a are unassigned. */
const isDefinedTypeKind = (kind: number) =>
  kind >= 1 && kind <= IL2CPP_TYPE_KIND_MAX && kind !== 0x17 && kind !== 0x1a;

function* findTypeTableByCode(
  image: NativeImage,
  typeDefinitions: number,
  requiredTypes: number,
): Generator<void, { readonly count: number; readonly types: bigint } | null> {
  const { container } = image;
  // Nomination and loader-aware confirmation share the image's mapping index.
  // Most words are not record addresses; reject those without the throwing
  // lookup. Starts are sorted, and reach[i] is the furthest end among the
  // first i + 1 mappings, so one binary search finds a possible container.
  const spans = container.mappings
    .filter((mapping) => mapping.size > 0)
    .map((mapping) => ({
      start: mapping.address,
      end: mapping.address + BigInt(mapping.size),
    }))
    .sort((left, right) =>
      left.start < right.start ? -1 : left.start > right.start ? 1 : 0,
    );
  const reach: bigint[] = [];
  for (const [index, span] of spans.entries())
    reach.push(
      index === 0 || span.end > reach[index - 1]!
        ? span.end
        : reach[index - 1]!,
    );
  const maybeMapped = (address: bigint) => {
    let lowIndex = 0;
    let highIndex = spans.length - 1;
    let found = -1;
    while (lowIndex <= highIndex) {
      const middle = (lowIndex + highIndex) >> 1;
      if (spans[middle]!.start <= address) {
        found = middle;
        lowIndex = middle + 1;
      } else highIndex = middle - 1;
    }
    return found >= 0 && reach[found]! >= address + 12n;
  };
  const recordOffset = (address: bigint) => {
    if (!maybeMapped(address)) return -1;
    try {
      return image.fileMappings.offset(address, 12);
    } catch (cause) {
      // Unmapped, zero-filled or ambiguously mapped records are not types.
      if (cause instanceof BinaryFormatFailure) return -1;
      throw cause;
    }
  };
  // A run that touches either end of its mapping may continue in a
  // neighbouring one, so its length and start are unknown; it still counts as
  // a candidate but cannot be chosen.
  const runs = new Map<bigint, number | null>();
  // A slot the loader binds or leaves unresolved has no known value, so a
  // run it bounds has an unknown extent whatever its placeholder holds.
  // The same holds for a record's kind word and its definition index.
  const recordState = (target: bigint): "type" | "other" | "unknown" => {
    if (target === 0n || (target & 7n) !== 0n) return "other";
    if (recordOffset(target) < 0) return "other";
    const attributes = readUInt32(image, target + 8n);
    if (attributes === "unknown") return "unknown";
    if (attributes === null) return "other";
    const kind = il2cppTypeKind(attributes);
    if (!isDefinedTypeKind(kind)) return "other";
    if (!isDefinitionTypeKind(kind)) return "type";
    const data = readSlot(image, target);
    if (data === "unknown") return "unknown";
    return typeof data === "bigint" && data < BigInt(typeDefinitions)
      ? "type"
      : "other";
  };
  // A word whose slot or record the loader leaves unknown bounds a run with
  // an unknown extent.
  const unresolved = (address: bigint) => {
    const slot = readSlot(image, address);
    return (
      slot === "unknown" ||
      (typeof slot === "bigint" && recordState(slot) === "unknown")
    );
  };
  for (const mapping of container.mappings) {
    const start = Number((8n - (mapping.address % 8n)) % 8n);
    let runStart = -1;
    let startUnknown = false;
    let possibleLength = 0;
    let possibleUnknown = false;
    for (let at = start; at <= mapping.size; at += 8) {
      if ((at & 0xffff) < 8) yield;
      const address = mapping.address + BigInt(at);
      let endUnknown = at + 8 > mapping.size;
      if (!endUnknown) {
        const raw = image.bytes.readBigUInt64LE(mapping.offset + at);
        let state: "type" | "other" | "unknown";
        if (image.elfPointerOverlay === undefined) {
          if (
            image.machoPointerFixups?.hasUnresolvedLegacyBytes(address, 8) ===
            true
          )
            state = "unknown";
          else {
            const rawState = recordState(raw);
            if (rawState !== "type") state = rawState;
            else {
              const slot = readSlot(image, address);
              state =
                slot === raw
                  ? rawState
                  : typeof slot === "bigint"
                    ? recordState(slot)
                    : slot === "unknown"
                      ? "unknown"
                      : "other";
            }
          }
        } else {
          const slot = readSlot(image, address);
          state =
            typeof slot === "bigint"
              ? recordState(slot)
              : slot === "unknown"
                ? "unknown"
                : "other";
        }
        if (state === "other") {
          possibleLength = 0;
          possibleUnknown = false;
        } else {
          possibleLength += 1;
          possibleUnknown ||= state === "unknown";
          if (possibleUnknown && possibleLength >= requiredTypes) return null;
        }
        if (state === "type") {
          if (runStart < 0) {
            runStart = at;
            startUnknown = at === start || unresolved(address - 8n);
          }
          continue;
        }
        endUnknown = state === "unknown";
      }
      if (runStart >= 0 && (at - runStart) / 8 >= requiredTypes) {
        runs.set(
          mapping.address + BigInt(runStart),
          endUnknown || startUnknown ? null : (at - runStart) / 8,
        );
        // Another long-enough run could be the real table while code loads
        // only this one, so a second candidate fails closed at once.
        if (runs.size > 1) return null;
      }
      runStart = -1;
    }
  }
  if (runs.size !== 1) return null;
  const [start, count] = [...runs][0]!;
  if (count === null) return null;
  const starts = new Set([start]);
  const referenced =
    container.architecture === "arm64"
      ? yield* arm64PageReferences(image, starts)
      : yield* ripRelativeReferences(image, starts);
  if (!referenced.has(start)) return null;
  return { count, types: start };
}
