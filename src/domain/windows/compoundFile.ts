import { err, ok, type Result } from "../result.js";
import type {
  RegionDecodeFailure,
  RegionDecoder,
} from "../firmware/regionDecoder.js";

/**
 * The compound file binary signature. Windows artifacts such as Jump Lists,
 * Thumbs.db and installer packages start with it, so the magic alone is the
 * recognition fact; whether the rest of the file parses is the reader's
 * question, not classification's.
 */
export const COMPOUND_FILE_MAGIC = "d0cf11e0a1b11ae1";
const COMPOUND_FILE_MAGIC_BYTES = 8;
/** The smallest header worth reading: it ends with the 109-entry DIFAT. */
export const COMPOUND_FILE_HEADER_BYTES = 512;

export const hasCompoundFileSignature = (prefix: Uint8Array): boolean =>
  prefix.length >= COMPOUND_FILE_MAGIC_BYTES &&
  Buffer.from(prefix.subarray(0, COMPOUND_FILE_MAGIC_BYTES)).toString("hex") ===
    COMPOUND_FILE_MAGIC;

/**
 * Fixed whole-file ceiling. The directory and allocation tables are read
 * whole; stream contents are not, so this bounds the container itself.
 */
export const COMPOUND_FILE_MAX_BYTES = 512 * 1024 * 1024;

/** Sector ids are 32-bit; these three values are markers rather than sectors. */
export const CFB_FREE_SECTOR = 0xffff_ffff;
export const CFB_END_OF_CHAIN = 0xffff_fffe;
export const CFB_FAT_SECTOR = 0xffff_fffd;
const CFB_DIFAT_SECTOR = 0xffff_fffc;
const SECTOR_MARKERS = new Set([
  CFB_FREE_SECTOR,
  CFB_END_OF_CHAIN,
  CFB_FAT_SECTOR,
  CFB_DIFAT_SECTOR,
]);

/**
 * Deepest storage nesting the directory walk follows. Every level embeds its
 * ancestors in each descendant's path, so an unbounded acyclic chain of
 * storages would let a small admitted file demand quadratic path work.
 */
const MAX_TREE_DEPTH = 64;

/**
 * Directory entries the parser will materialize. The directory stream, its
 * copy and one parsed entry per 128 bytes are retained together, so this caps
 * the representation at roughly 1M entries rather than letting a valid but
 * pathologically large version-3 directory consume several GiB.
 */
const MAX_DIRECTORY_ENTRIES = 1_048_576;

/** Header field offsets; all are relative to the start of the file. */
const HEADER = {
  majorVersion: 0x1a,
  byteOrder: 0x1c,
  sectorShift: 0x1e,
  miniSectorShift: 0x20,
  directorySectorCount: 0x28,
  fatSectorCount: 0x2c,
  firstDirectorySector: 0x30,
  miniStreamCutoff: 0x38,
  firstMiniFatSector: 0x3c,
  miniFatSectorCount: 0x40,
  firstDifatSector: 0x44,
  difatSectorCount: 0x48,
  difatEntries: 0x4c,
} as const;
const DIFAT_ENTRIES_IN_HEADER = 109;
const CFB_BYTE_ORDER_MARK = 0xfffe;

/** Directory entry field offsets; all are relative to the entry start. */
const DIRECTORY_ENTRY_BYTES = 128;
const ENTRY = {
  nameLength: 0x40,
  objectType: 0x42,
  colorFlag: 0x43,
  leftSibling: 0x44,
  rightSibling: 0x48,
  child: 0x4c,
  startingSector: 0x74,
  streamSize: 0x78,
} as const;
const ENTRY_NAME_BYTES = 64;

export type CompoundFileEntryType =
  | "unknown"
  | "storage"
  | "stream"
  | "root-storage";

export interface CompoundFileDirectoryEntry {
  /** Zero-based ordinal of this entry in the directory stream. */
  readonly index: number;
  /**
   * Names from the root storage down, joined by `/`; `null` when the entry is
   * not reachable from the root storage through the directory tree.
   */
  readonly path: string | null;
  /** The declared name, or `null` when its length or encoding is invalid. */
  readonly name: string | null;
  readonly type: CompoundFileEntryType;
  /** The entry this one is listed under, or `null` for the root and orphans. */
  readonly parentIndex: number | null;
  /** Declared tree links, kept as facts even when they point outside the table. */
  readonly leftSibling: number | null;
  readonly rightSibling: number | null;
  readonly child: number | null;
  /** Sector the stream or storage starts at; markers are reported as `null`. */
  readonly startingSector: number | null;
  /** Declared stream length. A storage's own stream is the mini stream. */
  readonly streamSize: number;
  /**
   * False when a version-4 entry declares more bytes than a JavaScript number
   * carries exactly; `streamSize` then holds the largest safe integer.
   */
  readonly streamSizeRepresentable: boolean;
  /**
   * Where the bytes live: the FAT chain, the mini FAT inside the root storage's
   * stream, or nowhere when the entry declares no bytes.
   */
  readonly storage: "fat" | "mini" | "empty";
  /** True when the entry's FAT chain occupies consecutive sectors. */
  readonly contiguous: boolean | null;
  /**
   * True when the chain reaches a sector the FAT, the DIFAT or the directory
   * already owns, so its bytes are container structure rather than content.
   */
  readonly structuralOverlap: boolean;
  /**
   * True when the chain reaches a sector an earlier entry's chain already owns,
   * so publishing these bytes would present one range under two identities.
   */
  readonly sharedOverlap: boolean;
  /** File offset of the first sector, only when the chain is contiguous. */
  readonly byteOffset: number | null;
}

