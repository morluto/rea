import { fixedAllowanceRemediation } from "../../domain/fixedAllowanceRemediation.js";
import { abortIfNeeded } from "../ArtifactHash.js";
import { ArtifactReaderFailure } from "../ArtifactReader.js";
import { normalizeArtifactPath } from "../ArtifactPaths.js";

/** Directory, file, and symlink records admitted from one virtual filesystem. */
export const MAX_DENO_VFS_ENTRIES = 100_000;
/** Logical path parts admitted before an indexed fallback. */
export const MAX_DENO_LOGICAL_PATH_PARTS = 256;
/**
 * UTF-16 code units retained for one virtual name. Longer names are indexed
 * and the original spelling is not copied into members.
 */
export const MAX_DENO_VFS_NAME_UNITS = 4_096;
/**
 * Nested `walkEntries` calls. This is the recursion budget, separate from
 * the logical-path part fallback.
 */
export const MAX_DENO_VFS_DEPTH = 512;
/**
 * UTF-16 code units of the source path built for each entry, directories
 * included, plus retained symlink parts. Each path is rebuilt and normalized
 * once, so this also bounds the synchronous walk.
 */
export const MAX_DENO_VFS_RETAINED_UNITS = 32 * 1024 * 1024;
/** POSIX NAME_MAX. A longer component makes extraction fail with ENAMETOOLONG. */
export const MAX_DENO_PATH_COMPONENT_BYTES = 255;
/**
 * Natural logical path bytes. Half of the 1,024-byte Darwin PATH_MAX, leaving
 * the rest for the output root, so a long path does not abort extraction.
 */
export const MAX_DENO_LOGICAL_PATH_BYTES = 512;
/** Logical path suffixes of the regions stored beside an original file. */
export const DENO_CHILD_SUFFIXES = {
  transpiled: ".deno-transpiled",
  cjsExportAnalysis: ".deno-cjs-analysis",
  sourceMap: ".deno-sourcemap",
} as const;

const INDEXED_PATH_LIMITATION = `The virtual name exceeds the fixed ${String(MAX_DENO_LOGICAL_PATH_PARTS)}-part logical path allowance; an indexed path is used and the original name is retained.`;
const NAME_LIMITATION = `The virtual name exceeds the fixed ${String(MAX_DENO_VFS_NAME_UNITS)}-unit name allowance; an indexed path is used and the original name is not retained.`;
export const DENO_PATH_LENGTH_LIMITATION = `The virtual name exceeds the fixed ${String(MAX_DENO_PATH_COMPONENT_BYTES)}-byte path component or ${String(MAX_DENO_LOGICAL_PATH_BYTES)}-byte logical path allowance; an indexed path is used and the original name is retained.`;
const UNSAFE_PATH_LIMITATION =
  "The virtual name is not a safe relative path; an indexed path is used and the original name is retained.";
const MTIME_LIMITATION = "The file mtime is not a safe integer; it is omitted.";
const SYMLINK_PART_LIMITATION = `A symlink target part exceeds the fixed ${String(MAX_DENO_VFS_NAME_UNITS)}-unit name allowance; the target parts are not retained.`;

export type DenoVfsRole =
  | "vfs-file"
  | "vfs-transpiled"
  | "vfs-cjs-export-analysis"
  | "vfs-source-map"
  | "vfs-symlink";

/** One stored virtual filesystem region. Offsets are relative to vfs file data. */
export interface DenoVfsMember {
  readonly role: DenoVfsRole;
  readonly index: number;
  readonly path: string;
  readonly sourcePath: string | null;
  readonly limitations: readonly string[];
  readonly offset: number | null;
  readonly length: number | null;
  readonly executable: boolean;
  readonly isValidUtf8: boolean | null;
  readonly symlinkDestParts: readonly string[] | null;
}

export interface DenoVfsWalk {
  readonly listing: "listed" | "unsupported";
  readonly members: readonly DenoVfsMember[];
}

class UnsupportedVfsShape {
  readonly kind = "unsupported-vfs-shape" as const;
}

interface WalkState {
  count: number;
  retainedUnits: number;
  readonly indexed: Set<number>;
  readonly naturalPaths: Set<string>;
}

interface Range {
  readonly offset: number;
  readonly length: number;
}

interface FileRegions {
  readonly original: Range;
  readonly children: readonly {
    readonly role: DenoVfsRole;
    readonly range: Range;
    readonly suffix: string;
  }[];
  readonly utf8: boolean;
  readonly executable: boolean;
}

interface Parent {
  readonly path: string | null;
  readonly parts: number;
  readonly source: string | null;
  readonly limitation: string | null;
}

interface Destination {
  readonly path: string;
  readonly parts: number;
  readonly source: string | null;
  readonly forceChildren: boolean;
  readonly limitations: readonly string[];
}

