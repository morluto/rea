import { isAbsolute, relative, resolve, sep } from "node:path";
import { isPathWithinRoot } from "./localPath.js";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonValue,
} from "./jsonValue.js";
import {
  freezeJsonSnapshot,
  isImmutableJsonSnapshot,
} from "./immutableJson.js";
import type { EvidenceLocation, EvidenceObservationInput } from "./evidence.js";

/** Policy configuration for opt-in logical path root redaction. */
export interface LogicalPathRootMapping {
  /** The physical local root directory to redact (e.g. workspace or checkout directory). */
  readonly root: string;
  /**
   * The logical prefix replacement (defaults to "workspace://").
   * Must end with "/" or have trailing slash normalized.
   */
  readonly logicalPrefix?: string;
  /**
   * Whether to allow paths outside the root to be retained without redaction.
   * Defaults to false (fails closed by rejecting or returning an outsideRoot status).
   * Also aliased as `retainUnmappedPaths` for API ergonomics.
   */
  readonly allowOutsideRoot?: boolean;
  /**
   * Explicit alias for `allowOutsideRoot`.
   * When true, paths outside the logical root are retained as host-local paths with an explicit limitation note.
   */
  readonly retainUnmappedPaths?: boolean;
}

/** Result of attempting to normalize a path against a logical path root mapping. */
export type NormalizedLogicalPathResult =
  | { readonly kind: "mapped"; readonly path: string }
  | { readonly kind: "outside-root"; readonly path: string }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "unmodified"; readonly path: string };

/** Default prefix used for canonical logical path redaction. */
export const DEFAULT_LOGICAL_ROOT_PREFIX = "workspace://";

/** Standardize path separator to POSIX forward slash and remove trailing slash. */
export const normalizeLogicalPrefix = (prefix: string): string => {
  const normalized = prefix.replaceAll("\\", "/");
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
};

/**
 * Check if a string is a candidate local filesystem path (not a URL, relative label, or empty).
 */
const isFilesystemPathCandidate = (candidate: string): boolean => {
  return candidate !== "" && isAbsolute(candidate);
};

/** Normalize local path against configured logical root. */
export const normalizeLogicalPath = (
  path: string,
  mapping: LogicalPathRootMapping,
): NormalizedLogicalPathResult => {
  if (path.includes("\0")) {
    return {
      kind: "invalid",
      reason: "Local filesystem paths cannot contain NUL",
    };
  }

  // Preserve URLs, relative labels, and non-filesystem references verbatim
  if (!isFilesystemPathCandidate(path)) {
    return { kind: "unmodified", path };
  }

  const rootCandidate = resolve(mapping.root);
  const pathCandidate = resolve(path);

  const allowOutside =
    mapping.allowOutsideRoot === true || mapping.retainUnmappedPaths === true;
  if (!isPathWithinRoot(rootCandidate, pathCandidate)) {
    if (allowOutside) {
      return { kind: "outside-root", path };
    }
    return {
      kind: "invalid",
      reason: `Path '${path}' is outside the configured logical root '${mapping.root}' and allowOutsideRoot is not enabled`,
    };
  }

  const rel = relative(rootCandidate, pathCandidate);
  const posixRel = rel === "" ? "" : rel.split(sep).join("/");
  const prefix = normalizeLogicalPrefix(
    mapping.logicalPrefix ?? DEFAULT_LOGICAL_ROOT_PREFIX,
  );
  const mapped =
    posixRel === ""
      ? prefix.endsWith("://")
        ? prefix
        : prefix.replace(/\/$/u, "")
      : `${prefix}${posixRel}`;

  return { kind: "mapped", path: mapped };
};

/** Exact JSON paths whose producer identifies as local filesystem values. */
export interface LogicalPathFields {
  readonly parameters?: readonly (readonly string[])[];
  readonly result?: readonly (readonly string[])[];
  readonly rawResult?: readonly (readonly string[])[];
}

export interface RedactEvidenceObservationPathsOutcome {
  readonly observation: EvidenceObservationInput;
  readonly mappedCount: number;
  readonly outsideCount: number;
}

/** Map only declared locations in validated JSON, retaining all other members. */
const mapDeclaredPath = (
  value: JsonValue,
  path: readonly string[],
  mapString: (value: string) => string,
): JsonValue => {
  if (path.length === 0)
    return typeof value === "string" ? mapString(value) : value;
  if (value === null || typeof value !== "object") return value;
  const [key, ...rest] = path;
  if (key === undefined || !Object.hasOwn(value, key)) return value;
  if (Array.isArray(value)) {
    if (!/^(0|[1-9][0-9]*)$/u.test(key)) return value;
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index >= value.length) return value;
    const mapped = mapDeclaredPath(value[index]!, rest, mapString);
    if (mapped === value[index]) return value;
    const copy = [...value];
    copy[index] = mapped;
    return copy;
  }
  const child = value[key];
  if (child === undefined) return value;
  const mapped = mapDeclaredPath(child, rest, mapString);
  if (mapped === child) return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, entry]) => [
      name,
      name === key ? mapped : entry,
    ]),
  );
};

const mapDeclaredPaths = (
  value: JsonValue,
  paths: readonly (readonly string[])[],
  mapString: (value: string) => string,
): JsonValue =>
  paths.reduce(
    (current, path) => mapDeclaredPath(current, path, mapString),
    value,
  );

/**
 * Maps the exact filesystem fields declared by the Evidence producer.
 */
export const redactEvidenceObservationPaths = (
  observation: EvidenceObservationInput,
  mapping: LogicalPathRootMapping,
): RedactEvidenceObservationPathsOutcome => {
  let mappedCount = 0;
  let outsideCount = 0;

  const mapString = (val: string): string => {
    const res = normalizeLogicalPath(val, mapping);
    if (res.kind === "mapped") {
      mappedCount += 1;
      return res.path;
    }
    if (res.kind === "outside-root") {
      outsideCount += 1;
      return res.path;
    }
    if (res.kind === "unmodified") {
      return res.path;
    }
    throw new Error(res.reason);
  };

  // Map locations where kind === "artifact-path"
  let newLocations: EvidenceLocation[] | undefined;
  if (observation.locations !== undefined) {
    newLocations = observation.locations.map((loc) => {
      if (loc.kind === "artifact-path") {
        return {
          ...loc,
          path: mapString(loc.path),
        };
      }
      return loc;
    });
  }

  // Admit the original values before mapping, including scalar results.
  const newParameters = mapDeclaredPaths(
    jsonObjectSchema.parse(observation.parameters),
    observation.logicalPathFields?.parameters ?? [],
    mapString,
  ) as Record<string, JsonValue>;
  const originalResult = jsonValueSchema.parse(observation.result);
  const mappedResult = mapDeclaredPaths(
    originalResult,
    observation.logicalPathFields?.result ?? [],
    mapString,
  );
  const newResult = isImmutableJsonSnapshot(observation.result)
    ? freezeJsonSnapshot(mappedResult)
    : mappedResult;
  const newRawResult =
    observation.rawResult === undefined || observation.rawResult === null
      ? observation.rawResult
      : mapDeclaredPaths(
          jsonValueSchema.parse(observation.rawResult),
          observation.logicalPathFields?.rawResult ?? [],
          mapString,
        );

  return {
    observation: {
      ...observation,
      parameters: newParameters,
      result: newResult,
      ...(newRawResult !== undefined ? { rawResult: newRawResult } : {}),
      ...(newLocations === undefined ? {} : { locations: newLocations }),
    },
    mappedCount,
    outsideCount,
  };
};
