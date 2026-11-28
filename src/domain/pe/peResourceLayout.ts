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
import {
  BinaryFormatFailure,
  BinaryMappingFailure,
  createFileMappingIndex,
} from "../binaryContainer.js";
import { decodeLimit, ParseFailureError } from "../parseFailure.js";
import {
  peDeclaredFileMappings,
  readPeImage,
  readPeImageFromReader,
  type PeImage,
} from "../native/peImage.js";
import type { PeHeaderAnomaly } from "../native/peHeaderAnomalies.js";
import { peImageBaseHex } from "../native/peAddressSpace.js";
import {
  peFailure,
  type PeRangeReader,
  requirePeExtent,
} from "./peImageHeaders.js";

const PE_RESOURCE_DIRECTORY = 2;
const RVA_SPACE = 0x100000000;

/** Shared PE image admission and file-backed RVA mapping, independent of section names. */
export const readPeResourceLayout = (bytes: Buffer) =>
  mapPeResourceLayout(readPeImage(bytes), bytes.length);

/** The same admission and mapping from bounded positional reads. */
export const readPeResourceLayoutAt = async (
  prefix: Buffer,
  fileSize: number,
  read: PeRangeReader,
) =>
  mapPeResourceLayout(
    await readPeImageFromReader({
      size: fileSize,
      prefix,
      readRange: async (offset, length) => {
        const bytes = await read(offset, length);
        if (bytes === undefined || bytes.length !== length)
          return peFailure(`Truncated PE header range at ${String(offset)}.`);
        return bytes;
      },
    }),
    fileSize,
  );

/**
 * Map resource RVAs through the image's declared file-backed content, the
 * same mapping every static PE reader uses. Section layout is the image
 * owner's fact; only a resource range that is unmapped, ambiguous or leaves
 * the file is refused.
 */
const mapPeResourceLayout = (image: PeImage, fileSize: number) => {
  const index = createFileMappingIndex(
    peDeclaredFileMappings(image),
    image.zero_fills,
  );
  const base = image.image_base;
  /** File offset of a mapped span; undefined when unmapped, refused when ambiguous. */
  const tryMap = (rva: number, size: number): number | undefined => {
    if (rva + size > RVA_SPACE) peFailure("Resource RVA range overflows.");
    const address = base + BigInt(rva);
    let offset: number | undefined;
    try {
      // An empty range belongs to the section starting at its RVA, else to
      // the one ending there.
      if (size !== 0) offset = index.tryOffset(address, size);
      else {
        offset = index.tryOffset(address, 1);
        if (offset === undefined && rva !== 0) {
          const before = index.tryOffset(address - 1n, 1);
          offset = before === undefined ? undefined : before + 1;
        }
      }
    } catch (cause) {
      if (cause instanceof BinaryMappingFailure)
        return peFailure(
          `Resource range at RVA 0x${rva.toString(16)} (${String(size)} bytes) is ambiguously file-backed.`,
        );
      throw cause;
    }
    if (offset !== undefined) requirePeExtent(fileSize, offset, size);
    return offset;
  };
  const map = (rva: number, size: number): number =>
    tryMap(rva, size) ??
    peFailure(
      `Resource range at RVA 0x${rva.toString(16)} (${String(size)} bytes) is not file-backed.`,
    );
  const resource = image.pe_data_directories[PE_RESOURCE_DIRECTORY];
  const rva = resource?.address ?? 0;
  const declaredSize = resource?.size ?? 0;
  const headerAnomalies: PeHeaderAnomaly[] = [...image.pe_header_anomalies];
  // The loader locates the tree by RVA alone and walks it within the
  // section's file-backed bytes, so Size bounds nothing it reads; a missing
  // directory has a zero RVA. The walk records how far it read, and the
  // inventory reports a Size that ends before that point. An ambiguous or
  // unmapped root is still refused through `map`.
  let size = 0;
  if (rva !== 0) {
    const run =
      index.prefix(base + BigInt(rva), RVA_SPACE - rva)?.size ??
      map(rva, PE_RESOURCE_DIRECTORY_BYTES);
    // Bytes past the run are unused by the walk, so an oversized Size needs
    // no mapping there; it is reported, not checked.
    if (declaredSize > run)
      headerAnomalies.push({
        code: "directory_size_past_file_backed_bytes",
        message: `Data directory 2 (resource) declares Size ${String(declaredSize)}, but only ${String(run)} bytes from its RVA are file-backed with one translation; the tree was read within those bytes.`,
      });
    size = run;
  }
  return {
    format: image.bits === 64 ? ("pe32-plus" as const) : ("pe32" as const),
    machine: image.pe_machine,
    imageBase: peImageBaseHex(image.image_base),
    /** File offset of the resource data-directory entry, when the image declares it. */
    directoryAt:
      resource === undefined
        ? null
        : image.pe_optional_header_file_offset + resource.offset,
    rva,
    /** Bytes from the RVA the tree may be read within: the file-backed run. */
    size,
    /** The directory's Size as stored. */
    declaredSize,
    headerAnomalies,
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
    const layout = await readPeResourceLayoutAt(prefix, fileSize, read);
    if (layout.size < PE_RESOURCE_DIRECTORY_BYTES) return undefined;
    return new PeResourceTree(
      layout,
      layout.map(layout.rva, layout.size),
      read,
      maxEntries,
    );
  } catch (cause) {
    // The shared image owner also refuses headers as truncated; an image
    // this probe cannot admit carries no named resource.
    if (
      (cause instanceof ParseFailureError &&
        (cause.kind === "malformed" || cause.kind === "truncated")) ||
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
