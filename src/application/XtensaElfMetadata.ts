import type { FileHandle } from "node:fs/promises";
import type { ElfDeclarationRead } from "../domain/elfDeclaredRanges.js";
import type { XtensaInfoDeclarations } from "../domain/binaryTargetTypes.js";
import {
  parseXtensaInfo,
  undeclaredXtensaInfo,
  XTENSA_INFO_MAX_BYTES,
} from "../domain/xtensaInfo.js";
import { readElfTableDeclarations } from "../domain/elfDeclaredRanges.js";
import { readElfSectionHeader } from "../domain/elfSectionHeader.js";
import { observeElfStringTableEntry } from "../domain/elfStringTable.js";
import { decodeElfSectionNameTable } from "../native/metadata/ElfSectionNameTable.js";
import { err, ok, type Result } from "../domain/result.js";

const SHT_NOTE = 7;
const SHT_STRTAB = 3;
/** The structural budget the shared ELF section directory applies to names. */
const NAME_BYTES = 16 * 1024 * 1024;
/** One name scan, as the section directory bounds it. */
const NAME_SCAN_BYTES = 65536;
const HEADER_BATCH_BYTES = 64 * 1024;
/** Compressed storage holds a compression header and payload, not notes. */
const SHF_COMPRESSED = 0x800n;

const unavailable = (reason: string): XtensaInfoDeclarations =>
  undeclaredXtensaInfo({ status: "unavailable", reason });

interface XtensaInfoSection {
  readonly type: number;
  readonly flags: bigint;
  readonly offset: bigint;
  readonly size: bigint;
  readonly alignment: bigint;
}

type XtensaInfoLookup =
  | {
      readonly state: "found";
      readonly section: XtensaInfoSection;
      readonly little: boolean;
    }
  | { readonly state: "absent" }
  | { readonly state: "unavailable"; readonly reason: string };

/** The section-name string table, decoded once through its owner. */
function* readSectionNames(
  headerOffset: number,
  width: number,
  elfClass: 32 | 64,
  little: boolean,
): Generator<ElfDeclarationRead, Result<Buffer, string>, Buffer> {
  const header = readElfSectionHeader(
    yield { offset: headerOffset, size: width },
    elfClass,
    little,
  );
  if (!header.ok) return err(header.error.message);
  if (header.value.type !== SHT_STRTAB)
    return err("ELF section name table is not a string table");
  // The admitted section extents lie inside the file, so the size is exact.
  if (header.value.size > BigInt(NAME_BYTES))
    return err(
      `ELF section names declare ${String(header.value.size)} bytes, above REA's ${NAME_BYTES}-byte structural budget`,
    );
  const raw = yield {
    offset: Number(header.value.offset),
    size: Number(header.value.size),
  };
  const decoded = decodeElfSectionNameTable(
    raw,
    header.value.flags,
    elfClass,
    little,
    Math.max(0, NAME_BYTES - raw.length),
  );
  switch (decoded.state) {
    case "available":
      return ok(decoded.bytes);
    case "malformed":
      return err(decoded.message);
    case "limit":
      return err(
        `Decoded ELF section names require ${String(decoded.requiredBytes)} bytes, above the ${String(decoded.maximumBytes)}-byte remaining structural budget`,
      );
    case "unsupported":
      return err(
        `ELF section names are unavailable because compression type ${String(decoded.compressionType)} is unsupported`,
      );
  }
}

/**
 * Find the one section named `.xtensa.info`. Headers are read in 64 KiB
 * batches and only the match is kept, so an extended section count costs
 * reads, not retained records. A name REA cannot read could be another
 * `.xtensa.info`, so it leaves the lookup unavailable.
 */
