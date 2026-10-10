import { isBuiltin } from "node:module";
import { posix } from "node:path";

import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import {
  admitsCanonicalPathSyntax,
  hasScheme,
  htmlUrlText,
  looksExternal,
  percentDecodeUrlPath,
  stripQueryAndFragment,
} from "../../domain/artifactPathSyntax.js";

type ArtifactPathResolutionContext =
  | "package-entrypoint"
  | "filesystem-expression"
  | "module-specifier"
  | "html-reference"
  | "url-reference";

type UnresolvedArtifactPathStatus =
  | "not-found"
  | "unavailable"
  | "external"
  | "rejected";

interface ArtifactPathResolutionBase {
  readonly declared_path: string;
  readonly resolution_context: ArtifactPathResolutionContext;
  readonly limitations: readonly string[];
}

/** Explicit outcome of artifact-confined path resolution. */
export type ArtifactPathResolution = ArtifactPathResolutionBase &
  (
    | {
        readonly resolved_path: string;
        readonly resolution_status: "resolved";
      }
    | {
        readonly resolved_path: null;
        readonly resolution_status: UnresolvedArtifactPathStatus;
      }
  );

/** Values needed to resolve a declaration without filesystem access. */
export interface ResolveArtifactPathInput {
  readonly declaredPath: string;
  readonly sourcePath: string;
  readonly context: ArtifactPathResolutionContext;
  readonly files: ReadonlyMap<string, JavaScriptArtifactFile>;
  readonly htmlBaseHref?: string | null;
  readonly moduleKind?: "import" | "require";
}

const EXTENSIONS = [
  ".js",
  ".cjs",
  ".mjs",
  ".ts",
  ".tsx",
  ".json",
  ".html",
  ".node",
];

type CandidateResolution =
  | {
      readonly resolvedPath: string;
      readonly status: "resolved";
      readonly limitations: readonly string[];
    }
  | {
      readonly resolvedPath: null;
      readonly status: UnresolvedArtifactPathStatus;
      readonly limitations: readonly string[];
    };

/** Resolve one declaration while preserving its original input identity. */
export const resolveArtifactPathByContext = (
  input: ResolveArtifactPathInput,
): ArtifactPathResolution => {
  const resolution = resolvePath(input);
  return resolution.status === "resolved"
    ? {
        declared_path: input.declaredPath,
        resolution_context: input.context,
        resolved_path: resolution.resolvedPath,
        resolution_status: resolution.status,
        limitations: resolution.limitations,
      }
    : {
        declared_path: input.declaredPath,
        resolution_context: input.context,
        resolved_path: null,
        resolution_status: resolution.status,
        limitations: resolution.limitations,
      };
};

const resolvePath = (input: ResolveArtifactPathInput): CandidateResolution => {
  const rejected = rejectDeclaration(input.declaredPath);
  if (rejected !== null) return rejected;
  const candidate = contextualCandidate(input);
  if (typeof candidate !== "string") return candidate;
  const confined = confineCandidate(candidate);
  if (typeof confined !== "string") return confined;
  if (input.context === "html-reference")
    return (
      resolveFileCandidates(input, [confined]) ??
      unresolvedCandidate("not-found", [
        `The exact HTML resource ${confined} was not found among the selected application files.`,
      ])
    );
  return resolveCandidate(input, confined, new Set());
};

const rejectDeclaration = (declared: string): CandidateResolution | null => {
  if (declared.length === 0)
    return unresolvedCandidate("rejected", ["The declared path is empty."]);
  if (declared.includes("\0") || declared.includes("\\"))
    return unresolvedCandidate("rejected", [
      "NUL and backslash path syntax are not admitted for canonical artifact paths.",
    ]);
  if (!admitsCanonicalPathSyntax(declared))
    return unresolvedCandidate("rejected", [
      "Encoded dot or separator bytes are rejected before artifact path resolution.",
    ]);
  return null;
};

