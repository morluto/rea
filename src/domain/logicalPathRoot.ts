import { isAbsolute, relative, resolve, sep } from "node:path";
import { isPathWithinRoot } from "./localPath.js";
import type { JsonValue } from "./jsonValue.js";
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
  | { readonly kind: "invalid"; readonly reason: string };

/** Default prefix used for canonical logical path redaction. */
export const DEFAULT_LOGICAL_ROOT_PREFIX = "workspace://";

/** Standardize path separator to POSIX forward slash and remove trailing slash. */
const cleanLogicalPrefix = (prefix: string): string => {
  const normalized = prefix.replaceAll("\\", "/");
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
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

  const rootCandidate = resolve(mapping.root);
  const pathCandidate = isAbsolute(path)
    ? resolve(path)
    : resolve(rootCandidate, path);

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
  const prefix = cleanLogicalPrefix(
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
 * We deliberately use an explicit typed allowlist rather than recursive string replacement.
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
]);

/**
 * Explicit path-bearing fields in normalized_result.
 */
const KNOWN_RESULT_PATH_KEYS = new Set([
  "target_location",
  "capture_path",
  "source_path",
]);

export interface RedactEvidenceObservationPathsOutcome {
  readonly observation: EvidenceObservationInput;
  readonly mappedCount: number;
  readonly outsideCount: number;
}

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

  // Map known path parameters
  let newParameters = observation.parameters;
  if (
    typeof observation.parameters === "object" &&
    observation.parameters !== null &&
    !Array.isArray(observation.parameters)
  ) {
    let changed = false;
    const cloned: Record<string, unknown> = {
      ...(observation.parameters as Record<string, unknown>),
    };
    for (const [key, val] of Object.entries(cloned)) {
      if (KNOWN_PATH_PARAMETER_KEYS.has(key) && typeof val === "string") {
        cloned[key] = mapString(val);
        changed = true;
      }
    }
    if (changed) {
      newParameters = cloned;
    }
  }

  // Map known path fields in result if object
  let newResult = observation.result;
  if (
    typeof observation.result === "object" &&
    observation.result !== null &&
    !Array.isArray(observation.result)
  ) {
    let changed = false;
    const cloned: Record<string, JsonValue> = {
      ...(observation.result as Record<string, JsonValue>),
    };
    for (const [key, val] of Object.entries(cloned)) {
      if (KNOWN_RESULT_PATH_KEYS.has(key) && typeof val === "string") {
        cloned[key] = mapString(val);
        changed = true;
      }
    }
    if (changed) {
      newResult = cloned;
    }
  }

  return {
    observation: {
      ...observation,
      parameters: newParameters,
      result: newResult,
      ...(newLocations === undefined ? {} : { locations: newLocations }),
    },
    mappedCount,
    outsideCount,
  };
};
