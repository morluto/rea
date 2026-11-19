import {
  PE_RESOURCE_DATA_ENTRY_BYTES,
  PE_RESOURCE_DIRECTORY_BYTES,
  PE_RESOURCE_ENTRY_BYTES,
  PE_RESOURCE_NAME_PREFIX_BYTES,
  readPeResourceDataEntryFacts,
  readPeResourceDirectoryFacts,
  readPeResourceEntryFacts,
  readPeResourceNameFacts,
} from "./peResourceTreeFacts.js";
import { BinaryFormatFailure } from "../binaryContainer.js";
import { ParseFailureError } from "../parseFailure.js";
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
  const map = (rva: number, size: number): number => {
    if (rva + size > 0x100000000) peFailure("Resource RVA range overflows.");
    const containing = sections.filter(
      (section) =>
        rva >= section.rva && rva - section.rva < virtualExtent(section),
    );
    // An empty interval reads no bytes, so the Windows resource loader also
    // resolves it exactly at a section's virtual end. A section starting at
    // that RVA still owns it.
    const candidates =
      size === 0 && containing.length === 0
        ? sections.filter(
            (section) =>
              virtualExtent(section) > 0 &&
              rva - section.rva === virtualExtent(section),
          )
        : containing;
    if (rva < headerSize) {
      if (
        sections.some((section) => intersectsResource(section, rva, size)) ||
        size > headerSize - rva
      )
        peFailure("Ambiguous resource header RVA mapping.");
      requirePeExtent(fileSize, rva, size);
      return rva;
    }
    if (candidates.length !== 1)
      peFailure("Resource RVA has missing or overlapping section mappings.");
    const section = candidates[0];
    if (section === undefined) return peFailure("Missing resource section.");
    const within = rva - section.rva;
    if (size > virtualExtent(section) - within)
      peFailure("Resource range leaves its section's virtual size.");
    if (within > section.size || size > section.size - within)
      peFailure("Resource range is not entirely file-backed in one section.");
    // A second section with virtual extent inside the requested interval is
    // ambiguous too; a zero-extent section owns no byte there.
    if (
      sections.some(
        (other) => other !== section && intersectsResource(other, rva, size),
      )
    )
      peFailure("Resource interval intersects overlapping virtual sections.");
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

/** Budgeted reads relative to one admitted resource root. */
class PeResourceTree {
  #examined = 0;

  constructor(
    readonly layout: ReturnType<typeof readPeResourceLayout>,
    private readonly root: number,
    private readonly read: PeRangeReader,
    private readonly maxEntries: number,
  ) {}

  relative(at: number, length: number): Promise<Buffer | undefined> {
    return at < 0 || at > this.layout.size - length
      ? Promise.resolve(undefined)
      : this.read(this.root + at, length);
  }

  async directory(at: number): Promise<Buffer | undefined> {
    const header = await this.relative(at, PE_RESOURCE_DIRECTORY_BYTES);
    if (header === undefined) return undefined;
    const { entryCount } = readPeResourceDirectoryFacts(header);
    if (entryCount > this.maxEntries - this.#examined) return undefined;
    this.#examined += entryCount;
    return this.relative(
      at + PE_RESOURCE_DIRECTORY_BYTES,
      entryCount * PE_RESOURCE_ENTRY_BYTES,
    );
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
  unresolved: boolean;
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
  const types = await tree.directory(0);
  if (types === undefined) return;
  const expected = Buffer.from(name, "utf16le");
  for (let at = 0; at < types.length; at += PE_RESOURCE_ENTRY_BYTES) {
    const type = readPeResourceEntryFacts(
      types.subarray(at, at + PE_RESOURCE_ENTRY_BYTES),
    );
    if (type.identity.kind !== "id" || type.identity.id !== typeId) continue;
    const names =
      type.target.kind === "directory"
        ? await tree.directory(type.target.offset)
        : undefined;
    if (names === undefined) {
      walk.unresolved = true;
      continue;
    }
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
        walk.unresolved = true;
        continue;
      }
      if (readPeResourceNameFacts(length).utf16Units !== name.length) continue;
      const candidate = await tree.relative(
        nameAt + PE_RESOURCE_NAME_PREFIX_BYTES,
        expected.length,
      );
      if (candidate === undefined) walk.unresolved = true;
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
  const first = await namedResourceTargets(tree, typeId, name, {
    unresolved: false,
  }).next();
  return first.done !== true;
};

/**
 * Payload ranges of the `typeId` resource named `name`, from the same bounded
 * walk as `hasPeResourceName`. The image is not read whole. A tree that never
 * reaches the name reports no ranges. Once the name is found, a language
 * directory, data entry, or payload that cannot be resolved is a format
 * failure, as is any `typeId` branch the walk could not examine.
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
  const walk: NamedResourceWalk = { unresolved: false };
  for await (const target of namedResourceTargets(tree, typeId, name, walk)) {
    const languages =
      target.kind === "directory"
        ? await tree.directory(target.offset)
        : undefined;
    if (languages === undefined)
      return peFailure(`PE ${name} resource directory is unreadable.`);
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
  if (walk.unresolved && found.length > 0)
    return peFailure(
      `PE ${name} resource sits beside a resource type branch that cannot be read.`,
    );
  return found;
};