const ROOT_PARENT: Parent = {
  path: null,
  parts: 0,
  source: null,
  limitation: null,
};

/**
 * Walk Deno's externally tagged `VirtualDirectoryEntries` JSON.
 * Unsafe or deep names use `deno-vfs/<index>`. Symlink targets are recorded
 * and not followed. A shape that is not the tagged form returns an
 * unsupported listing instead of guessing members.
 */
export const walkDenoVirtualFs = (
  value: unknown,
  fileDataLength: number,
  signal?: AbortSignal,
): DenoVfsWalk => {
  abortIfNeeded(signal);
  if (!Array.isArray(value)) return { listing: "unsupported", members: [] };
  const members: DenoVfsMember[] = [];
  const state: WalkState = {
    count: 0,
    retainedUnits: 0,
    indexed: new Set(),
    naturalPaths: new Set(),
  };
  try {
    walkEntries(value, ROOT_PARENT, 1, state, fileDataLength, members);
  } catch (cause) {
    if (cause instanceof UnsupportedVfsShape)
      return { listing: "unsupported", members: [] };
    throw cause;
  }
  const conflictingChildren = new Set(
    members.filter(
      (member) =>
        member.role !== "vfs-file" &&
        member.role !== "vfs-symlink" &&
        !state.indexed.has(member.index) &&
        state.naturalPaths.has(member.path),
    ),
  );
  if (state.indexed.size === 0 && conflictingChildren.size === 0)
    return { listing: "listed", members };
  // Reserve natural destinations first, including regions and later entries.
  // An unused top-level namespace keeps every indexed region collision-free.
  const occupied = new Set<string>();
  for (const path of state.naturalPaths)
    occupied.add(path.split("/", 1)[0] ?? path);
  for (const member of members)
    if (!state.indexed.has(member.index))
      occupied.add(member.path.split("/", 1)[0] ?? member.path);
  let namespace = "deno-vfs";
  for (let salt = 1; occupied.has(namespace); salt += 1)
    namespace = `deno-vfs-${String(salt)}`;
  return {
    listing: "listed",
    members: members.map((member) =>
      conflictingChildren.has(member)
        ? {
            ...member,
            path: `${namespace}/${String(member.index)}.${member.role}`,
            limitations: [
              ...member.limitations,
              "The generated region path conflicts with a natural VFS destination; an indexed path is used and the original name is retained.",
            ],
          }
        : state.indexed.has(member.index)
          ? {
              ...member,
              path: `${namespace}${member.path.slice("deno-vfs".length)}`,
            }
          : member,
    ),
  };
};

const walkEntries = (
  entries: readonly unknown[],
  parent: Parent,
  depth: number,
  state: WalkState,
  fileDataLength: number,
  members: DenoVfsMember[],
): void => {
  if (depth > MAX_DENO_VFS_DEPTH) throw denoVfsDepthLimit(depth);
  for (const entry of entries) {
    const tagged = taggedEntry(entry);
    if (tagged === undefined) throw new UnsupportedVfsShape();
    const index = state.count;
    if (index >= MAX_DENO_VFS_ENTRIES) throw denoVfsEntryLimit(index + 1);
    state.count += 1;
    const name = tagged.body.n;
    if (typeof name !== "string") throw new UnsupportedVfsShape();
    const source = retainText(state, childSource(parent, name));
    const regions =
      tagged.kind === "File"
        ? fileRegions(tagged.body, fileDataLength)
        : undefined;
    const destination = logicalDestination(
      name,
      parent,
      source,
      index,
      Math.max(0, ...(regions?.children ?? []).map((c) => c.suffix.length)),
    );
    const childParent: Parent = {
      path: destination.forceChildren ? null : destination.path,
      parts: destination.parts,
      source: destination.source,
      limitation: destination.forceChildren
        ? (destination.limitations[0] ?? null)
        : null,
    };
    if (!destination.forceChildren) state.naturalPaths.add(destination.path);
    if (tagged.kind === "Dir") {
      if (!Array.isArray(tagged.body.e)) throw new UnsupportedVfsShape();
      walkEntries(
        tagged.body.e,
        childParent,
        depth + 1,
        state,
        fileDataLength,
        members,
      );
      continue;
    }
    if (destination.forceChildren) state.indexed.add(index);
    if (tagged.kind === "Symlink") {
      const parts = symlinkParts(tagged.body.p);
      if (parts === undefined) throw new UnsupportedVfsShape();
      if ("d" in tagged.body && typeof tagged.body.d !== "boolean")
        throw new UnsupportedVfsShape();
      const bounded = boundedSymlinkParts(parts);
      if (bounded !== null) retainText(state, bounded.join("/"));
      const limitations =
        bounded === null
          ? [...destination.limitations, SYMLINK_PART_LIMITATION]
          : destination.limitations;
      members.push({
        role: "vfs-symlink",
        index,
        path: destination.path,
        sourcePath: destination.source,
        limitations,
        offset: null,
        length: null,
        executable: false,
        isValidUtf8: null,
        symlinkDestParts: bounded,
      });
      continue;
    }
    if (regions === undefined) throw new UnsupportedVfsShape();
    const limitations = [...destination.limitations];
    if ("t" in tagged.body && !isSafeInteger(tagged.body.t))
      limitations.push(MTIME_LIMITATION);
    const pushFile = (
      role: DenoVfsRole,
      range: Range,
      suffix: string,
      fileExecutable: boolean,
    ): void => {
      members.push({
        role,
        index,
        path: `${destination.path}${suffix}`,
        sourcePath: destination.source,
        limitations,
        offset: range.offset,
        length: range.length,
        executable: fileExecutable,
        isValidUtf8: regions.utf8,
        symlinkDestParts: null,
      });
    };
    pushFile("vfs-file", regions.original, "", regions.executable);
    for (const child of regions.children)
      pushFile(child.role, child.range, child.suffix, false);
  }
};

