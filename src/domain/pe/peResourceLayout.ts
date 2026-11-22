import {
  PE_RESOURCE_DATA_ENTRY_BYTES,
  PE_RESOURCE_DIRECTORY_BYTES,
  PE_RESOURCE_ENTRY_BYTES,
  PE_RESOURCE_ENTRY_LIMIT,
  PE_RESOURCE_NAME_PREFIX_BYTES,
  peResourceRangeFits,
  readPeResourceDataEntryFacts,
  readPeResourceDirectoryFacts,
  readPeResourceEntryFacts,
  readPeResourceNameFacts,
} from "./peResourceTreeFacts.js";
import { err, ok, type Result } from "../result.js";
import { BinaryFormatFailure } from "../binaryContainer.js";
import { decodeLimit, ParseFailureError } from "../parseFailure.js";
import {
  PE_SECTION_HEADER_BYTES,
  readPeSectionHeader,
} from "../peSectionHeader.js";
import {
  peFailure,
  readPeImageHeaders,
  readPeImageHeadersAt,
  type PeRangeReader,
  requirePeExtent,
} from "./peImageHeaders.js";

interface Section {
  readonly rva: number;
  readonly virtualSize: number;
  readonly offset: number;
  readonly size: number;
}

// RVA ownership follows the declared virtual extent. Raw size describes
// initialized file bytes and can include file-alignment padding; loaders may
// map page-rounded tails, but those bytes are outside the declared section.
const virtualExtent = (section: Section): number =>
  section.virtualSize === 0 ? section.size : section.virtualSize;

// Intersection normalized with those ownership rules: a section without
// virtual extent owns no byte and never conflicts, while an empty resource
// owns exactly its start point, so a positive-extent section starting there
// conflicts with header-backed ownership of the same RVA.
const intersectsResource = (
  section: Section,
  rva: number,
  size: number,
): boolean => {
  const extent = virtualExtent(section);
  return (
    extent > 0 &&
    section.rva < rva + Math.max(size, 1) &&
    rva < section.rva + extent
  );
};

/** Header admission and unambiguous file-backed RVA mapping, independent of section names. */
export const readPeResourceLayout = (bytes: Buffer) =>
  mapPeResourceLayout(readPeImageHeaders(bytes), bytes.length);