export interface CompoundFileMetadata {
  readonly kind: "compound-file";
  readonly major_version: number;
  readonly sector_bytes: number;
  readonly mini_sector_bytes: number;
  readonly fat_sector_count: number;
  readonly difat_sector_count: number;
  readonly directory_entry_count: number;
  readonly stream_count: number;
  readonly storage_count: number;
  readonly root_storage_count: number;
  readonly unallocated_entry_count: number;
  readonly orphan_entry_count: number;
  /** Directory entries whose declared type is not one the format defines. */
  readonly unreadable_entry_count: number;
  /** Streams whose FAT chain is broken, cyclic or leaves the declared file. */
  readonly broken_chain_count: number;
  /** Sectors declared in the header that its allocation tables do not list. */
  readonly unlisted_fat_sector_count: number;
}

export interface CompoundFileImage {
  readonly metadata: CompoundFileMetadata;
  readonly entries: readonly CompoundFileDirectoryEntry[];
  readonly limitations: readonly string[];
}

const failure = (
  message: string,
  boundary?: RegionDecodeFailure["boundary"],
): RegionDecodeFailure => ({
  kind: "format",
  message,
  ...(boundary === undefined ? {} : { boundary }),
});

const limit = (
  message: string,
  boundary?: RegionDecodeFailure["boundary"],
): RegionDecodeFailure => ({
  kind: "limit",
  message,
  ...(boundary === undefined ? {} : { boundary }),
});

const isMarker = (sector: number): boolean => SECTOR_MARKERS.has(sector);

const sectorOf = (sector: number, sectorBytes: number): number =>
  (sector + 1) * sectorBytes;

/**
 * Walk one allocation chain, bounded by the sector count and rejecting a
 * revisisted sector, so a corrupt table cannot loop or read past the file.
 */
const chainOf = (
  fat: Uint32Array,
  start: number,
  sectorBytes: number,
  fileBytes: number,
): { readonly sectors: readonly number[]; readonly broken: boolean } => {
  const sectors: number[] = [];
  const seen = new Set<number>();
  const sectorCount = fat.length;
  let sector = start;
  while (sector !== CFB_END_OF_CHAIN) {
    if (
      sector >= sectorCount ||
      isMarker(sector) ||
      seen.has(sector) ||
      sectorOf(sector, sectorBytes) + sectorBytes > fileBytes
    )
      return { sectors, broken: true };
    seen.add(sector);
    sectors.push(sector);
    sector = fat[sector] as number;
  }
  return { sectors, broken: false };
};

const entryTypeOf = (raw: number): CompoundFileEntryType | null => {
  switch (raw) {
    case 0:
      return "unknown";
    case 1:
      return "storage";
    case 2:
      return "stream";
    case 5:
      return "root-storage";
    default:
      return null;
  }
};

/** A directory name is UTF-16LE, terminated, and at most 31 characters. */
const nameOf = (
  entry: Uint8Array,
  view: DataView,
): { readonly name: string | null; readonly problem: string | null } => {
  const nameLength = view.getUint16(ENTRY.nameLength, true);
  if (nameLength === 0) return { name: null, problem: null };
  if (nameLength > ENTRY_NAME_BYTES || nameLength % 2 !== 0)
    return {
      name: null,
      problem: `declares a ${String(nameLength)}-byte name, which is not an even length within ${String(ENTRY_NAME_BYTES)} bytes`,
    };
  const bytes = entry.subarray(0, nameLength);
  if (bytes[nameLength - 1] !== 0 || bytes[nameLength - 2] !== 0)
    return {
      name: null,
      problem: "declares a name that does not end with a NUL terminator",
    };
  const decoded = Buffer.from(bytes.subarray(0, nameLength - 2)).toString(
    "utf16le",
  );
  // The name is a single path component. A name that would read as two
  // components, as a parent step, or that carries a NUL is kept as the raw
  // declared text but cannot name a path, so callers project it instead of
  // aborting the inventory on a normalized-path failure.
  if (
    decoded.includes("\0") ||
    decoded.includes("/") ||
    decoded === "." ||
    decoded === ".."
  )
    return {
      name: decoded,
      problem: "declares a name that is not a single safe path component",
    };
  return { name: decoded, problem: null };
};