const fileRegions = (
  body: Record<string, unknown>,
  fileDataLength: number,
): FileRegions => {
  const original = readRange(body.o, fileDataLength, "original");
  if (original === undefined) throw new UnsupportedVfsShape();
  const transpiled = optionalRange(body, "m", fileDataLength);
  const cjs = optionalRange(body, "c", fileDataLength);
  const sourceMap = optionalRange(body, "s", fileDataLength);
  if (
    transpiled === "unsupported" ||
    cjs === "unsupported" ||
    sourceMap === "unsupported"
  )
    throw new UnsupportedVfsShape();
  const utf8 = booleanField(body, "u");
  const executable = booleanField(body, "x");
  if (utf8 === "unsupported" || executable === "unsupported")
    throw new UnsupportedVfsShape();
  const children: FileRegions["children"][number][] = [];
  if (transpiled !== undefined)
    children.push({
      role: "vfs-transpiled",
      range: transpiled,
      suffix: DENO_CHILD_SUFFIXES.transpiled,
    });
  if (cjs !== undefined)
    children.push({
      role: "vfs-cjs-export-analysis",
      range: cjs,
      suffix: DENO_CHILD_SUFFIXES.cjsExportAnalysis,
    });
  if (sourceMap !== undefined)
    children.push({
      role: "vfs-source-map",
      range: sourceMap,
      suffix: DENO_CHILD_SUFFIXES.sourceMap,
    });
  return { original, children, utf8, executable };
};

const childSource = (parent: Parent, name: string): string | null => {
  if (name.length > MAX_DENO_VFS_NAME_UNITS) return null;
  // Root has no source yet. Any other missing source is an ancestor that
  // was not retained, so this name alone is not the original path.
  if (parent.source === null) return parent.limitation === null ? name : null;
  return `${parent.source}/${name}`;
};

const taggedEntry = (
  value: unknown,
):
  | {
      readonly kind: "Dir" | "File" | "Symlink";
      readonly body: Record<string, unknown>;
    }
  | undefined => {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const keys = Object.keys(record);
  const key = keys[0];
  if (keys.length !== 1 || key === undefined) return undefined;
  if (key !== "Dir" && key !== "File" && key !== "Symlink") return undefined;
  const body = asRecord(record[key]);
  if (body === undefined) return undefined;
  return { kind: key, body };
};

const logicalDestination = (
  name: string,
  parent: Parent,
  source: string | null,
  index: number,
  reservedBytes: number,
): Destination => {
  const indexed = (
    limitation: string,
    retained: string | null,
  ): Destination => ({
    path: `deno-vfs/${String(index)}`,
    parts: parent.parts,
    source: retained,
    forceChildren: true,
    limitations: [limitation],
  });
  if (parent.limitation !== null) return indexed(parent.limitation, source);
  if (name.length > MAX_DENO_VFS_NAME_UNITS)
    return indexed(NAME_LIMITATION, null);
  if (unsafeName(name)) return indexed(UNSAFE_PATH_LIMITATION, source);
  const parts = parent.parts + 1;
  if (parts > MAX_DENO_LOGICAL_PATH_PARTS)
    return indexed(INDEXED_PATH_LIMITATION, source);
  const joined = parent.path === null ? name : `${parent.path}/${name}`;
  try {
    const path = normalizeArtifactPath(joined);
    if (!denoLogicalPathFits(path, reservedBytes))
      return indexed(DENO_PATH_LENGTH_LIMITATION, source);
    return {
      path,
      parts,
      source,
      forceChildren: false,
      limitations: [],
    };
  } catch (cause) {
    if (cause instanceof ArtifactReaderFailure && cause.reason === "path")
      return indexed(UNSAFE_PATH_LIMITATION, source);
    throw cause;
  }
};