const contextualCandidate = (
  input: ResolveArtifactPathInput,
): string | CandidateResolution => {
  const { context } = input;
  let declared =
    context === "html-reference" ||
    context === "url-reference" ||
    (context === "module-specifier" && input.moduleKind !== "require")
      ? stripQueryAndFragment(input.declaredPath)
      : input.declaredPath;
  if (context === "html-reference") return htmlCandidate(input);
  if (context === "module-specifier") {
    const fileUrl = fileUrlPath(declared);
    if (fileUrl !== undefined) return fileUrl;
    if (hasScheme(declared))
      return unresolvedCandidate("external", [
        "URL and Node builtin schemes are outside static artifact module resolution.",
      ]);
    if (!declared.startsWith(".") && !declared.startsWith("/"))
      return bareModuleCandidate(input, declared);
    if (input.moduleKind !== "require") {
      const decoded = decodeModuleUrlPath(declared);
      if (typeof decoded !== "string") return decoded;
      declared = decoded;
    }
  } else if (looksExternal(declared))
    return unresolvedCandidate("external", [
      "URL schemes and protocol-relative URLs are outside this local artifact path context.",
    ]);
  return relativeCandidate(input.sourcePath, declared);
};

const decodeModuleUrlPath = (
  declared: string,
): string | CandidateResolution => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(declared);
  } catch (cause: unknown) {
    void cause;
    return unresolvedCandidate("rejected", [
      "The module URL path contains malformed percent encoding.",
    ]);
  }
  return decoded.includes("\0")
    ? unresolvedCandidate("rejected", [
        "The decoded module URL path contains NUL.",
      ])
    : decoded;
};

const relativeCandidate = (sourcePath: string, declared: string): string =>
  declared.startsWith("/")
    ? declared.slice(1)
    : posix.join(posix.dirname(sourcePath), declared);

const bareModuleCandidate = (
  input: ResolveArtifactPathInput,
  declared: string,
): CandidateResolution => {
  const packageName = barePackageName(declared);
  if (packageName === null || isBuiltin(declared) || declared.startsWith("#"))
    return unresolvedCandidate("external", [
      "The bare specifier is a Node builtin, package import map, or invalid package name.",
    ]);
  const subpath =
    declared === packageName ? "." : `.${declared.slice(packageName.length)}`;
  const source = input.files.get(input.sourcePath);
  let directory = posix.dirname(input.sourcePath);
  while (true) {
    const candidate = posix.join(directory, "node_modules", packageName);
    if (subpath === ".") {
      const direct = resolveFileCandidates(input, fileCandidates(candidate));
      if (direct !== null) return direct;
    }
    if (hasContainerDirectory(input.files, candidate, source?.container_sha256))
      return resolvePackageSpecifier(input, candidate, subpath);
    if (directory === "." || directory === "") break;
    directory = posix.dirname(directory);
  }
  return unresolvedCandidate("external", [
    "No matching bare package was inventoried in an enclosing node_modules directory.",
  ]);
};

/** Package roots and exact subpaths share metadata and exports selection. */
const resolvePackageSpecifier = (
  input: ResolveArtifactPathInput,
  directory: string,
  subpath: string,
): CandidateResolution => {
  const metadata = readPackageMetadata(input, directory);
  if (metadata.kind === "unavailable")
    return unresolvedCandidate("unavailable", [metadata.limitation]);
  const rawExports =
    metadata.kind === "available"
      ? Reflect.get(metadata.value, "exports")
      : undefined;
  if (rawExports === undefined || rawExports === null) {
    if (subpath === ".")
      return resolveDirectory(input, directory, metadata, new Set());
    const candidate = confineCandidate(posix.join(directory, subpath.slice(2)));
    return typeof candidate === "string"
      ? resolveCandidate(input, candidate, new Set())
      : candidate;
  }
  const exported = selectPackageExport(rawExports, subpath, input.moduleKind);
  const packagePath = posix.join(directory, "package.json");
  if (exported.status === "rejected")
    return unresolvedCandidate("rejected", [
      `Package metadata ${packagePath}: ${exported.limitation}`,
    ]);
  if (exported.status === "unmatched")
    return unresolvedCandidate("external", [
      `Directory package metadata ${packagePath} declares no exports target ${subpath === "." ? "for the active conditions" : `for subpath ${subpath}`}; exports encapsulation permits no file or index lookup. It declares ${exported.declared.join(", ") || "a root target only"}.`,
    ]);
  if (exported.status === "blocked")
    return unresolvedCandidate("external", [
      `Directory package metadata ${packagePath} blocks subpath ${subpath} with an explicit null exports target.`,
    ]);
  return resolveExportTarget(input, packagePath, exported.value);
};

