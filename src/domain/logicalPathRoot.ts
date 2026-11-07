import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { isPathWithinRoot } from "./localPath.js";
import {
  jsonObjectSchema,
  jsonValueSchema,
  jsonValueValidationSteps,
  type JsonValue,
} from "./jsonValue.js";
import {
  freezeOwnedJsonSnapshotSteps,
  immutableJsonSnapshotMember,
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
      ? prefix === "/" ||
        /^[A-Za-z]:\/$/u.test(prefix) ||
        prefix.endsWith("://")
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
function* mapDeclaredPathSteps(
  value: JsonValue,
  path: readonly string[],
  mapString: (value: string) => string,
): Generator<void, JsonValue> {
  if (path.length === 0)
    return typeof value === "string" ? mapString(value) : value;
  if (value === null || typeof value !== "object") return value;
  const [key, ...rest] = path;
  if (key === undefined || !Object.hasOwn(value, key)) return value;
  // A selected member of an authenticated snapshot inherits its ownership
  // proof. Copies can then reuse unchanged subtrees without resealing them.
  immutableJsonSnapshotMember(value, key);
  if (Array.isArray(value)) {
    if (!/^(0|[1-9][0-9]*)$/u.test(key)) return value;
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index >= value.length) return value;
    const mapped = yield* mapDeclaredPathSteps(value[index]!, rest, mapString);
    if (mapped === value[index]) return value;
    const copy: JsonValue[] = [];
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0 && i % 4096 === 0) yield;
      immutableJsonSnapshotMember(value, String(i));
      copy.push(i === index ? mapped : value[i]!);
    }
    return copy;
  }
  const child = value[key];
  if (child === undefined) return value;
  const mapped = yield* mapDeclaredPathSteps(child, rest, mapString);
  if (mapped === child) return value;
  const copy: Record<string, JsonValue> = {};
  let count = 0;
  for (const name in value) {
    if (!Object.hasOwn(value, name)) continue;
    if (count++ > 0 && count % 4096 === 0) yield;
    immutableJsonSnapshotMember(value, name);
    Object.defineProperty(copy, name, {
      value: name === key ? mapped : value[name],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return copy;
}

function* mapDeclaredPathsSteps(
  value: JsonValue,
  paths: readonly (readonly string[])[],
  mapString: (value: string) => string,
): Generator<void, JsonValue> {
  let current = value;
  for (const path of paths)
    current = yield* mapDeclaredPathSteps(current, path, mapString);
  return current;
}

// Keep the same field names as the public Evidence envelope in validation errors.
const observationJsonSchema = z.object({
  parameters: jsonObjectSchema,
  raw_result: jsonValueSchema.nullable(),
  normalized_result: jsonValueSchema,
});

/**
 * Maps the exact filesystem fields declared by the Evidence producer.
 */
export const redactEvidenceObservationPaths = (
  observation: EvidenceObservationInput,
  mapping: LogicalPathRootMapping,
): RedactEvidenceObservationPathsOutcome => {
  const steps = redactEvidenceObservationPathsSteps(observation, mapping);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
};

export function* redactEvidenceObservationPathsSteps(
  observation: EvidenceObservationInput,
  mapping: LogicalPathRootMapping,
): Generator<void, RedactEvidenceObservationPathsOutcome> {
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
  const admitted = observationJsonSchema.parse({
    parameters: observation.parameters,
    raw_result: observation.rawResult ?? null,
    normalized_result: observation.result,
  });
  const newParameters = (yield* mapDeclaredPathsSteps(
    admitted.parameters,
    observation.logicalPathFields?.parameters ?? [],
    mapString,
  )) as Record<string, JsonValue>;
  const originalResult = admitted.normalized_result;
  const mappedResult = yield* mapDeclaredPathsSteps(
    originalResult,
    observation.logicalPathFields?.result ?? [],
    mapString,
  );
  const newResult = isImmutableJsonSnapshot(observation.result)
    ? yield* freezeOwnedJsonSnapshotSteps(mappedResult)
    : mappedResult;
  if (isImmutableJsonSnapshot(observation.result))
    yield* jsonValueValidationSteps(newResult);
  const newRawResult =
    observation.rawResult === undefined || observation.rawResult === null
      ? observation.rawResult
      : yield* mapDeclaredPathsSteps(
          admitted.raw_result,
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
}