/**
 * Parse a compound file's header, allocation tables and directory entries.
 *
 * Only the container is established: each entry's declared name, type, size and
 * allocation location, and whether its chain is intact. No artifact-specific
 * stream is interpreted here, so a Jump List's DestList, a shell link's
 * target and any thumbnail bytes remain opaque in this step.
 */
export const parseCompoundFile = (
  bytes: Uint8Array,
): Result<CompoundFileImage, RegionDecodeFailure> => {
  if (bytes.length < COMPOUND_FILE_HEADER_BYTES)
    return err(
      failure(
        `file is ${String(bytes.length)} bytes, shorter than the ${String(COMPOUND_FILE_HEADER_BYTES)}-byte header`,
      ),
    );
  if (!hasCompoundFileSignature(bytes))
    return err(failure("file does not begin with the compound file signature"));

  const limitations: string[] = [];
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const byteOrder = header.getUint16(HEADER.byteOrder, true);
  if (byteOrder !== CFB_BYTE_ORDER_MARK)
    return err(
      failure(
        `header declares byte order ${byteOrder.toString(16)}, not the 0xfffe mark`,
      ),
    );

  const majorVersion = header.getUint16(HEADER.majorVersion, true);
  if (majorVersion !== 3 && majorVersion !== 4)
    return err(
      failure(
        `header declares major version ${String(majorVersion)}; only versions 3 and 4 are supported`,
      ),
    );

  const sectorShift = header.getUint16(HEADER.sectorShift, true);
  const expectedShift = majorVersion === 3 ? 9 : 12;
  if (sectorShift !== expectedShift)
    return err(
      failure(
        `header declares version ${String(majorVersion)} with a sector shift of ${String(sectorShift)}; version ${String(majorVersion)} uses ${String(expectedShift)}`,
      ),
    );
  const sectorBytes = 1 << sectorShift;
  const miniSectorShift = header.getUint16(HEADER.miniSectorShift, true);
  if (miniSectorShift !== 6) {
    limitations.push(
      `header declares a mini sector shift of ${String(miniSectorShift)} rather than 6, so mini stream offsets are not 64 bytes and are not resolved`,
    );
  }
  // JavaScript's `<<` is a signed 32-bit operation and masks its count, so a
  // declared shift of 31 would publish a negative offset that the metadata
  // schema rejects. The value is reported as-is and only a shift the schema can
  // carry is computed.
  const miniSectorBytes =
    miniSectorShift >= 0 && miniSectorShift <= 30
      ? Math.pow(2, miniSectorShift)
      : 0;

  const declaredFatSectors = header.getUint32(HEADER.fatSectorCount, true);
  const declaredDifatSectors = header.getUint32(HEADER.difatSectorCount, true);
  const firstDirectorySector = header.getUint32(
    HEADER.firstDirectorySector,
    true,
  );
  const miniStreamCutoff = header.getUint32(HEADER.miniStreamCutoff, true);
  // CFB fixes this field at 4096. A declared value below it would classify
  // small streams as FAT-backed, so their mini-sector indexes could be read as
  // ordinary sector numbers and resolve to unrelated bytes.
  const cutoffValid = miniStreamCutoff === 4096;
  if (!cutoffValid)
    limitations.push(
      `header declares a mini stream cutoff of ${String(miniStreamCutoff)} rather than the fixed 4096; stream allocation is left unresolved`,
    );
  const firstMiniFatSector = header.getUint32(HEADER.firstMiniFatSector, true);
  const declaredMiniFatSectors = header.getUint32(
    HEADER.miniFatSectorCount,
    true,
  );
  const firstDifatSector = header.getUint32(HEADER.firstDifatSector, true);
  const directorySectorCount = header.getUint32(
    HEADER.directorySectorCount,
    true,
  );
  if (majorVersion === 3 && directorySectorCount !== 0)
    limitations.push(
      `header declares ${String(directorySectorCount)} directory sectors, a field version 3 does not define; it was ignored`,
    );
  if (majorVersion === 4 && directorySectorCount === 0)
    limitations.push(
      "header declares no directory sector, a field version 4 requires",
    );

  const sectorCount = Math.floor(bytes.length / sectorBytes) - 1;
  if (sectorCount <= 0)
    return err(
      failure(
        `file is ${String(bytes.length)} bytes, which holds no whole ${String(sectorBytes)}-byte sector after the header`,
      ),
    );

  // Collect FAT sector ids: 109 inline, then the DIFAT chain.
  const fatSectorIds: number[] = [];
  for (let index = 0; index < DIFAT_ENTRIES_IN_HEADER; index += 1) {
    const sector = header.getUint32(HEADER.difatEntries + index * 4, true);
    if (sector !== CFB_FREE_SECTOR) fatSectorIds.push(sector);
  }
  const difatSectors: number[] = [];
  let difatSector = firstDifatSector;
  const seenDifat = new Set<number>();
  let difatCutShort = false;
  while (difatSector !== CFB_END_OF_CHAIN && difatSector !== CFB_FREE_SECTOR) {
    if (
      difatSector >= sectorCount ||
      seenDifat.has(difatSector) ||
      difatSectors.length >= declaredDifatSectors
    ) {
      limitations.push(
        `the DIFAT chain leaves the declared file or repeats a sector at ${String(difatSector)}; ${String(difatSectors.length)} of ${String(declaredDifatSectors)} DIFAT sector(s) were read`,
      );
      difatCutShort = true;
      break;
    }
    seenDifat.add(difatSector);
    difatSectors.push(difatSector);
    const offset = sectorOf(difatSector, sectorBytes);
    const difat = new DataView(
      bytes.buffer,
      bytes.byteOffset + offset,
      sectorBytes,
    );
    const perSector = sectorBytes / 4 - 1;
    for (let index = 0; index < perSector; index += 1) {
      const sector = difat.getUint32(index * 4, true);
      // A malformed chain can name far more FAT sectors than the file holds.
      // Bound the collection while it grows rather than after the whole chain:
      // a near-ceiling v3 file would otherwise retain tens of millions of ids
      // before the count check ran.
      if (sector !== CFB_FREE_SECTOR) {
        fatSectorIds.push(sector);
        if (fatSectorIds.length > sectorCount)
          return err(
            failure(
              `DIFAT names more than the ${String(sectorCount)} FAT sector(s) the file holds`,
            ),
          );
      }
    }
    difatSector = difat.getUint32(perSector * 4, true);
  }
  if (!difatCutShort && difatSectors.length !== declaredDifatSectors)
    limitations.push(
      `header declares ${String(declaredDifatSectors)} DIFAT sector(s) but the chain holds ${String(difatSectors.length)}`,
    );

  const entriesPerSector = sectorBytes / 4;
  // A malformed DIFAT can repeat sector ids, so the table is bounded by the
  // sectors the file actually holds rather than by the DIFAT's own count.
  if (fatSectorIds.length > sectorCount)
    return err(
      failure(
        `DIFAT names ${String(fatSectorIds.length)} FAT sector(s), more than the ${String(sectorCount)} sector(s) the file holds`,
      ),
    );
  // Only ceil(sectorCount / entriesPerSector) blocks can describe a physical
  // sector, so a longer list is duplicates of blocks already read. Expanding
  // every id would allocate a cell per listed block and let a near-ceiling
  // malformed file reserve hundreds of MiB for cells no chain can reach.
  const fatBlockLimit = Math.ceil(sectorCount / entriesPerSector);
  const excessFatBlocks = Math.max(0, fatSectorIds.length - fatBlockLimit);
  const fat = new Uint32Array(
    Math.min(fatSectorIds.length, fatBlockLimit) * entriesPerSector,
  );
  // DIFAT order defines which FAT indexes each sector supplies, so a block is
  // kept at its declared ordinal: a repeated or out-of-file id leaves its cells
  // as markers instead of letting a later block shift one position early.
  let fatCells = 0;
  let unlistedFatSectors = 0;
  const seenFatSectors = new Set<number>();
  for (const sector of fatSectorIds) {
    // A block the DIFAT chain itself occupies is container structure, not FAT
    // cells: the last word of a DIFAT sector is simultaneously a FAT cell, so
    // reading it as one would let an ENDOFCHAIN pointer make an arbitrary
    // sector look like a complete stream.
    const usable =
      sector < sectorCount &&
      !isMarker(sector) &&
      !seenDifat.has(sector) &&
      !seenFatSectors.has(sector);
    if (usable) {
      seenFatSectors.add(sector);
      if (fatCells < fat.length) {
        const offset = sectorOf(sector, sectorBytes);
        const sectorView = new DataView(
          bytes.buffer,
          bytes.byteOffset + offset,
          sectorBytes,
        );
        for (let index = 0; index < entriesPerSector; index += 1) {
          fat[fatCells + index] = sectorView.getUint32(index * 4, true);
        }
      }
    } else {
      unlistedFatSectors += 1;
      fat.fill(
        CFB_FREE_SECTOR,
        fatCells,
        Math.min(fatCells + entriesPerSector, fat.length),
      );
    }
    fatCells = Math.min(fatCells + entriesPerSector, fat.length);
  }
  const table = fat.subarray(0, fatCells);
  if (fatSectorIds.length !== declaredFatSectors)
    limitations.push(
      `header declares ${String(declaredFatSectors)} FAT sector(s) but the DIFAT lists ${String(fatSectorIds.length)}`,
    );
  if (excessFatBlocks !== 0)
    limitations.push(
      `the DIFAT lists ${String(excessFatBlocks)} FAT sector(s) beyond the ${String(fatBlockLimit)} block(s) that can describe a sector of this ${String(sectorCount)}-sector file; those blocks address no physical sector and were not expanded`,
    );
  // The field counts header-declared sectors absent from the allocation
  // tables, so a declared-but-never-listed sector belongs here beside the ids
  // that were listed and unusable.
  const missingFatSectors = Math.max(
    0,
    declaredFatSectors - fatSectorIds.length,
  );
  if (missingFatSectors !== 0 || unlistedFatSectors !== 0) {
    const parts = [
      ...(unlistedFatSectors === 0
        ? []
        : [
            `${String(unlistedFatSectors)} declared FAT sector(s) lie outside the file or are already owned by the DIFAT chain and were not read`,
          ]),
      ...(missingFatSectors === 0
        ? []
        : [
            `${String(missingFatSectors)} header-declared FAT sector(s) are absent from the DIFAT`,
          ]),
    ];
    limitations.push(parts.join("; "));
  }
  if (table.length === 0)
    return err(failure("the header lists no FAT sector within the file"));

  // The directory stream is a FAT chain; its sectors hold the entries.
  const directoryChain = chainOf(
    table,
    firstDirectorySector,
    sectorBytes,
    bytes.length,
  );
  if (directoryChain.broken)
    return err(
      failure(
        `the directory chain starting at sector ${String(firstDirectorySector)} is broken or leaves the file`,
      ),
    );
  if (directoryChain.sectors.length === 0)
    return err(failure("the directory stream holds no sector"));
  // A directory chain that runs through allocation-table sectors would let
  // FAT cells be read as object types and names, so the whole interpretation is
  // rejected rather than reported as a partial directory.
  if (
    directoryChain.sectors.some(
      (sector) => seenFatSectors.has(sector) || seenDifat.has(sector),
    )
  )
    return err(
      failure(
        `the directory chain starting at sector ${String(firstDirectorySector)} reuses a FAT or DIFAT sector`,
      ),
    );
  // A mini-FAT chain is container structure too: a stream that reaches one of
  // its sectors would publish allocation cells as member bytes.
  const miniFatChain = chainOf(
    table,
    firstMiniFatSector,
    sectorBytes,
    bytes.length,
  );
  // The FAT, the DIFAT, the directory and the mini FAT are container
  // structure, not content, so a stream whose chain reaches one of those
  // sectors is published as an unresolved range instead of as that structure's
  // bytes.
  const structuralSectors = new Set<number>([
    ...seenFatSectors,
    ...difatSectors,
    ...directoryChain.sectors,
    ...miniFatChain.sectors,
  ]);
  if (
    majorVersion === 4 &&
    directorySectorCount !== 0 &&
    directoryChain.sectors.length !== directorySectorCount
  )
    limitations.push(
      `header declares ${String(directorySectorCount)} directory sector(s) but its chain holds ${String(directoryChain.sectors.length)}`,
    );

  const directoryBytes = new Uint8Array(
    directoryChain.sectors.length * sectorBytes,
  );
  directoryChain.sectors.forEach((sector, position) => {
    const offset = sectorOf(sector, sectorBytes);
    directoryBytes.set(
      bytes.subarray(offset, offset + sectorBytes),
      position * sectorBytes,
    );
  });

  const directory = new DataView(
    directoryBytes.buffer,
    directoryBytes.byteOffset,
    directoryBytes.byteLength,
  );
  const entryCount = Math.floor(directoryBytes.length / DIRECTORY_ENTRY_BYTES);
  // The chain's sectors, the image copy and one RawEntry per 128 bytes are
  // all retained, so a structurally valid directory that fills most of the
  // 512 MiB ceiling would cost several GiB. Refuse it as a modeled limit
  // instead of expanding it.
  if (entryCount > MAX_DIRECTORY_ENTRIES)
    return err(
      limit(
        `the directory stream holds ${String(entryCount)} entries, more than the ${String(MAX_DIRECTORY_ENTRIES)}-entry allowance`,
        "capacity",
      ),
    );
  const raw = Array.from({ length: entryCount }, (_, index) =>
    readEntry(directoryBytes, directory, index, majorVersion),
  );
  for (const problem of new Set(
    raw.map((entry) => entry.nameProblem).filter((text) => text !== null),
  ))
    limitations.push(`directory entry ${problem}`);
  const undefinedTypes = raw.filter((entry) => !entry.definedType).length;
  if (undefinedTypes !== 0)
    limitations.push(
      `${String(undefinedTypes)} directory entr(ies) declare an object type the format does not define; they are listed without a role`,
    );

  // CFB fixes the root storage at directory entry 0; a later type-5 record is
  // an extra root, and following it would present an arbitrary storage's child
  // tree as the canonical hierarchy.
  const extraRoots = raw.filter(
    (entry, index) => index !== 0 && entry.type === "root-storage",
  ).length;
  if (extraRoots !== 0)
    limitations.push(
      `${String(extraRoots)} directory entr(ies) outside entry 0 declare a root storage; the format fixes the root at entry 0, so their subtrees are not presented as the hierarchy`,
    );
  const rootIndex = raw.length > 0 && raw[0]?.type === "root-storage" ? 0 : -1;
  if (rootIndex === -1)
    return err(
      failure(
        raw.some((entry) => entry.type === "root-storage")
          ? "directory entry 0 is not the root storage the format fixes there"
          : "the directory stream holds no root storage entry",
      ),
    );

  // Walk each storage's red-black tree so every reachable entry is named by its
  // path. A cycle or a link outside the table is reported, not followed.
  const parents = new Map<number, number>();
  const paths = new Map<number, string>();
  const visited = new Set<number>();
  let cycleCount = 0;
  let depthLimited = 0;
  const visit = (index: number, parent: number, prefix: string): void => {
    // An explicit stack keeps a long sibling chain from nesting one call per
    // entry; a malformed tree can hold far more than the call stack allows.
    const pending: {
      index: number;
      parent: number;
      prefix: string;
      depth: number;
    }[] = [{ index, parent, prefix, depth: 0 }];
    while (pending.length > 0) {
      const next = pending.pop() as {
        index: number;
        parent: number;
        prefix: string;
        depth: number;
      };
      const entryIndex = next.index;
      if (entryIndex >= entryCount) {
        limitations.push(
          `directory entry ${String(next.parent)} links to entry ${String(entryIndex)}, which is outside the ${String(entryCount)} entries the directory stream holds`,
        );
        continue;
      }
      if (visited.has(entryIndex)) {
        cycleCount += 1;
        continue;
      }
      visited.add(entryIndex);
      parents.set(entryIndex, next.parent);
      const entry = raw[entryIndex] as RawEntry;
      const path =
        entry.name === null
          ? null
          : next.prefix === ""
            ? entry.name
            : `${next.prefix}/${entry.name}`;
      if (path !== null) paths.set(entryIndex, path);
      // An unallocated or undefined-type slot belongs to no tree. Its links are
      // stale fields of a free record: following them would name a live entry
      // under a fabricated hierarchy and drop it from the orphan count.
      if (entry.type === "unknown") continue;
      // Siblings share this entry's parent, so they keep its prefix; only a
      // storage's children take its full path.
      if (entry.leftSibling !== null)
        pending.push({
          index: entry.leftSibling,
          parent: next.parent,
          prefix: next.prefix,
          depth: next.depth,
        });
      if (entry.rightSibling !== null)
        pending.push({
          index: entry.rightSibling,
          parent: next.parent,
          prefix: next.prefix,
          depth: next.depth,
        });
      // Only a storage owns a child tree.
      if (
        (entry.type === "storage" || entry.type === "root-storage") &&
        entry.child !== null
      ) {
        if (next.depth >= MAX_TREE_DEPTH) {
          depthLimited += 1;
          continue;
        }
        pending.push({
          index: entry.child,
          parent: entryIndex,
          prefix: path ?? next.prefix,
          depth: next.depth + 1,
        });
      }
    }
  };
  const visitTree = (
    index: number | null,
    parent: number,
    prefix: string,
  ): void => {
    if (index === null) return;
    visit(index, parent, prefix);
  };
  const root = raw[rootIndex] as RawEntry;
  visited.add(rootIndex);
  paths.set(rootIndex, "");
  visitTree(root.child, rootIndex, "");

  if (cycleCount !== 0)
    limitations.push(
      `${String(cycleCount)} directory tree link(s) lead back to an entry already listed; those entries keep their first path and the repeating link was not followed`,
    );
  if (depthLimited !== 0)
    limitations.push(
      `${String(depthLimited)} storage(s) nest deeper than ${String(MAX_TREE_DEPTH)} levels; their descendant paths are not resolved`,
    );
  const orphanCount = raw.filter(
    (entry, index) =>
      index !== rootIndex && entry.type !== "unknown" && !visited.has(index),
  ).length;
  if (orphanCount !== 0)
    limitations.push(
      `${String(orphanCount)} directory entr(ies) are not reachable from the root storage and have no path`,
    );

  // Only streams and the root storage's mini stream have stream allocation
  // semantics; an ordinary storage's size and start fields are stale.
  const allocationBearing = (entry: RawEntry): boolean =>
    entry.type === "stream" || entry.type === "root-storage";
  let brokenChains = 0;
  let overlappingChains = 0;
  let sharedChains = 0;
  // Two entries can name the same starting sector or merge chains, which would
  // publish the same bytes under two identities. The first entry in directory
  // order owns the sectors; a later chain that reaches one of them is left
  // unresolved instead of being read as its own member.
  const ownedSectors = new Map<number, number>();
  const entries: CompoundFileDirectoryEntry[] = raw.map((entry, index) => {
    const parent = parents.get(index) ?? null;
    const path = paths.get(index) ?? null;
    const startingSector = isMarker(entry.startingSector)
      ? null
      : entry.startingSector;
    // A stream is empty only when it declares no bytes. A stream that declares
    // bytes but starts at a marker reaches none of them, which is a broken
    // chain rather than an empty stream.
    const markerStartWithBytes =
      isMarker(entry.startingSector) && entry.streamSize > 0;
    const empty = entry.streamSize === 0;
    const storage: CompoundFileDirectoryEntry["storage"] =
      !allocationBearing(entry) || !cutoffValid
        ? "empty"
        : empty
          ? "empty"
          : entry.type !== "root-storage" && entry.streamSize < 4096
            ? "mini"
            : "fat";
    if (markerStartWithBytes) brokenChains += 1;
    if (storage !== "fat" || startingSector === null)
      return {
        index,
        path,
        name: entry.name,
        type: entry.type,
        parentIndex: parent,
        leftSibling: entry.leftSibling,
        rightSibling: entry.rightSibling,
        child: entry.child,
        startingSector,
        streamSize: entry.streamSize,
        streamSizeRepresentable: !entry.streamSizeUnrepresentable,
        storage,
        contiguous: null,
        structuralOverlap: false,
        sharedOverlap: false,
        byteOffset: null,
      };
    const chain = chainOf(table, startingSector, sectorBytes, bytes.length);
    const needed = Math.ceil(entry.streamSize / sectorBytes);
    // A chain is complete when it did not break and reaches the declared size.
    // Contiguity is a separate fact: a short chain whose reached sectors happen
    // to be consecutive is still incomplete.
    const complete = !chain.broken && chain.sectors.length >= needed;
    const contiguous =
      !chain.broken &&
      chain.sectors.every(
        (sector, position) => sector === startingSector + position,
      );
    if (!complete && !markerStartWithBytes) brokenChains += 1;
    const structuralOverlap = chain.sectors.some((sector) =>
      structuralSectors.has(sector),
    );
    const sharedOverlap = chain.sectors.some((sector) => {
      const owner = ownedSectors.get(sector);
      return owner !== undefined && owner !== index;
    });
    if (structuralOverlap) overlappingChains += 1;
    if (sharedOverlap) sharedChains += 1;
    // Only a chain that becomes the owner of its sectors can be published with
    // a byte range; the chain itself is complete regardless.
    if (!structuralOverlap && !sharedOverlap)
      for (const sector of chain.sectors)
        if (!ownedSectors.has(sector)) ownedSectors.set(sector, index);
    return {
      index,
      path,
      name: entry.name,
      type: entry.type,
      parentIndex: parent,
      leftSibling: entry.leftSibling,
      rightSibling: entry.rightSibling,
      child: entry.child,
      startingSector,
      streamSize: entry.streamSize,
      streamSizeRepresentable: !entry.streamSizeUnrepresentable,
      storage,
      contiguous,
      structuralOverlap,
      sharedOverlap,
      byteOffset:
        contiguous && complete && !structuralOverlap && !sharedOverlap
          ? sectorOf(startingSector, sectorBytes)
          : null,
    };
  });

  if (overlappingChains !== 0)
    limitations.push(
      `${String(overlappingChains)} stream(s) reach sectors the FAT, the DIFAT or the directory already owns; their byte ranges are left unresolved rather than reading container structure as content`,
    );
  if (sharedChains !== 0)
    limitations.push(
      `${String(sharedChains)} stream(s) reach sectors another stream already owns; their byte ranges are left unresolved rather than reading the same bytes under two identities`,
    );

  if (brokenChains !== 0)
    limitations.push(
      `${String(brokenChains)} stream(s) declare more bytes than their allocation chain reaches; their bytes are incomplete or the chain is broken`,
    );
  if (firstMiniFatSector !== CFB_END_OF_CHAIN && declaredMiniFatSectors === 0)
    limitations.push(
      "header names a mini FAT sector but declares no mini FAT sectors; mini stream contents are not resolved",
    );

  const metadata: CompoundFileMetadata = {
    kind: "compound-file",
    major_version: majorVersion,
    sector_bytes: sectorBytes,
    mini_sector_bytes: miniSectorBytes,
    fat_sector_count: table.length / entriesPerSector,
    difat_sector_count: difatSectors.length,
    directory_entry_count: entries.length,
    stream_count: entries.filter((entry) => entry.type === "stream").length,
    storage_count: entries.filter((entry) => entry.type === "storage").length,
    root_storage_count: entries.filter((entry) => entry.type === "root-storage")
      .length,
    // Only a declared type 0 is unallocated; a type the format does not define
    // is counted once, in `unreadable_entry_count`.
    unallocated_entry_count: raw.filter((entry) => entry.declaredType === 0)
      .length,
    orphan_entry_count: orphanCount,
    unreadable_entry_count: raw.filter((entry) => !entry.definedType).length,
    broken_chain_count: brokenChains,
    unlisted_fat_sector_count: missingFatSectors + unlistedFatSectors,
  };

  return ok({ metadata, entries, limitations });
};