/** An exports target is a URL naming one exact file for both Node loaders. */
const resolveExportTarget = (
  input: ResolveArtifactPathInput,
  packagePath: string,
  target: string,
): CandidateResolution => {
  const rejected = rejectDeclaration(target);
  if (rejected !== null) return rejected;
  const decoded = decodeModuleUrlPath(stripQueryAndFragment(target));
  if (typeof decoded !== "string") return decoded;
  const candidate = confineCandidate(relativeCandidate(packagePath, decoded));
  if (typeof candidate !== "string") return candidate;
  return (
    resolveFileCandidates(input, [candidate]) ??
    exactExportsTargetNotFound(candidate)
  );
};

const barePackageName = (specifier: string): string | null => {
  const segments = specifier.split("/");
  if (specifier.startsWith("@"))
    return segments.length >= 2 && segments[0] !== "" && segments[1] !== ""
      ? `${segments[0]}/${segments[1]}`
      : null;
  return segments[0] === "" ? null : (segments[0] ?? null);
};

const hasContainerDirectory = (
  files: ReadonlyMap<string, JavaScriptArtifactFile>,
  candidate: string,
  containerSha256: string | undefined,
): boolean => {
  if (
    [...indexCandidates(candidate), posix.join(candidate, "package.json")].some(
      (path) => {
        const file = files.get(path);
        return (
          file !== undefined &&
          (containerSha256 === undefined ||
            file.container_sha256 === containerSha256)
        );
      },
    )
  )
    return true;
  // Inventory has files rather than directory entries. Any same-container
  // descendant establishes a package directory even without package.json.
  const prefix = `${candidate}/`;
  for (const [path, file] of files)
    if (
      path.startsWith(prefix) &&
      (containerSha256 === undefined ||
        file.container_sha256 === containerSha256)
    )
      return true;
  return false;
};

const htmlCandidate = (
  input: ResolveArtifactPathInput,
): string | CandidateResolution => {
  const declared = stripQueryAndFragment(htmlUrlText(input.declaredPath));
  if (looksExternal(declared))
    return unresolvedCandidate("external", [
      "External HTML references are not mapped to local artifact assets.",
    ]);
  const rawBase = input.htmlBaseHref;
  const base =
    rawBase === undefined || rawBase === null
      ? rawBase
      : stripQueryAndFragment(htmlUrlText(rawBase));
  if (base !== undefined && base !== null && looksExternal(base))
    return unresolvedCandidate("external", [
      "The document base href is external, so its script reference is not a local artifact path.",
    ]);
  // Removing URL tabs and newlines can join an encoded dot or separator that
  // the raw declaration split, so admit the parsed URL text again.
  if (!admitsCanonicalPathSyntax(declared))
    return unresolvedCandidate("rejected", [
      "Encoded dot or separator bytes are rejected before artifact path resolution.",
    ]);
  const declaredPath = percentDecodeUrlPath(declared);
  if (declaredPath === null)
    return unresolvedCandidate("rejected", [
      "The HTML reference path percent-decodes to NUL or to bytes that are not UTF-8.",
    ]);
  if (declaredPath.startsWith("/")) return declaredPath.slice(1);
  if (base === undefined || base === null || base === "")
    return declaredPath === ""
      ? input.sourcePath
      : posix.join(posix.dirname(input.sourcePath), declaredPath);
  // A local base href is a second untrusted path input; apply the same
  // admission rules a declared path gets so it cannot smuggle traversal or
  // separator syntax past canonicalization.
  if (!admitsCanonicalPathSyntax(base))
    return unresolvedCandidate("rejected", [
      "The document base href uses NUL, backslash, or encoded dot and separator bytes that are not admitted for canonical artifact paths.",
    ]);
  const decodedBase = percentDecodeUrlPath(base);
  if (decodedBase === null)
    return unresolvedCandidate("rejected", [
      "The document base href path percent-decodes to NUL or to bytes that are not UTF-8.",
    ]);
  const basePath = decodedBase.startsWith("/")
    ? decodedBase.slice(1)
    : posix.join(posix.dirname(input.sourcePath), decodedBase);
  if (declaredPath === "") return emptyHtmlReference(decodedBase, basePath);
  return posix.join(htmlBaseDirectory(decodedBase, basePath), declaredPath);
};

