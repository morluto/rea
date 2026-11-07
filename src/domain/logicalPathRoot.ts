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

/**
 * Explicit path-bearing parameter keys across REA inspection tools.
 */
const KNOWN_PATH_PARAMETER_KEYS = new Set([
  "path",
  "input_path",
  "binary_path",
  "capture_path",
  "target_path",
  "descriptor_set_path",
  "snapshot_path",
  "schema_path",
  "output_directory",
]);

/**
 * Explicit path-bearing fields in normalized_result and raw_result.
 */
const KNOWN_RESULT_PATH_KEYS = new Set([
  "target_location",
  "capture_path",
  "source_path",
  "output_directory",
  "descriptor_set_path",
]);

export interface RedactEvidenceObservationPathsOutcome {
  readonly observation: EvidenceObservationInput;
  readonly mappedCount: number;
  readonly outsideCount: number;
}

/** Recursively traverse and map known path fields in a validated JSON value. */
const redactJsonStructurePaths = (
  value: JsonValue,
  mapString: (s: string) => string,
  isPathKey: (key: string) => boolean,
): JsonValue => {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      redactJsonStructurePaths(item, mapString, isPathKey),
    );
  }
  let changed = false;
  const result: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(value)) {
    if (isPathKey(k) && typeof v === "string") {
      const mapped = mapString(v);
      if (mapped !== v) changed = true;
      Object.defineProperty(result, k, {
        value: mapped,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else if (typeof v === "object" && v !== null) {
      const nested = redactJsonStructurePaths(v, mapString, isPathKey);
      if (nested !== v) changed = true;
      Object.defineProperty(result, k, {
        value: nested,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else {
      Object.defineProperty(result, k, {
        value: v,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return changed ? result : value;
};

/**
 * Redacts known path-bearing fields in Evidence inputs using an explicit schema allowlist.
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

  // Validate parameters as true JSON before mapping
  let newParameters = observation.parameters;
  if (
    typeof observation.parameters === "object" &&
    observation.parameters !== null
  ) {
    const validatedParams = jsonObjectSchema.parse(observation.parameters);
    newParameters = redactJsonStructurePaths(validatedParams, mapString, (k) =>
      KNOWN_PATH_PARAMETER_KEYS.has(k),
    ) as Record<string, JsonValue>;
  }

  // Validate and redact normalized_result
  let newResult = observation.result;
  const isOriginalImmutable = isImmutableJsonSnapshot(observation.result);
  if (typeof observation.result === "object" && observation.result !== null) {
    const validatedResult = jsonValueSchema.parse(observation.result);
    const redacted = redactJsonStructurePaths(validatedResult, mapString, (k) =>
      KNOWN_RESULT_PATH_KEYS.has(k),
    );
    newResult = isOriginalImmutable ? freezeJsonSnapshot(redacted) : redacted;
  }

  // Validate and redact rawResult if present
  let newRawResult = observation.rawResult;
  if (
    typeof observation.rawResult === "object" &&
    observation.rawResult !== null
  ) {
    const validatedRaw = jsonValueSchema.parse(observation.rawResult);
    newRawResult = redactJsonStructurePaths(validatedRaw, mapString, (k) =>
      KNOWN_RESULT_PATH_KEYS.has(k),
    );
  }

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
