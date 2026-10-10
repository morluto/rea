import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { jsonParts } from "../../domain/jsonSerialization.js";
import type {
  InspectPeResourcesInput,
  PeResourceIdentity,
  PeResources,
} from "../../domain/native/peResources.js";
import {
  peFailure,
  readPeResourceLayout,
  requirePeRange,
} from "./PeResourceLayout.js";

type Range = { offset: number; bytes: number };
type OccupiedRange = Range & {
  kind: "directory" | "name" | "data-entry" | "payload";
};
const METADATA_BYTES = 8 * 1024 * 1024;
const limit = (message: string): never => {
  throw new ArtifactReaderFailure("limit", message);
};
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

/** Decode the conventional type/name/language tree; never infer payload meaning or runtime loading. */
export const parsePeResources = async (
  bytes: Buffer,
  artifact: PeResources["artifact"],
  input: InspectPeResourcesInput,
  signal?: AbortSignal,
): Promise<PeResources> => {
  signal?.throwIfAborted();
  const layout = readPeResourceLayout(bytes);
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
    if (at > layout.size - length || at < 0)
      peFailure(
        "Resource directory offset leaves the declared resource interval.",
      );
    requirePeRange(bytes, root + at, length);
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
  const readIdentity = (encoded: number): PeResourceIdentity => {
    if ((encoded & 0x80000000) === 0) return { kind: "id", id: encoded };
    const at = encoded & 0x7fffffff;
    const previous = names.get(at);
    if (previous !== undefined) return previous;
    if (at % 2 !== 0) peFailure("Unaligned PE resource name.");
    const start = relative(at, 2);
    const utf16Units = bytes.readUInt16LE(start);
    reserveDecodedName(utf16Units);
    const length = utf16Units * 2;
    relative(at, 2 + length);
    const raw = bytes.subarray(start + 2, start + 2 + length);
    const value: PeResourceIdentity = {
      kind: "name",
      name: raw.toString("utf16le"),
      utf16le_hex: raw.toString("hex"),
      location: recordRange(start, 2 + length, "name"),
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
    if (at % 4 !== 0) peFailure("Unaligned PE resource directory.");
    const header = relative(at, 16);
    const named = bytes.readUInt16LE(header + 12);
    const ids = bytes.readUInt16LE(header + 14);
    const count = named + ids;
    if (count > input.max_entries - examined)
      limit(
        "PE resource directory entry budget exceeded; no partial inventory was returned.",
      );
    examined += count;
    relative(at, 16 + 8 * count);
    const directory = {
      location: recordRange(header, 16 + 8 * count, "directory"),
      characteristics: bytes.readUInt32LE(header),
      timestamp: bytes.readUInt32LE(header + 4),
      major_version: bytes.readUInt16LE(header + 8),
      minor_version: bytes.readUInt16LE(header + 10),
      named_entries: named,
      id_entries: ids,
    };
    account(directory);
    directories.push(directory);
    const keys = new Set<string>();
    const nested = new Set([...ancestors, at]);
    for (let index = 0; index < count; index++) {
      if (index % 128 === 0) {
        await setImmediate();
        signal?.throwIfAborted();
      }
      const entry = header + 16 + index * 8;
      const encoded = bytes.readUInt32LE(entry);
      if (((encoded & 0x80000000) !== 0) !== index < named)
        peFailure(
          "Resource name/ID entry counts disagree with encoded identities.",
        );
      const identity = readIdentity(encoded);
      const key = identityKey(identity);
      if (keys.has(key))
        peFailure("Duplicate identity within a resource directory.");
      keys.add(key);
      const next = [...path, identity];
      const locations = [...entryLocations, { offset: entry, bytes: 8 }];
      const target = bytes.readUInt32LE(entry + 4);
      const offset = target & 0x7fffffff;
      if ((target & 0x80000000) !== 0) {
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
        const data = relative(offset, 16);
        if (offset % 4 !== 0) peFailure("Unaligned resource data entry.");
        const rva = bytes.readUInt32LE(data);
        const size = bytes.readUInt32LE(data + 4);
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
          data_entry_location: recordRange(data, 16, "data-entry"),
          code_page: bytes.readUInt32LE(data + 8),
          reserved: bytes.readUInt32LE(data + 12),
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
          bytes.subarray(
            range.offset + offset,
            range.offset + Math.min(range.bytes, offset + 1048576),
          ),
        );
      }
      digest = hash.digest("hex");
      hashes.set(key, digest);
    }
    resource.payload.sha256 = digest;
  }
  const iconGroups = readIconGroups(bytes, resources, account, ensureCapacity);
  const report: PeResources = {
    artifact,
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
  signal?.throwIfAborted();
  if (jsonBytes(report, METADATA_BYTES) > METADATA_BYTES)
    limit("PE resource result exceeds the 8 MiB allocation budget.");
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

const readIconGroups = (
  bytes: Buffer,
  resources: PeResources["resources"],
  account: (value: unknown) => void,
  ensureCapacity: (projectedBytes: number) => void,
): PeResources["icon_groups"] => {
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
  return resources
    .filter(
      (resource) => resource.type.kind === "id" && resource.type.id === 14,
    )
    .map((group) => {
      const { offset, bytes: size } = group.payload.location;
      if (
        size < 6 ||
        bytes.readUInt16LE(offset) !== 0 ||
        bytes.readUInt16LE(offset + 2) !== 1
      )
        peFailure("Malformed RT_GROUP_ICON header.");
      const count = bytes.readUInt16LE(offset + 4);
      if (size !== 6 + count * 14)
        peFailure("RT_GROUP_ICON length does not match its image count.");
      const images: PeResources["icon_groups"][number]["images"] = [];
      for (let index = 0; index < count; index++) {
        const at = offset + 6 + index * 14;
        const id = bytes.readUInt16LE(at + 12);
        const candidates = imagesById.get(id) ?? [];
        const exact = candidates.find(
          (resource) =>
            identityKey(resource.language) === identityKey(group.language),
        );
        // Indices are uint32 values and each needs at most ten decimal digits
        // plus a comma. Check the expanded candidate list before allocating it.
        ensureCapacity(302 + candidates.length * 11);
        const declaredBytes = bytes.readUInt32LE(at + 8);
        const image = {
          location: { offset: at, bytes: 14 },
          width: bytes[at] ?? 0,
          height: bytes[at + 1] ?? 0,
          color_count: bytes[at + 2] ?? 0,
          reserved: bytes[at + 3] ?? 0,
          planes: bytes.readUInt16LE(at + 4),
          bit_count: bytes.readUInt16LE(at + 6),
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
      return { resource_index: group.index, images };
    });
};
