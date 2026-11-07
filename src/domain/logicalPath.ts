import { isAbsolute, relative, resolve, sep } from "node:path";
import type { JsonValue } from "./jsonValue.js";

/** Specification for logical path root redaction. */
export interface LogicalPathRedactionOptions {
  /** Directory root to redact (e.g. `/tmp/run-alpha` or `/home/user/workspace`). */
  readonly logicalRoot: string;
  /** Logical prefix replacing the root (defaults to `$WORKSPACE`). */
  readonly logicalPrefix?: string | undefined;
}

export type LogicalPathRootInput =
  | string
  | LogicalPathRedactionOptions
  | {
      readonly root: string;
      readonly prefix?: string | undefined;
    };

export interface ResolvedLogicalPathConfig {
  readonly root: string;
  readonly prefix: string;
}

/** Resolve and normalize logical path redaction configuration. */
export const resolveLogicalPathConfig = (
  input: LogicalPathRootInput | undefined,
  fallbackPrefix = "$WORKSPACE",
): ResolvedLogicalPathConfig | undefined => {
  if (input === undefined) return undefined;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed === "") return undefined;
    return {
      root: resolve(trimmed),
      prefix: fallbackPrefix,
    };
  }
  const rootStr = "logicalRoot" in input ? input.logicalRoot : input.root;
  if (typeof rootStr !== "string" || rootStr.trim() === "") return undefined;
  const prefixStr =
    "logicalPrefix" in input
      ? input.logicalPrefix
      : "prefix" in input
        ? input.prefix
        : undefined;
  return {
    root: resolve(rootStr.trim()),
    prefix: typeof prefixStr === "string" ? prefixStr : fallbackPrefix,
  };
};

/** Limitation text committed to Evidence when logical path redaction was applied. */
export const logicalPathRedactionLimitation = (
  config: ResolvedLogicalPathConfig,
): string =>
  `Local filesystem paths were normalized relative to logical root: ${config.prefix}`;

/**
 * Redact an individual path string by mapping paths within `config.root` to `config.prefix`.
 * Handles forward slashes, Windows backslashes, exact matches, child paths, and substring occurrences.
 */
export const redactLogicalPath = (
  rawPath: string,
  config: ResolvedLogicalPathConfig,
): string => {
  if (rawPath === "") return rawPath;

  const normPath = rawPath.replaceAll("\\", "/").replace(/\/+/gu, "/");
  const normRoot = config.root
    .replaceAll("\\", "/")
    .replace(/\/+/gu, "/")
    .replace(/\/+$/u, "");

  // Exact root match
  if (normPath === normRoot) {
    return config.prefix;
  }

  // Child path within root
  if (normPath.startsWith(`${normRoot}/`)) {
    const remainder = normPath.slice(normRoot.length + 1);
    return config.prefix === "" ? remainder : `${config.prefix}/${remainder}`;
  }

  // Also check native relative path for platform-specific containment
  const rel = relative(config.root, rawPath);
  const isWithin =
    rel === "" ||
    (rel !== ".." &&
      !rel.startsWith(`..${sep}`) &&
      !rel.startsWith("../") &&
      !isAbsolute(rel));

  if (isWithin) {
    if (rel === "") return config.prefix;
    const forwardRel = rel.split(/[\\/]/u).filter(Boolean).join("/");
    return config.prefix === "" ? forwardRel : `${config.prefix}/${forwardRel}`;
  }

  // Fallback: replace any embedded root occurrences (both slash styles)
  let result = rawPath;
  if (normRoot !== "" && result.includes(normRoot)) {
    result = result.replaceAll(normRoot, config.prefix);
  }
  const nativeRoot = config.root.replace(/[\\/]+$/u, "");
  if (nativeRoot !== "" && result.includes(nativeRoot)) {
    result = result.replaceAll(nativeRoot, config.prefix);
  }
  return result;
};

/** Redact any string path values embedded anywhere within an arbitrary JSON value. */
export const redactJsonValue = (
  value: unknown,
  config: ResolvedLogicalPathConfig,
): unknown => {
  if (typeof value === "string") {
    return redactLogicalPath(value, config);
  }
  if (Array.isArray(value)) {
    return value.map((element) => redactJsonValue(element, config));
  }
  if (typeof value === "object" && value !== null) {
    const redactedObject: Record<string, unknown> = {};
    for (const [key, element] of Object.entries(value)) {
      redactedObject[key] = redactJsonValue(element, config);
    }
    return redactedObject;
  }
  return value;
};

/** Redact artifact-path locations matching logical root. */
export const redactEvidenceLocations = <
  T extends { kind: string; path?: string },
>(
  locations: readonly T[],
  config: ResolvedLogicalPathConfig,
): T[] =>
  locations.map((loc) =>
    loc.kind === "artifact-path" && typeof loc.path === "string"
      ? ({ ...loc, path: redactLogicalPath(loc.path, config) } as T)
      : loc,
  );