const emptyHtmlReference = (
  base: string,
  basePath: string,
): string | CandidateResolution => {
  if (!htmlBaseIsDirectory(base)) return basePath;
  const confined = confineCandidate(basePath);
  if (typeof confined !== "string") return confined;
  return unresolvedCandidate("not-found", [
    `The HTML reference resolves to directory ${confined || "."}, not an exact selected application file.`,
  ]);
};

/**
 * The directory a relative HTML reference resolves against. A base path
 * ending in "/" or in a "." or ".." segment is already a directory, because a
 * relative reference resolves against the base URL's directory and those
 * segments are dropped rather than stepped through.
 */
const htmlBaseIsDirectory = (base: string): boolean =>
  base.endsWith("/") ||
  base.endsWith("/.") ||
  base.endsWith("/..") ||
  base === "." ||
  base === "..";

const htmlBaseDirectory = (base: string, basePath: string): string =>
  htmlBaseIsDirectory(base) ? basePath : posix.dirname(basePath);

const confineCandidate = (candidate: string): string | CandidateResolution => {
  const normalized = posix.normalize(candidate);
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  )
    return unresolvedCandidate("rejected", [
      "The resolved candidate escapes the canonical artifact root.",
    ]);
  return normalized === "." ? "" : normalized;
};

type PackageMetadata =
  | {
      readonly kind: "available";
      readonly path: string;
      readonly value: object;
    }
  | { readonly kind: "absent" }
  | { readonly kind: "unavailable"; readonly limitation: string };

const readPackageMetadata = (
  input: ResolveArtifactPathInput,
  directory: string,
): PackageMetadata => {
  const path = posix.join(directory, "package.json");
  const file = input.files.get(path);
  const source = input.files.get(input.sourcePath);
  if (
    file === undefined ||
    (source !== undefined && file.container_sha256 !== source.container_sha256)
  )
    return { kind: "absent" };
  if (!file.text.included)
    return {
      kind: "unavailable",
      limitation: `Directory package metadata ${path} was inventoried but its text is unavailable: ${file.text.reason}.`,
    };
  let value: unknown;
  try {
    value = JSON.parse(file.text.value);
  } catch (cause: unknown) {
    void cause;
    return {
      kind: "unavailable",
      limitation: `Directory package metadata ${path} is not valid package JSON.`,
    };
  }
  return typeof value === "object" && value !== null
    ? { kind: "available", path, value }
    : {
        kind: "unavailable",
        limitation: `Directory package metadata ${path} is not valid package JSON.`,
      };
};

/** File and directory lookup never interprets a nested directory's exports. */
const resolveCandidate = (
  input: ResolveArtifactPathInput,
  candidate: string,
  packageChain: ReadonlySet<string>,
): CandidateResolution =>
  resolveFileCandidates(input, fileCandidates(candidate)) ??
  resolveDirectory(
    input,
    candidate,
    readPackageMetadata(input, candidate),
    packageChain,
  );