interface RawEntry {
  readonly name: string | null;
  readonly nameProblem: string | null;
  readonly type: CompoundFileEntryType;
  readonly definedType: boolean;
  /** The type byte exactly as declared, before it is mapped or rejected. */
  readonly declaredType: number;
  readonly leftSibling: number | null;
  readonly rightSibling: number | null;
  readonly child: number | null;
  readonly startingSector: number;
  readonly streamSize: number;
  /**
   * Set when a version-4 entry declares more bytes than a JavaScript number
   * carries exactly; the value is reported as unresolved rather than truncated.
   */
  readonly streamSizeUnrepresentable: boolean;
}

const readEntry = (
  directoryBytes: Uint8Array,
  directory: DataView,
  index: number,
  majorVersion: number,
): RawEntry => {
  const base = index * DIRECTORY_ENTRY_BYTES;
  const entry = directoryBytes.subarray(base, base + DIRECTORY_ENTRY_BYTES);
  const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
  const { name, problem } = nameOf(entry, view);
  const rawType = directory.getUint8(base + ENTRY.objectType);
  const type = entryTypeOf(rawType);
  // Version 3 entries only carry the low 32 bits of the stream size; the high
  // 32 bits are reserved and may be stale. Version 4 uses the whole 64-bit
  // field, so masking it there would turn 0x1_00000001 into a one-byte stream.
  const rawSize = view.getBigUint64(ENTRY.streamSize, true);
  const declaredSize = majorVersion === 3 ? rawSize & 0xffff_ffffn : rawSize;
  const streamSizeUnrepresentable =
    declaredSize > BigInt(Number.MAX_SAFE_INTEGER);
  const streamSize = streamSizeUnrepresentable
    ? Number.MAX_SAFE_INTEGER
    : Number(declaredSize);
  const linkOf = (offset: number): number | null => {
    const value = view.getUint32(offset, true);
    return value === CFB_FREE_SECTOR ? null : value;
  };
  return {
    name,
    nameProblem: problem,
    type: type ?? "unknown",
    definedType: type !== null,
    declaredType: rawType,
    leftSibling: linkOf(ENTRY.leftSibling),
    rightSibling: linkOf(ENTRY.rightSibling),
    child: linkOf(ENTRY.child),
    startingSector: view.getUint32(ENTRY.startingSector, true),
    streamSize,
    streamSizeUnrepresentable,
  };
};