const mapPeResourceLayout = (
  headers: ReturnType<typeof readPeImageHeaders>,
  fileSize: number,
) => {
  const {
    machine,
    format,
    sectionCount,
    optionalHeaderOffset,
    directoryOffset,
    dataDirectories,
    headerSize,
    sectionTable,
  } = headers;
  const sections: Section[] = [];
  for (let index = 0; index < sectionCount; index++) {
    const at = index * PE_SECTION_HEADER_BYTES;
    const parsed = readPeSectionHeader(
      sectionTable.subarray(at, at + PE_SECTION_HEADER_BYTES),
    );
    if (!parsed.ok) return peFailure(parsed.error.message);
    const row = parsed.value;
    const section = {
      rva: row.virtual_address,
      virtualSize: row.virtual_size,
      offset: row.offset,
      size: row.raw_size,
    };
    if (section.rva + virtualExtent(section) > 0x100000000)
      peFailure("PE section RVA range overflows.");
    if (section.size > 0) {
      requirePeExtent(fileSize, section.offset, section.size);
      if (section.offset < headerSize)
        peFailure("PE section raw bytes overlap headers.");
    }
    sections.push(section);
  }
  const backed = sections
    .filter(({ size }) => size > 0)
    .sort((left, right) => left.offset - right.offset);
  for (let index = 1; index < backed.length; index++) {
    const previous = backed[index - 1];
    const current = backed[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      current.offset < previous.offset + previous.size
    )
      peFailure("PE sections have overlapping raw file ranges.");
  }
  const sortedByRva = sections
    .map((section) => ({ section, extent: virtualExtent(section) }))
    .filter((entry) => entry.extent > 0)
    .sort((left, right) => left.section.rva - right.section.rva);
  const prefixMaxEnd = new Array<number>(sortedByRva.length);
  let maxEnd = 0;
  for (let index = 0; index < sortedByRva.length; index += 1) {
    const entry = sortedByRva[index]!;
    const end = entry.section.rva + entry.extent;
    if (end > maxEnd) maxEnd = end;
    prefixMaxEnd[index] = maxEnd;
  }
  const firstWithEndGreaterThan = (value: number): number => {
    let lo = 0;
    let hi = sortedByRva.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (prefixMaxEnd[mid]! <= value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const firstWithEndAtLeast = (value: number): number => {
    let lo = 0;
    let hi = sortedByRva.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (prefixMaxEnd[mid]! < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const firstWithRvaAtLeast = (start: number, value: number): number => {
    let lo = start;
    let hi = sortedByRva.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sortedByRva[mid]!.section.rva < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const map = (rva: number, size: number): number => {
    if (rva + size > 0x100000000) peFailure("Resource RVA range overflows.");
    if (rva < headerSize) {
      const checkStart = firstWithEndGreaterThan(rva);
      const checkEnd = firstWithRvaAtLeast(
        checkStart,
        size === 0 ? rva + 1 : rva + size,
      );
      let intersectsHeader = false;
      for (let index = checkStart; index < checkEnd; index += 1) {
        if (intersectsResource(sortedByRva[index]!.section, rva, size)) {
          intersectsHeader = true;
          break;
        }
      }
      if (intersectsHeader || size > headerSize - rva)
        peFailure("Ambiguous resource header RVA mapping.");
      requirePeExtent(fileSize, rva, size);
      return rva;
    }
    const containStart = firstWithEndGreaterThan(rva);
    const containEnd = firstWithRvaAtLeast(containStart, rva + 1);
    let candidateCount = 0;
    let candidate: (typeof sortedByRva)[number] | undefined;
    for (let index = containStart; index < containEnd; index += 1) {
      const entry = sortedByRva[index]!;
      if (rva >= entry.section.rva && rva - entry.section.rva < entry.extent) {
        candidateCount += 1;
        if (candidate === undefined) candidate = entry;
      }
    }
    // An empty interval reads no bytes, so the Windows resource loader also
    // resolves it exactly at a section's virtual end. A section starting at
    // that RVA still owns it.
    if (size === 0 && candidateCount === 0) {
      const endStart = firstWithEndAtLeast(rva);
      const endStop = firstWithRvaAtLeast(endStart, rva + 1);
      for (let index = endStart; index < endStop; index += 1) {
        const entry = sortedByRva[index]!;
        if (rva - entry.section.rva === entry.extent) {
          candidateCount += 1;
          if (candidate === undefined) candidate = entry;
        }
      }
    }
    if (candidateCount !== 1 || candidate === undefined)
      return peFailure(
        "Resource RVA has missing or overlapping section mappings.",
      );
    const section = candidate.section;
    const within = rva - section.rva;
    if (size > candidate.extent - within)
      peFailure("Resource range leaves its section's virtual size.");
    if (within > section.size || size > section.size - within)
      peFailure("Resource range is not entirely file-backed in one section.");
    // A second section with virtual extent inside the requested interval is
    // ambiguous too; a zero-extent section owns no byte there.
    const overlapStart = firstWithEndGreaterThan(rva);
    const overlapEnd = firstWithRvaAtLeast(
      overlapStart,
      size === 0 ? rva + 1 : rva + size,
    );
    for (let index = overlapStart; index < overlapEnd; index += 1) {
      const other = sortedByRva[index]!.section;
      if (other !== section && intersectsResource(other, rva, size))
        peFailure("Resource interval intersects overlapping virtual sections.");
    }
    const offset = section.offset + within;
    requirePeExtent(fileSize, offset, size);
    return offset;
  };
  const resource = dataDirectories[2];
  const directoryAt =
    optionalHeaderOffset + (resource?.offset ?? directoryOffset + 2 * 8);
  const rva = resource?.address ?? 0;
  const size = resource?.size ?? 0;
  if ((rva === 0) !== (size === 0))
    peFailure("Inconsistent PE resource directory RVA/size.");
  return {
    format,
    machine,
    directoryAt,
    rva,
    size,
    map,
  };
};

/** File-backed bytes of one resource data entry. */
export interface PeResourcePayloadRange {
  readonly offset: number;
  readonly bytes: number;
}

type DirectoryFailure = "unreadable" | ParseFailureError<"limit">;

/** Budgeted reads relative to one admitted resource root. */
class PeResourceTree {
  #examined = 0;

  constructor(
    readonly layout: ReturnType<typeof readPeResourceLayout>,
    private readonly root: number,
    private readonly read: PeRangeReader,
    private readonly maxEntries: number,
  ) {}

  contains(at: number, length: number): boolean {
    return peResourceRangeFits(at, length, this.layout.size);
  }

  relative(at: number, length: number): Promise<Buffer | undefined> {
    return this.contains(at, length)
      ? this.read(this.root + at, length)
      : Promise.resolve(undefined);
  }

  async directory(at: number): Promise<Result<Buffer, DirectoryFailure>> {
    const header = await this.relative(at, PE_RESOURCE_DIRECTORY_BYTES);
    if (header === undefined) return err("unreadable");
    const { entryCount } = readPeResourceDirectoryFacts(header);
    const rowsAt = at + PE_RESOURCE_DIRECTORY_BYTES;
    const rowsBytes = entryCount * PE_RESOURCE_ENTRY_BYTES;
    if (!this.contains(rowsAt, rowsBytes)) return err("unreadable");
    const required = this.#examined + entryCount;
    if (required > this.maxEntries)
      return err(
        decodeLimit(
          "pe",
          `PE resource directory needs at least ${required} entries; the inspection allowance is ${this.maxEntries}.`,
          { name: PE_RESOURCE_ENTRY_LIMIT, maximum: this.maxEntries, required },
        ),
      );
    this.#examined = required;
    const rows = await this.relative(rowsAt, rowsBytes);
    return rows === undefined ? err("unreadable") : ok(rows);
  }
}

const openPeResourceTree = async (
  prefix: Buffer,
  fileSize: number,
  read: PeRangeReader,
  maxEntries: number,
): Promise<PeResourceTree | undefined> => {
  try {
    const headers = await readPeImageHeadersAt(prefix, fileSize, read);
    const layout = mapPeResourceLayout(headers, fileSize);
    if (layout.size < PE_RESOURCE_DIRECTORY_BYTES) return undefined;
    return new PeResourceTree(
      layout,
      layout.map(layout.rva, layout.size),
      read,
      maxEntries,
    );
  } catch (cause) {
    if (
      (cause instanceof ParseFailureError && cause.kind === "malformed") ||
      (cause instanceof BinaryFormatFailure && cause.kind === "unsupported")
    )
      return undefined;
    throw cause;
  }
};

/** Walk state: whether a `typeId` branch could not be examined for `name`. */
interface NamedResourceWalk {
  unresolved?: DirectoryFailure;
}

/**
 * Targets of the `name` entries under each `typeId` type directory. A type
 * branch that is not a directory, whose names directory cannot be read, or a
 * name entry whose string cannot be read is recorded in `walk` rather than
 * treated as absent.
 */
async function* namedResourceTargets(
  tree: PeResourceTree,
  typeId: number,
  name: string,
  walk: NamedResourceWalk,
) {
  const root = await tree.directory(0);
  if (!root.ok) return;
  const types = root.value;
  const expected = Buffer.from(name, "utf16le");
  for (let at = 0; at < types.length; at += PE_RESOURCE_ENTRY_BYTES) {
    const type = readPeResourceEntryFacts(
      types.subarray(at, at + PE_RESOURCE_ENTRY_BYTES),
    );
    if (type.identity.kind !== "id" || type.identity.id !== typeId) continue;
    const directory =
      type.target.kind === "directory"
        ? await tree.directory(type.target.offset)
        : err("unreadable" as const);
    if (!directory.ok) {
      if (directory.error === "unreadable" || walk.unresolved === undefined)
        walk.unresolved = directory.error;
      continue;
    }
    const names = directory.value;
    for (
      let entry = 0;
      entry < names.length;
      entry += PE_RESOURCE_ENTRY_BYTES
    ) {
      const { identity, target } = readPeResourceEntryFacts(
        names.subarray(entry, entry + PE_RESOURCE_ENTRY_BYTES),
      );
      if (identity.kind !== "name") continue;
      const nameAt = identity.offset;
      const length = await tree.relative(nameAt, PE_RESOURCE_NAME_PREFIX_BYTES);
      if (length === undefined) {
        walk.unresolved = "unreadable";
        continue;
      }
      const { utf16Units, payloadBytes } = readPeResourceNameFacts(length);
      const payloadAt = nameAt + PE_RESOURCE_NAME_PREFIX_BYTES;
      if (!tree.contains(payloadAt, payloadBytes)) {
        walk.unresolved = "unreadable";
        continue;
      }
      if (utf16Units !== name.length) continue;
      const candidate = await tree.relative(payloadAt, payloadBytes);
      if (candidate === undefined) walk.unresolved = "unreadable";
      else if (candidate.equals(expected)) yield target;
    }
  }
}

/**
 * Bounded admission probe: whether the root type directory holds a `typeId`
 * subdirectory naming `name`. Reads only the header records and the
 * directories on that path; an unadmitted layout or malformed tree reports
 * false so callers can leave full resource parsing to confirmed carriers.
 */
export const hasPeResourceName = async (
  prefix: Buffer,
  fileSize: number,
  read: PeRangeReader,
  typeId: number,
  name: string,
  maxEntries: number,
): Promise<boolean> => {
  const tree = await openPeResourceTree(prefix, fileSize, read, maxEntries);
  if (tree === undefined) return false;
  const first = await namedResourceTargets(tree, typeId, name, {}).next();
  return first.done !== true;
};

/**
 * Payload ranges of the `typeId` resource named `name`, from the same bounded
 * walk as `hasPeResourceName`. The image is not read whole. A tree that never
 * reaches the name reports no ranges. Once the name is found, unreadable
 * framing in the selected path or a peer type branch remains malformed and
 * an exhausted entry allowance remains a limit failure.
 */
export const locatePeResourcePayloads = async (
  prefix: Buffer,
  fileSize: number,
  read: PeRangeReader,
  typeId: number,
  name: string,
  maxEntries: number,
): Promise<readonly PeResourcePayloadRange[]> => {
  const tree = await openPeResourceTree(prefix, fileSize, read, maxEntries);
  if (tree === undefined) return [];
  const found: PeResourcePayloadRange[] = [];
  const walk: NamedResourceWalk = {};
  for await (const target of namedResourceTargets(tree, typeId, name, walk)) {
    if (target.kind !== "directory")
      return peFailure(`PE ${name} resource directory is unreadable.`);
    const directory = await tree.directory(target.offset);
    if (!directory.ok) {
      if (directory.error === "unreadable")
        return peFailure(`PE ${name} resource directory is unreadable.`);
      throw directory.error;
    }
    const languages = directory.value;
    const before = found.length;
    for (let at = 0; at < languages.length; at += PE_RESOURCE_ENTRY_BYTES) {
      const language = readPeResourceEntryFacts(
        languages.subarray(at, at + PE_RESOURCE_ENTRY_BYTES),
      );
      if (language.target.kind !== "data")
        return peFailure(`PE ${name} resource language entry is a directory.`);
      const data = await tree.relative(
        language.target.offset,
        PE_RESOURCE_DATA_ENTRY_BYTES,
      );
      if (data === undefined)
        return peFailure(`PE ${name} resource data entry is truncated.`);
      const { rva, size } = readPeResourceDataEntryFacts(data);
      found.push({ offset: tree.layout.map(rva, size), bytes: size });
    }
    if (found.length === before)
      return peFailure(`PE ${name} resource has no data entry.`);
  }
  if (walk.unresolved !== undefined && found.length > 0) {
    if (walk.unresolved === "unreadable")
      return peFailure(
        `PE ${name} resource sits beside a resource type branch that cannot be read.`,
      );
    throw walk.unresolved;
  }
  return found;
};
