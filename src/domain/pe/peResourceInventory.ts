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
  type PeResourceIdentityDeclaration,
} from "./peResourceTreeFacts.js";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { ArtifactLimitBoundary } from "../artifactOperationError.js";
import { BinaryReader } from "../binaryContainer.js";
import { jsonParts } from "../jsonSerialization.js";
import type {
  InspectPeResourcesInput,
  PeResourceIdentity,
  PeResources,
} from "../native/peResources.js";
import { decodeLimit, type LimitRef } from "../parseFailure.js";
import { peFailure, requirePeExtent } from "./peImageHeaders.js";
import {
  readPeResourceLayout,
  readPeResourceLayoutAt,
} from "./peResourceLayout.js";
import type { PrefixedByteSource } from "../byteSource.js";
import { bufferByteSource } from "../byteSource.js";

type PeResourceLayout = ReturnType<typeof readPeResourceLayout>;
type PeResourceInventory = Omit<PeResources, "artifact">;

type Range = { offset: number; bytes: number };
type OccupiedRange = Range & {
  kind: "directory" | "name" | "data-entry" | "payload";
};
/** Complete PE resource result retained before a refusal. */
const METADATA_BYTES = 8 * 1024 * 1024;
/** The fixed allowance for retained resource metadata. */
const METADATA_LIMIT = "pe_resource_metadata_bytes";
const limit = (message: string, name: string, maximum: number): never => {
  throw decodeLimit("pe", message, { name, maximum });
};

/** The bound a PE resource decode limit constrains: retained metadata or directory entries. */
export const peResourceLimitBoundary = (
  limit: LimitRef,
): ArtifactLimitBoundary | undefined =>
  limit.name === METADATA_LIMIT
    ? "memory"
    : limit.name === PE_RESOURCE_ENTRY_LIMIT
      ? "capacity"
      : undefined;
/** Count bytes through the canonical bounded JSON writer. */
const jsonBytes = (value: unknown, maximum: number): number => {
  let size = 0;
  for (const part of jsonParts(value)) {
    size += Buffer.byteLength(part, "utf8");
    if (size > maximum) return size;
  }
  return size;
};
const identityKey = (id: PeResourceIdentity): string =>
  id.kind === "id" ? `id:${String(id.id)}` : `name:${id.utf16le_hex}`;

/** Attach the selected carrier identity for the public PE resource report. */
export const parsePeResources = async (
  bytes: Buffer,
  artifact: PeResources["artifact"],
  input: InspectPeResourcesInput,
  signal?: AbortSignal,
): Promise<PeResources> =>
  boundedResourceResult(
    {
      artifact,
      ...(await parsePeResourceInventory(
        bufferByteSource(bytes),
        input.max_entries,
        signal,
        readPeResourceLayout(bytes),
      )),
    },
    signal,
  );

/**
 * Decode PE resources from a verified random-access source without buffering
 * the full PE image in memory.
 */
export const parsePeResourcesFromSource = async (
  source: PrefixedByteSource,
  artifact: PeResources["artifact"],
  input: InspectPeResourcesInput,
  signal?: AbortSignal,
): Promise<PeResources> => {
  signal?.throwIfAborted();
  const layout = await readPeResourceLayoutAt(
    source.prefix,
    source.size,
    (offset, length) => source.readRange(offset, length),
  );
  return boundedResourceResult(
    {
      artifact,
      ...(await parsePeResourceInventory(
        source,
        input.max_entries,
        signal,
        layout,
      )),
    },
    signal,
  );
};

/** Decode entries from an admitted layout without requiring a carrier identity. */
export const readPeResourceEntries = async (
  bytes: Buffer,
  layout: PeResourceLayout,
  maxEntries: number,
  signal: AbortSignal | undefined,
): Promise<PeResources["resources"]> =>
  boundedResourceResult(
    await parsePeResourceInventory(
      bufferByteSource(bytes),
      maxEntries,
      signal,
      layout,
    ),
    signal,
  ).resources;

/**
 * Decode the conventional type/name/language tree; never infer payload
 * meaning or runtime loading. Malformed structure and exhausted budgets are
 * `ParseFailureError`s (`peResourceLimitBoundary` names a limit's bound); a
 * caller's cancellation rethrows `signal.reason`.
 */