/** Whether `path`, plus a suffix of `reservedBytes`, can be materialized. */
export const denoLogicalPathFits = (path: string, reservedBytes = 0): boolean =>
  Buffer.byteLength(path, "utf8") + reservedBytes <=
    MAX_DENO_LOGICAL_PATH_BYTES &&
  path
    .split("/")
    .every(
      (part, index, parts) =>
        Buffer.byteLength(part, "utf8") +
          (index === parts.length - 1 ? reservedBytes : 0) <=
        MAX_DENO_PATH_COMPONENT_BYTES,
    );

const unsafeName = (name: string): boolean =>
  name.length === 0 ||
  name === "." ||
  name === ".." ||
  name.includes("/") ||
  name.includes("\0");

const symlinkParts = (value: unknown): readonly string[] | undefined => {
  if (!Array.isArray(value) || value.some((part) => typeof part !== "string"))
    return undefined;
  return value;
};

const boundedSymlinkParts = (
  parts: readonly string[],
): readonly string[] | null =>
  parts.some((part) => part.length > MAX_DENO_VFS_NAME_UNITS) ? null : parts;

const retainText = (state: WalkState, text: string | null): string | null => {
  if (text === null || text.length === 0) return text;
  const next = state.retainedUnits + text.length;
  if (next > MAX_DENO_VFS_RETAINED_UNITS) throw denoVfsRetainedLimit(next);
  state.retainedUnits = next;
  return text;
};

const optionalRange = (
  body: Record<string, unknown>,
  key: string,
  fileDataLength: number,
): Range | undefined | "unsupported" => {
  if (!Object.hasOwn(body, key) || body[key] === null) return undefined;
  const range = readRange(body[key], fileDataLength, key);
  return range === undefined ? "unsupported" : range;
};

const readRange = (
  value: unknown,
  fileDataLength: number,
  label: string,
): Range | undefined => {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [offset, length] = value;
  if (
    !isSafeInteger(offset) ||
    !isSafeInteger(length) ||
    offset < 0 ||
    length < 0
  )
    return undefined;
  if (BigInt(offset) + BigInt(length) > BigInt(fileDataLength))
    throw new ArtifactReaderFailure(
      "format",
      `Deno compile section is malformed: vfs ${label} region overruns vfs file data`,
    );
  return { offset, length };
};

const booleanField = (
  body: Record<string, unknown>,
  key: string,
): boolean | "unsupported" => {
  if (!Object.hasOwn(body, key)) return false;
  return typeof body[key] === "boolean" ? body[key] : "unsupported";
};

const isSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return Object.fromEntries(Object.entries(value));
};

const denoVfsEntryLimit = (count: number): ArtifactReaderFailure => {
  const allowance = `Deno compile virtual filesystem entry allowance of ${String(MAX_DENO_VFS_ENTRIES)} entries`;
  const message = `Deno compile virtual filesystem claims ${String(count)} entries, exceeding MAX_DENO_VFS_ENTRIES (${String(MAX_DENO_VFS_ENTRIES)} entries). ${fixedAllowanceRemediation(allowance, "count")} This release has no runtime override. Host memory and NODE_OPTIONS do not raise it.`;
  return new ArtifactReaderFailure("limit", message, {
    boundary: "capacity",
    userMessage: message,
  });
};

const denoVfsDepthLimit = (depth: number): ArtifactReaderFailure => {
  const allowance = `Deno compile virtual filesystem depth allowance of ${String(MAX_DENO_VFS_DEPTH)} levels`;
  const message = `Deno compile virtual filesystem nests ${String(depth)} levels, exceeding MAX_DENO_VFS_DEPTH (${String(MAX_DENO_VFS_DEPTH)} levels). ${fixedAllowanceRemediation(allowance, "count")} This release has no runtime override. Host memory and NODE_OPTIONS do not raise it.`;
  return new ArtifactReaderFailure("limit", message, {
    boundary: "capacity",
    userMessage: message,
  });
};

const denoVfsRetainedLimit = (units: number): ArtifactReaderFailure => {
  const allowance = `Deno compile virtual filesystem retained name allowance of ${String(MAX_DENO_VFS_RETAINED_UNITS)} UTF-16 code units`;
  const message = `Deno compile virtual filesystem paths use ${String(units)} UTF-16 code units, exceeding MAX_DENO_VFS_RETAINED_UNITS (${String(MAX_DENO_VFS_RETAINED_UNITS)} units). ${fixedAllowanceRemediation(allowance, "bytes")} This release has no runtime override. Host memory and NODE_OPTIONS do not raise it.`;
  return new ArtifactReaderFailure("limit", message, {
    boundary: "memory",
    userMessage: message,
  });
};