const resolveDirectory = (
  input: ResolveArtifactPathInput,
  directory: string,
  metadata: PackageMetadata,
  packageChain: ReadonlySet<string>,
): CandidateResolution => {
  if (metadata.kind === "absent")
    return (
      resolveFileCandidates(input, indexCandidates(directory)) ??
      notFoundCandidate()
    );
  if (metadata.kind === "unavailable")
    return unresolvedCandidate("unavailable", [metadata.limitation]);
  if (packageChain.has(metadata.path))
    return unresolvedCandidate("unavailable", [
      `Directory package entrypoint cycle includes ${metadata.path}.`,
    ]);
  const preferred = [
    Reflect.get(metadata.value, "main"),
    ...(input.moduleKind === undefined
      ? [Reflect.get(metadata.value, "module")]
      : []),
  ];
  const entry = preferred.find((value) => value !== undefined);
  if (entry === undefined)
    return (
      resolveFileCandidates(input, indexCandidates(directory)) ??
      notFoundCandidate()
    );
  if (typeof entry !== "string" || entry.length === 0)
    return unresolvedCandidate("unavailable", [
      `Directory package metadata ${metadata.path} is not valid package JSON.`,
    ]);
  const entryInput: ResolveArtifactPathInput = {
    declaredPath: entry,
    sourcePath: metadata.path,
    context: "package-entrypoint",
    files: input.files,
    ...(input.moduleKind === undefined ? {} : { moduleKind: input.moduleKind }),
  };
  const rejected = rejectDeclaration(entryInput.declaredPath);
  if (rejected !== null) return rejected;
  const candidate = contextualCandidate(entryInput);
  if (typeof candidate !== "string") return candidate;
  const confined = confineCandidate(candidate);
  if (typeof confined !== "string") return confined;
  const selected =
    resolveFileCandidates(entryInput, [
      ...fileCandidates(confined),
      ...indexCandidates(confined),
    ]) ?? resolveFileCandidates(input, indexCandidates(directory));
  if (selected !== null) return selected;
  return resolveCandidate(
    entryInput,
    confined,
    new Set([...packageChain, metadata.path]),
  );
};

const resolveFileCandidates = (
  input: ResolveArtifactPathInput,
  candidates: readonly string[],
): CandidateResolution | null => {
  const source = input.files.get(input.sourcePath);
  for (const path of candidates) {
    const target = input.files.get(path);
    if (
      target !== undefined &&
      (source === undefined ||
        target.container_sha256 === source.container_sha256)
    )
      return { resolvedPath: path, status: "resolved", limitations: [] };
  }
  return null;
};

const fileCandidates = (candidate: string): readonly string[] => [
  candidate,
  ...EXTENSIONS.map((extension) => `${candidate}${extension}`),
];

const indexCandidates = (candidate: string): readonly string[] =>
  EXTENSIONS.map((extension) => posix.join(candidate, `index${extension}`));

type PackageExportOutcome =
  | { readonly status: "value"; readonly value: string }
  | { readonly status: "rejected"; readonly limitation: string }
  | { readonly status: "blocked" }
  | { readonly status: "unmatched"; readonly declared: readonly string[] };

/** Only exact non-directory keys participate; wildcard expansion is unsupported. */
const selectPackageExport = (
  value: unknown,
  subpath: string,
  moduleKind: ResolveArtifactPathInput["moduleKind"],
): PackageExportOutcome => {
  let target = value;
  let declared: string[] = [];
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const keys = Object.keys(value);
    const hasSubpaths = keys.some((key) => key.startsWith("."));
    if (hasSubpaths && keys.some((key) => !key.startsWith(".")))
      return {
        status: "rejected",
        limitation:
          "The package exports configuration mixes subpath keys and condition keys.",
      };
    declared = keys;
    if (hasSubpaths) {
      if (
        subpath.endsWith("/") ||
        subpath.includes("*") ||
        !Object.hasOwn(value, subpath)
      )
        return { status: "unmatched", declared };
      target = Reflect.get(value, subpath);
    } else if (subpath !== ".") return { status: "unmatched", declared };
  } else if (subpath !== ".") return { status: "unmatched", declared };
  const selected = selectExportTarget(
    target,
    packageExportConditions(moduleKind),
  );
  if (selected.kind === "invalid" || selected.kind === "invalid-config")
    return { status: "rejected", limitation: selected.limitation };
  if (selected.kind === "unmatched")
    return {
      status: "unmatched",
      declared:
        typeof target === "object" && target !== null
          ? Object.keys(target)
          : declared,
    };
  return selected.kind === "blocked"
    ? { status: "blocked" }
    : { status: "value", value: selected.value };
};

type ExportTargetOutcome =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "blocked" }
  | { readonly kind: "unmatched" }
  | { readonly kind: "invalid"; readonly limitation: string }
  | { readonly kind: "invalid-config"; readonly limitation: string };

const invalidExportTarget = (
  value: unknown,
  reason: string,
): ExportTargetOutcome => ({
  kind: "invalid",
  limitation: `The package exports target ${JSON.stringify(value) ?? String(value)} ${reason}.`,
});