const parsePeResourceInventory = async (
  source: PrefixedByteSource,
  maxEntries: number,
  signal: AbortSignal | undefined,
  layout: PeResourceLayout,
): Promise<PeResourceInventory> => {
  signal?.throwIfAborted();
  const readBytes = (offset: number, length: number): Promise<Buffer> =>
    length === 0
      ? Promise.resolve(Buffer.alloc(0))
      : source.readRange(offset, length);
  const directories: PeResources["directories"] = [];
  const resources: PeResources["resources"] = [];
  const occupied: OccupiedRange[] = [];
  const names = new Map<number, PeResourceIdentity>();
  let examined = 0;
  let metadataBytes = 0;
  const ensureCapacity = (projectedBytes: number): void => {
    if (metadataBytes + projectedBytes > METADATA_BYTES)
      limit(
        "PE resource metadata exceeds the 8 MiB complete-result allocation budget.",
        METADATA_LIMIT,
        METADATA_BYTES,
      );
  };
  const accountBytes = (projectedBytes: number): void => {
    ensureCapacity(projectedBytes);
    metadataBytes += projectedBytes;
  };
  const account = (value: unknown): void => {
    // Rows are retained in arrays; reserve a separator along with each row.
    accountBytes(jsonBytes(value, METADATA_BYTES - metadataBytes - 1) + 1);
  };
  const reserveDecodedName = (utf16Units: number): void => {
    // A JSON string can need six ASCII bytes per UTF-16 code unit (for example,
    // a control character encoded as `\\u0000`). The original spelling and
    // its hex form are both retained in the result.
    const projectedBytes = 10 * utf16Units + 256;
    ensureCapacity(projectedBytes);
  };
  const root = layout.size === 0 ? 0 : layout.map(layout.rva, layout.size);
  const relative = (at: number, length: number): number => {
    if (!peResourceRangeFits(at, length, layout.size))
      peFailure(
        "Resource directory offset leaves the declared resource interval.",
      );
    requirePeExtent(source.size, root + at, length);
    return root + at;
  };
  const recordRange = (
    offset: number,
    size: number,
    kind: OccupiedRange["kind"],
  ): Range => {
    const range = { offset, bytes: size };
    if (size > 0) occupied.push({ ...range, kind });
    return range;
  };
  const readIdentity = async (
    declaration: PeResourceIdentityDeclaration,
  ): Promise<PeResourceIdentity> => {
    if (declaration.kind === "id") return { kind: "id", id: declaration.id };
    const at = declaration.offset;
    const previous = names.get(at);
    if (previous !== undefined) return previous;
    if (at % 2 !== 0) peFailure("Unaligned PE resource name.");
    const start = relative(at, PE_RESOURCE_NAME_PREFIX_BYTES);
    const { utf16Units, payloadBytes: length } = readPeResourceNameFacts(
      await readBytes(start, PE_RESOURCE_NAME_PREFIX_BYTES),
    );
    relative(at, PE_RESOURCE_NAME_PREFIX_BYTES + length);
    reserveDecodedName(utf16Units);
    const raw = await readBytes(start + PE_RESOURCE_NAME_PREFIX_BYTES, length);
    const value: PeResourceIdentity = {
      kind: "name",
      name: raw.toString("utf16le"),
      utf16le_hex: raw.toString("hex"),
      location: recordRange(
        start,
        PE_RESOURCE_NAME_PREFIX_BYTES + length,
        "name",
      ),
    };
    names.set(at, value);
    return value;
  };
  const visit = async (
    at: number,
    path: PeResourceIdentity[],
    entryLocations: Range[],
    ancestors: ReadonlySet<number>,
  ): Promise<void> => {
    if (ancestors.has(at)) peFailure("Cyclic PE resource directory.");
    const header = relative(at, PE_RESOURCE_DIRECTORY_BYTES);
    const facts = readPeResourceDirectoryFacts(
      await readBytes(header, PE_RESOURCE_DIRECTORY_BYTES),
    );
    const { namedEntries: named, idEntries: ids, entryCount: count } = facts;
    const entriesBytes = PE_RESOURCE_ENTRY_BYTES * count;
    relative(at, PE_RESOURCE_DIRECTORY_BYTES + entriesBytes);
    if (count > maxEntries - examined)
      limit(
        "PE resource directory entry budget exceeded; no partial inventory was returned.",
        PE_RESOURCE_ENTRY_LIMIT,
        maxEntries,
      );
    examined += count;
    const directory = {
      path,
      entry_locations: entryLocations,
      location: recordRange(
        header,
        PE_RESOURCE_DIRECTORY_BYTES + entriesBytes,
        "directory",
      ),
      characteristics: facts.characteristics,
      timestamp: facts.timestamp,
      major_version: facts.majorVersion,
      minor_version: facts.minorVersion,
      named_entries: named,
      id_entries: ids,
    };
    account(directory);
    directories.push(directory);
    const entryTable = await readBytes(
      header + PE_RESOURCE_DIRECTORY_BYTES,
      entriesBytes,
    );
    const keys = new Set<string>();
    let previousId = -1;
    const nested = new Set([...ancestors, at]);
    for (let index = 0; index < count; index++) {
      if (index % 128 === 0) {
        await setImmediate();
        signal?.throwIfAborted();
      }
      const entryOffset = index * PE_RESOURCE_ENTRY_BYTES;
      const entry = header + PE_RESOURCE_DIRECTORY_BYTES + entryOffset;
      const record = readPeResourceEntryFacts(
        entryTable.subarray(entryOffset, entryOffset + PE_RESOURCE_ENTRY_BYTES),
      );
      if ((record.identity.kind === "name") !== index < named)
        peFailure(
          "Resource name/ID entry counts disagree with encoded identities.",
        );
      const identity = await readIdentity(record.identity);
      const key = identityKey(identity);
      if (keys.has(key))
        peFailure("Duplicate identity within a resource directory.");
      keys.add(key);
      if (identity.kind === "id") {
        if (identity.id < previousId)
          peFailure("PE resource directory numeric IDs are out of order.");
        previousId = identity.id;
      }
      const next = [...path, identity];
      const locations = [
        ...entryLocations,
        { offset: entry, bytes: PE_RESOURCE_ENTRY_BYTES },
      ];
      const { offset } = record.target;
      if (record.target.kind === "directory") {
        if (next.length >= 3)
          peFailure(
            "Unsupported resource tree deeper than type/name/language.",
          );
        await visit(offset, next, locations, nested);
      } else {
        if (next.length !== 3)
          peFailure(
            "Unsupported resource leaf outside the type/name/language profile.",
          );
        const data = relative(offset, PE_RESOURCE_DATA_ENTRY_BYTES);
        const { rva, size, codePage, reserved } = readPeResourceDataEntryFacts(
          await readBytes(data, PE_RESOURCE_DATA_ENTRY_BYTES),
        );
        const payloadOffset = layout.map(rva, size);
        const [type, name, language] = next;
        if (type === undefined || name === undefined || language === undefined)
          return peFailure("Incomplete resource identity.");
        const resource = {
          index: resources.length,
          type,
          name,
          language,
          entry_locations: locations,
          data_entry_location: recordRange(
            data,
            PE_RESOURCE_DATA_ENTRY_BYTES,
            "data-entry",
          ),
          code_page: codePage,
          reserved,
          payload: {
            rva,
            location: recordRange(payloadOffset, size, "payload"),
            sha256: "0".repeat(64),
          },
        };
        account(resource);
        resources.push(resource);
      }
    }
  };
  if (layout.size > 0) await visit(0, [], [], new Set());
  rejectOverlappingRanges(occupied);
  const hashes = new Map<string, string>();
  for (const resource of resources) {
    const range = resource.payload.location;
    const key = `${String(range.offset)}:${String(range.bytes)}`;
    let digest = hashes.get(key);
    if (digest === undefined) {
      const hash = createHash("sha256");
      for (let offset = 0; offset < range.bytes; offset += 1048576) {
        await setImmediate();
        signal?.throwIfAborted();
        hash.update(
          await readBytes(
            range.offset + offset,
            Math.min(1048576, range.bytes - offset),
          ),
        );
      }
      digest = hash.digest("hex");
      hashes.set(key, digest);
    }
    resource.payload.sha256 = digest;
  }
  const iconGroups = await readIconGroups(
    readBytes,
    resources,
    account,
    ensureCapacity,
  );
  return {
    format: layout.format,
    machine: layout.machine,
    directory:
      layout.size === 0
        ? null
        : {
            rva: layout.rva,
            location: { offset: root, bytes: layout.size },
            data_directory_location: { offset: layout.directoryAt, bytes: 8 },
          },
    directories,
    resources,
    icon_groups: iconGroups,
    coverage: {
      status: "complete",
      examined_entries: examined,
      resources: resources.length,
    },
    limitations: [
      "Static PE32/PE32+ type/name/language resource inventory; payloads other than RT_GROUP_ICON remain opaque.",
      "Icon candidates are resource-table relationships. Language fallback, image decoding and actual shell/window loading are not observed.",
      "Exact shared byte ranges are retained; non-identical overlapping resource structures or payloads are rejected.",
    ],
  };
};