function* findXtensaInfoSection(
  fileSize: number,
): Generator<ElfDeclarationRead, XtensaInfoLookup, Buffer> {
  const unavailableLookup = (reason: string): XtensaInfoLookup => ({
    state: "unavailable",
    reason,
  });
  const ident = yield { offset: 0, size: Math.min(16, fileSize) };
  const header = yield {
    offset: 0,
    size: Math.min(ident[4] === 1 ? 52 : 64, fileSize),
  };
  const declarations = yield* readElfTableDeclarations(header, fileSize);
  if (!declarations.ok) return unavailableLookup(declarations.error);
  const { header: fixed, sections } = declarations.value;
  if (sections.count === 0)
    return unavailableLookup(
      "The image has no section header table, which is where .xtensa.info is declared.",
    );
  const little = fixed.byteOrder === "little";
  if (sections.namesIndex === 0)
    return sections.count > 1
      ? unavailableLookup(
          "ELF section names are unavailable because no section-name string table is declared",
        )
      : { state: "absent" };
  const table = yield* readSectionNames(
    Number(sections.offset) + sections.namesIndex * sections.width,
    sections.width,
    fixed.elfClass,
    little,
  );
  if (!table.ok) return unavailableLookup(table.error);
  const names = table.value;
  const wanted = Buffer.from(".xtensa.info", "latin1");
  let found: XtensaInfoSection | undefined;
  let duplicated = false;
  let limitation: string | undefined;
  let scanned = 0;
  const perRead = Math.max(1, Math.floor(HEADER_BATCH_BYTES / sections.width));
  for (let index = 0; index < sections.count; index += perRead) {
    const count = Math.min(perRead, sections.count - index);
    const bytes = yield {
      offset: Number(sections.offset) + index * sections.width,
      size: count * sections.width,
    };
    for (let item = 0; item < count; item += 1) {
      const at = item * sections.width;
      const parsed = readElfSectionHeader(
        bytes.subarray(at, at + sections.width),
        fixed.elfClass,
        little,
      );
      if (!parsed.ok) return unavailableLookup(parsed.error.message);
      const name = observeElfStringTableEntry(
        names,
        parsed.value.nameOffset,
        NAME_SCAN_BYTES,
      );
      scanned += name.examinedBytes;
      // Names are scanned, not kept, so repeated offsets are charged again.
      if (scanned > NAME_BYTES)
        return unavailableLookup(
          "Decoded ELF section names exceed the 16 MiB structural budget",
        );
      if (name.state === "outside")
        limitation ??=
          "ELF section names are incomplete because a name offset is outside its string table";
      else if (name.state === "truncated")
        limitation ??=
          "ELF section names are unavailable because a name is not NUL-terminated";
      else if (name.bytes.equals(wanted)) {
        if (found !== undefined) duplicated = true;
        found = parsed.value;
      }
    }
  }
  if (limitation !== undefined) return unavailableLookup(limitation);
  if (duplicated)
    return unavailableLookup("More than one section is named .xtensa.info.");
  return found === undefined
    ? { state: "absent" }
    : { state: "found", section: found, little };
}

/**
 * Read what `.xtensa.info` declares from the caller's already-open file.
 * GNU ld finds that section by name, so every section name is read through
 * the ELF string-table owners. A source REA could not examine leaves the
 * declarations unknown. The caller supplies its cancellation check so its tagged error is
 * preserved.
 */
export const readXtensaElfInfo = async (
  handle: FileHandle,
  fileSize: number,
  checkCancelled: () => void,
): Promise<XtensaInfoDeclarations> => {
  const read = async (
    offset: number,
    size: number,
  ): Promise<Buffer | undefined> => {
    const bytes = Buffer.alloc(size);
    for (let total = 0; total < size;) {
      checkCancelled();
      const observed = await handle.read(
        bytes,
        total,
        size - total,
        offset + total,
      );
      checkCancelled();
      if (observed.bytesRead === 0) return undefined;
      total += observed.bytesRead;
    }
    return bytes;
  };
  const truncated = unavailable("The file ended inside a declared ELF range.");
  const steps = findXtensaInfoSection(fileSize);
  let next = steps.next();
  while (!next.done) {
    const bytes = await read(next.value.offset, next.value.size);
    if (bytes === undefined) return truncated;
    next = steps.next(bytes);
  }
  const lookup = next.value;
  if (lookup.state === "unavailable") return unavailable(lookup.reason);
  if (lookup.state === "absent")
    return undeclaredXtensaInfo({ status: "absent" });
  const { section: info, little } = lookup;
  if (info.type !== SHT_NOTE)
    return unavailable(".xtensa.info is not an SHT_NOTE section.");
  if ((info.flags & SHF_COMPRESSED) !== 0n)
    return unavailable(
      ".xtensa.info is compressed (SHF_COMPRESSED); REA reads its note only from uncompressed section bytes.",
    );
  // A validated SHT_NOTE extent lies inside the file, so its size is exact.
  if (info.size > BigInt(XTENSA_INFO_MAX_BYTES))
    return undeclaredXtensaInfo({
      status: "unavailable",
      reason: `.xtensa.info declares ${String(info.size)} bytes, above REA's fixed ${XTENSA_INFO_MAX_BYTES}-byte inspection bound. This release has no runtime override, and runtime analysis settings do not raise this bound.`,
      limit: {
        boundary: "xtensa_info",
        maximum_bytes: XTENSA_INFO_MAX_BYTES,
        declared_bytes: Number(info.size),
        runtime_override: false,
      },
    });
  const contents = await read(Number(info.offset), Number(info.size));
  if (contents === undefined) return truncated;
  return parseXtensaInfo(contents, little, info.alignment);
};