// Node checks raw target segments before URL normalization. Compare encoded
// segment names here; full URL decoding follows array target selection.
const forbiddenExportSegment = (value: string): string | undefined =>
  value
    .slice(2)
    .split(/[\\/]/u)
    .find((raw) => {
      const segment = raw.replace(/%[0-9a-f]{2}/giu, (encoded) =>
        String.fromCharCode(Number.parseInt(encoded.slice(1), 16)),
      );
      return (
        segment === "." ||
        segment === ".." ||
        segment.toLowerCase() === "node_modules"
      );
    });

/**
 * Resolve a target in Node's declared order. Explicit null blocks an active
 * condition, whereas an unmatched nested object permits the next condition.
 * An array skips unmatched and invalid entries, stops at its first string, and
 * preserves the final invalid-versus-null refusal if no string is selected.
 */
const selectExportTarget = (
  value: unknown,
  conditions: ReadonlySet<string>,
): ExportTargetOutcome => {
  if (typeof value === "string") {
    if (!value.startsWith("./"))
      return invalidExportTarget(value, 'must start with "./"');
    const forbidden = forbiddenExportSegment(value);
    return forbidden === undefined
      ? { kind: "value", value }
      : invalidExportTarget(
          value,
          `contains forbidden path segment ${JSON.stringify(forbidden)} before URL normalization`,
        );
  }
  if (value === null) return { kind: "blocked" };
  if (Array.isArray(value)) {
    let invalid: string | null = null;
    for (const entry of value) {
      const nested = selectExportTarget(entry, conditions);
      // Node's array fallback catches invalid targets, not invalid configuration.
      if (nested.kind === "invalid-config") return nested;
      if (nested.kind === "invalid") {
        invalid = nested.limitation;
        continue;
      }
      if (nested.kind === "unmatched") continue;
      invalid = null;
      if (nested.kind === "value") return nested;
    }
    return invalid === null
      ? { kind: "blocked" }
      : { kind: "invalid", limitation: invalid };
  }
  if (typeof value !== "object")
    return invalidExportTarget(
      value,
      "must be a relative string, object, array, or null",
    );
  for (const key of Object.keys(value)) {
    const numeric = Number(key);
    if (String(numeric) === key && numeric >= 0 && numeric < 0xffff_ffff)
      return {
        kind: "invalid-config",
        limitation: `The package exports configuration contains numeric condition key ${JSON.stringify(key)}.`,
      };
  }
  for (const [condition, target] of Object.entries(value)) {
    if (!conditions.has(condition)) continue;
    const nested = selectExportTarget(target, conditions);
    if (nested.kind !== "unmatched") return nested;
  }
  return { kind: "unmatched" };
};

/**
 * Node selects an exports target by walking the declared keys in order and
 * taking the first whose condition is active for the calling resolver.
 * "default" is always active, and "node" plus "node-addons" are active for the
 * built-in resolver that owns installed-package imports and requires. The
 * supported Node runtimes also activate "module-sync" for both loaders.
 */
const packageExportConditions = (
  moduleKind: ResolveArtifactPathInput["moduleKind"],
): ReadonlySet<string> =>
  new Set([
    "node",
    "node-addons",
    "module-sync",
    ...(moduleKind === undefined ? [] : [moduleKind]),
    "default",
  ]);

const notFoundCandidate = (): CandidateResolution => ({
  resolvedPath: null,
  status: "not-found",
  limitations: [
    "No extension, directory package, or index candidate exists in the inventoried artifact container.",
  ],
});

const exactExportsTargetNotFound = (path: string): CandidateResolution => ({
  resolvedPath: null,
  status: "not-found",
  limitations: [
    `The selected package exports target ${path} does not exist in the inventoried artifact container; exports targets are exact files, so no extension or directory index was tried.`,
  ],
});

const fileUrlPath = (value: string): string | undefined => {
  if (!value.startsWith("file://")) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "file:" || url.hostname !== "") return undefined;
    return decodeURIComponent(url.pathname).replace(/^\/+/, "");
  } catch (cause: unknown) {
    // Unparseable file URLs have no path to resolve.
    void cause;
    return undefined;
  }
};

const unresolvedCandidate = (
  status: UnresolvedArtifactPathStatus,
  limitations: readonly string[],
): CandidateResolution => ({ resolvedPath: null, status, limitations });