const boundedResourceResult = <Report extends PeResourceInventory>(
  report: Report,
  signal: AbortSignal | undefined,
): Report => {
  signal?.throwIfAborted();
  if (jsonBytes(report, METADATA_BYTES) > METADATA_BYTES)
    limit(
      "PE resource result exceeds the 8 MiB allocation budget.",
      METADATA_LIMIT,
      METADATA_BYTES,
    );
  return report;
};

const rejectOverlappingRanges = (ranges: OccupiedRange[]): void => {
  ranges.sort(
    (left, right) => left.offset - right.offset || right.bytes - left.bytes,
  );
  let previous: OccupiedRange | undefined;
  for (const current of ranges) {
    if (
      previous !== undefined &&
      current.offset < previous.offset + previous.bytes &&
      (current.offset !== previous.offset ||
        current.bytes !== previous.bytes ||
        current.kind !== previous.kind)
    )
      peFailure("Non-identical resource byte ranges overlap.");
    previous = current;
  }
};

const readIconGroups = async (
  readBytes: (offset: number, length: number) => Promise<Buffer>,
  resources: PeResources["resources"],
  account: (value: unknown) => void,
  ensureCapacity: (projectedBytes: number) => void,
): Promise<PeResources["icon_groups"]> => {
  const imagesById = new Map<number, PeResources["resources"]>();
  for (const resource of resources) {
    if (
      resource.type.kind !== "id" ||
      resource.type.id !== 3 ||
      resource.name.kind !== "id"
    )
      continue;
    const candidates = imagesById.get(resource.name.id) ?? [];
    candidates.push(resource);
    imagesById.set(resource.name.id, candidates);
  }
  const groups: PeResources["icon_groups"] = [];
  for (const group of resources) {
    if (group.type.kind !== "id" || group.type.id !== 14) continue;
    const { offset, bytes: size } = group.payload.location;
    const headerBytes = 6;
    const entryBytes = 14;
    if (size < headerBytes) peFailure("Malformed RT_GROUP_ICON header.");
    const header = new BinaryReader(
      await readBytes(offset, headerBytes),
      true,
      "pe",
    );
    if (header.u16(0) !== 0 || header.u16(2) !== 1)
      peFailure("Malformed RT_GROUP_ICON header.");
    const count = header.u16(4);
    const entriesBytes = count * entryBytes;
    if (size !== headerBytes + entriesBytes)
      peFailure("RT_GROUP_ICON length does not match its image count.");
    const entriesOffset = offset + headerBytes;
    const reader = new BinaryReader(
      await readBytes(entriesOffset, entriesBytes),
      true,
      "pe",
    );
    const images: PeResources["icon_groups"][number]["images"] = [];
    for (let index = 0; index < count; index++) {
      const at = index * entryBytes;
      const id = reader.u16(at + 12);
      const candidates = imagesById.get(id) ?? [];
      const exact = candidates.find(
        (resource) =>
          identityKey(resource.language) === identityKey(group.language),
      );
      // Indices are uint32 values and each needs at most ten decimal digits
      // plus a comma. Check the expanded candidate list before allocating it.
      ensureCapacity(302 + candidates.length * 11);
      const declaredBytes = reader.u32(at + 8);
      const image = {
        location: { offset: entriesOffset + at, bytes: entryBytes },
        width: reader.u8(at),
        height: reader.u8(at + 1),
        color_count: reader.u8(at + 2),
        reserved: reader.u8(at + 3),
        planes: reader.u16(at + 4),
        bit_count: reader.u16(at + 6),
        declared_bytes: declaredBytes,
        resource_id: id,
        candidate_resource_indices: candidates.map(({ index }) => index),
        same_language_resource_index: exact?.index ?? null,
        size_matches:
          exact === undefined
            ? null
            : exact.payload.location.bytes === declaredBytes,
      };
      account(image);
      images.push(image);
    }
    account({ resource_index: group.index, images: [] });
    groups.push({ resource_index: group.index, images });
  }
  return groups;
};