/** Streaming form of the same parse: the whole admitted file is buffered once. */
class StreamingCompoundFileDecoder implements RegionDecoder<CompoundFileImage> {
  readonly #chunks: Uint8Array[] = [];
  #length = 0;

  constructor(readonly fileBytes: number) {}

  write(chunk: Uint8Array): Result<void, RegionDecodeFailure> {
    this.#chunks.push(chunk);
    this.#length += chunk.length;
    return ok(undefined);
  }

  finish(): Result<CompoundFileImage, RegionDecodeFailure> {
    // The chunks are copied into one image once; the chunk list is released
    // before parsing so a file near the ceiling does not retain two copies.
    const bytes = new Uint8Array(this.#length);
    let written = 0;
    for (const chunk of this.#chunks) {
      bytes.set(chunk, written);
      written += chunk.length;
    }
    this.#chunks.length = 0;
    return parseCompoundFile(bytes);
  }
}

export const createCompoundFileDecoder = (
  fileBytes: number,
): Result<RegionDecoder<CompoundFileImage>, RegionDecodeFailure> =>
  Number.isSafeInteger(fileBytes) &&
  fileBytes >= 0 &&
  fileBytes <= COMPOUND_FILE_MAX_BYTES
    ? ok(new StreamingCompoundFileDecoder(fileBytes))
    : err(
        limit(
          `file is ${String(fileBytes)} bytes, exceeding the fixed ${String(COMPOUND_FILE_MAX_BYTES)}-byte (512 MiB) ceiling`,
          "file-size",
        ),
      );
