import { resolve, posix, win32 } from "node:path";
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

const isWindowsAbsolute = (value: string): boolean =>
  /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\");

const resolveRoot = (root: string): string =>
  isWindowsAbsolute(root)
    ? win32.normalize(root)
    : posix.isAbsolute(root)
      ? posix.normalize(root)
      : resolve(root);

/** Resolve and normalize logical path redaction configuration. */
export const resolveLogicalPathConfig = (
  input: LogicalPathRootInput | undefined,
  fallbackPrefix = "$WORKSPACE",
): ResolvedLogicalPathConfig | undefined => {
  if (input === undefined) return undefined;
  if (typeof input === "string") {
    const trimmed = input;
    if (trimmed === "") return undefined;
    return {
      root: resolveRoot(trimmed),
      prefix: fallbackPrefix,
    };
  }
  const rootStr = "logicalRoot" in input ? input.logicalRoot : input.root;
  if (typeof rootStr !== "string" || rootStr === "") return undefined;
  const prefixStr =
    "logicalPrefix" in input
      ? input.logicalPrefix
      : "prefix" in input
        ? input.prefix
        : undefined;
  return {
    root: resolveRoot(rootStr),
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

  // Choose the recorded path format, independent of the export host. Resolve
  // lexical dot segments before testing containment; do not resolve arbitrary
  // relative result strings against the host working directory.
  const path = isWindowsAbsolute(config.root) ? win32 : posix;
  if (path.isAbsolute(rawPath)) {
    const rel = path.relative(config.root, path.normalize(rawPath));
    if (rel === "") return config.prefix;
    if (
      rel !== ".." &&
      !rel.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(rel)
    ) {
      const suffix = rel.split(path.sep).join("/");
      return config.prefix === "" ? suffix : `${config.prefix}/${suffix}`;
    }
    return rawPath;
  }

  // Free-form diagnostics may contain an absolute path with repeated
  // separators. Match the selected root at path boundaries, preserving the
  // rest of the diagnostic and avoiding similarly prefixed sibling names.
  const windows = isWindowsAbsolute(config.root);
  const parts = config.root.replaceAll("\\", "/").split("/").filter(Boolean);
  if (parts.length === 0) return rawPath;
  const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const separator = windows ? "[\\\\/]+" : "/+";
  const prefix =
    config.root.startsWith("/") || config.root.startsWith("\\\\")
      ? separator
      : "";
  const pattern = `${prefix}${parts.map(escape).join(separator)}`;
  const expression = new RegExp(
    `(?<![\\p{L}\\p{N}_.\\/\\\\-])${pattern}(?=$|[\\/\\\\\\s:.,;)'"\\]\\}])`,
    windows ? "giu" : "gu",
  );
  return rawPath.replace(expression, () => config.prefix);
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
      Object.defineProperty(redactedObject, key, {
        value: redactJsonValue(element, config),
        enumerable: true,
        configurable: true,
        writable: true,
      });
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
