import { isBuiltin } from "node:module";
import { posix } from "node:path";

import {
  normalizeJoinedLogicalPath,
  logicalPathEscapesRoot,
} from "../../domain/artifactIdentity.js";
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

/** Resolve one declaration under its exact syntax/metadata context. */
export const resolveArtifactPathByContext = (
  input: ResolveArtifactPathInput,
): ArtifactPathResolution => resolvePackagePath(input, new Set());

const resolvePackagePath = (
  input: ResolveArtifactPathInput,
  packageChain: ReadonlySet<string>,
  mode: "full" | "files-and-index" = "full",
  exportsTargetUrl = false,
): ArtifactPathResolution => {
  const rejected = rejectDeclaration(input);
  if (rejected !== null) return rejected;
  const candidate = contextualCandidate(input, exportsTargetUrl);
  if (typeof candidate !== "string") return candidate;
  const confined = confineCandidate(input, candidate);
  if (typeof confined !== "string") return confined;
  if (input.context === "html-reference")
    return outcome(
      input,
      resolveFileCandidates(input, [confined]) ?? {
        resolvedPath: null,
        status: "not-found",
        limitations: [
          `The exact HTML resource ${confined} was not found among the selected application files.`,
        ],
      },
    );
  // An exports target names one exact file; Node tries no extension or index.
  const resolved = exportsTargetUrl
    ? (resolveFileCandidates(input, [confined]) ??
      exactExportsTargetNotFound(confined))
    : mode === "files-and-index"
      ? (resolveFileCandidates(input, [
          ...fileCandidates(confined),
          ...indexCandidates(confined),
        ]) ?? notFoundCandidate())
      : resolveCandidate(input, confined, packageChain);
  return outcome(input, resolved);
};

const rejectDeclaration = (
  input: ResolveArtifactPathInput,
): ArtifactPathResolution | null => {
  const declared = input.declaredPath;
  if (declared.length === 0)
    return unresolvedOutcome(input, "rejected", [
      "The declared path is empty.",
    ]);
  if (declared.includes("\0") || declared.includes("\\"))
    return unresolvedOutcome(input, "rejected", [
      "NUL and backslash path syntax are not admitted for canonical artifact paths.",
    ]);
  if (!admitsCanonicalPathSyntax(declared))
    return unresolvedOutcome(input, "rejected", [
      "Encoded dot or separator bytes are rejected before artifact path resolution.",
    ]);
  return null;
};

const contextualCandidate = (
  input: ResolveArtifactPathInput,
  exportsTargetUrl: boolean,
): string | ArtifactPathResolution => {
  const { context } = input;
  let declared =
    context === "html-reference" ||
    context === "url-reference" ||
    exportsTargetUrl ||
    (context === "module-specifier" && input.moduleKind !== "require")
      ? stripQueryAndFragment(input.declaredPath)
      : input.declaredPath;
  if (context === "html-reference") return htmlCandidate(input);
  if (context === "module-specifier") {
    const fileUrl = fileUrlPath(declared);
    if (fileUrl !== undefined) return fileUrl;
    if (hasScheme(declared))
      return unresolvedOutcome(input, "external", [
        "URL and Node builtin schemes are outside static artifact module resolution.",
      ]);
    if (!declared.startsWith(".") && !declared.startsWith("/"))
      return bareModuleCandidate(input, declared);
  } else if (looksExternal(declared))
    return unresolvedOutcome(input, "external", [
      "URL schemes and protocol-relative URLs are outside this local artifact path context.",
    ]);
  // Exports targets use URL paths for both loaders; legacy main fields remain literal.
  if (
    exportsTargetUrl ||
    (context === "module-specifier" && input.moduleKind !== "require")
  ) {
    try {
      declared = decodeURIComponent(declared);
    } catch (cause: unknown) {
      void cause;
      return unresolvedOutcome(input, "rejected", [
        "The module URL path contains malformed percent encoding.",
      ]);
    }
    if (declared.includes("\0"))
      return unresolvedOutcome(input, "rejected", [
        "The decoded module URL path contains NUL.",
      ]);
  }
  const relative = declared.startsWith("/") ? declared.slice(1) : declared;
  return declared.startsWith("/")
    ? relative
    : posix.join(posix.dirname(input.sourcePath), relative);
};

const bareModuleCandidate = (
  input: ResolveArtifactPathInput,
  declared: string,
): string | ArtifactPathResolution => {
  const packageName = barePackageName(declared);
  if (packageName === null || isBuiltin(declared) || declared.startsWith("#"))
    return unresolvedOutcome(input, "external", [
      "The bare specifier is a Node builtin, package import map, or invalid package name.",
    ]);
  if (declared !== packageName)
    return unresolvedOutcome(input, "external", [
      "Bare package subpaths remain unresolved unless an exact package-exports subpath model is available.",
    ]);
  const source = input.files.get(input.sourcePath);
  let directory = posix.dirname(input.sourcePath);
  while (true) {
    const candidate = posix.join(directory, "node_modules", declared);
    if (hasContainerCandidate(input.files, candidate, source?.container_sha256))
      return candidate;
    if (directory === "." || directory === "") break;
    directory = posix.dirname(directory);
  }
  return unresolvedOutcome(input, "external", [
    "No matching bare package was inventoried in an enclosing node_modules directory.",
  ]);
};

const barePackageName = (specifier: string): string | null => {
  const segments = specifier.split("/");
  if (specifier.startsWith("@"))
    return segments.length >= 2 && segments[0] !== "" && segments[1] !== ""
      ? `${segments[0]}/${segments[1]}`
      : null;
  return segments[0] === "" ? null : (segments[0] ?? null);
};

const hasContainerCandidate = (
  files: ReadonlyMap<string, JavaScriptArtifactFile>,
  candidate: string,
  containerSha256: string | undefined,
): boolean =>
  [
    ...fileCandidates(candidate),
    ...indexCandidates(candidate),
    posix.join(candidate, "package.json"),
  ].some((path) => {
    const file = files.get(path);
    return (
      file !== undefined &&
      (containerSha256 === undefined ||
        file.container_sha256 === containerSha256)
    );
  });

const htmlCandidate = (
  input: ResolveArtifactPathInput,
): string | ArtifactPathResolution => {
  const declared = stripQueryAndFragment(htmlUrlText(input.declaredPath));
  if (looksExternal(declared))
    return unresolvedOutcome(input, "external", [
      "External HTML references are not mapped to local artifact assets.",
    ]);
  const rawBase = input.htmlBaseHref;
  const base =
    rawBase === undefined || rawBase === null
      ? rawBase
      : stripQueryAndFragment(htmlUrlText(rawBase));
  if (base !== undefined && base !== null && looksExternal(base))
    return unresolvedOutcome(input, "external", [
      "The document base href is external, so its script reference is not a local artifact path.",
    ]);
  // Removing URL tabs and newlines can join an encoded dot or separator that
  // the raw declaration split, so admit the parsed URL text again.
  if (!admitsCanonicalPathSyntax(declared))
    return unresolvedOutcome(input, "rejected", [
      "Encoded dot or separator bytes are rejected before artifact path resolution.",
    ]);
  const declaredPath = percentDecodeUrlPath(declared);
  if (declaredPath === null)
    return unresolvedOutcome(input, "rejected", [
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
    return unresolvedOutcome(input, "rejected", [
      "The document base href uses NUL, backslash, or encoded dot and separator bytes that are not admitted for canonical artifact paths.",
    ]);
  const decodedBase = percentDecodeUrlPath(base);
  if (decodedBase === null)
    return unresolvedOutcome(input, "rejected", [
      "The document base href path percent-decodes to NUL or to bytes that are not UTF-8.",
    ]);
  const basePath = decodedBase.startsWith("/")
    ? decodedBase.slice(1)
    : posix.join(posix.dirname(input.sourcePath), decodedBase);
  if (declaredPath === "")
    return emptyHtmlReference(input, decodedBase, basePath);
  return posix.join(htmlBaseDirectory(decodedBase, basePath), declaredPath);
};

const emptyHtmlReference = (
  input: ResolveArtifactPathInput,
  base: string,
  basePath: string,
): string | ArtifactPathResolution => {
  if (!htmlBaseIsDirectory(base)) return basePath;
  const confined = confineCandidate(input, basePath);
  if (typeof confined !== "string") return confined;
  return unresolvedOutcome(input, "not-found", [
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

const confineCandidate = (
  input: ResolveArtifactPathInput,
  candidate: string,
): string | ArtifactPathResolution => {
  const normalized = normalizeJoinedLogicalPath(candidate);
  if (logicalPathEscapesRoot(normalized))
    return unresolvedOutcome(input, "rejected", [
      "The resolved candidate escapes the canonical artifact root.",
    ]);
  return normalized === "." ? "" : normalized;
};

const resolveCandidate = (
  input: ResolveArtifactPathInput,
  candidate: string,
  packageChain: ReadonlySet<string>,
): CandidateResolution => {
  const direct = resolveFileCandidates(input, fileCandidates(candidate));
  if (direct !== null) return direct;
  const source = input.files.get(input.sourcePath);
  const packagePath = posix.join(candidate, "package.json");
  const packageFile = input.files.get(packagePath);
  if (
    packageFile === undefined ||
    (source !== undefined &&
      packageFile.container_sha256 !== source.container_sha256)
  )
    return (
      resolveFileCandidates(input, indexCandidates(candidate)) ??
      notFoundCandidate()
    );
  if (!packageFile.text.included)
    return {
      resolvedPath: null,
      status: "unavailable",
      limitations: [
        `Directory package metadata ${packagePath} was inventoried but its text is unavailable: ${packageFile.text.reason}.`,
      ],
    };
  const main = packageEntry(
    packageFile.text.value,
    input.moduleKind,
    input.context === "module-specifier" &&
      !input.declaredPath.startsWith(".") &&
      !input.declaredPath.startsWith("/") &&
      !hasScheme(input.declaredPath),
  );
  if (main.status === "invalid")
    return {
      resolvedPath: null,
      status: "unavailable",
      limitations: [
        `Directory package metadata ${packagePath} is not valid package JSON.`,
      ],
    };
  if (main.status === "rejected")
    return {
      resolvedPath: null,
      status: "rejected",
      limitations: [`Package metadata ${packagePath}: ${main.limitation}`],
    };
  if (main.status === "unmatched")
    return {
      resolvedPath: null,
      status: "external",
      limitations: [
        `Directory package metadata ${packagePath} declares no exports target for the active conditions; it declares ${main.declared.join(", ")}.`,
      ],
    };
  if (packageChain.has(packagePath)) {
    return {
      resolvedPath: null,
      status: "unavailable",
      limitations: [
        `Directory package entrypoint cycle includes ${packagePath}.`,
      ],
    };
  }
  if (main.status === "missing")
    return (
      resolveFileCandidates(input, indexCandidates(candidate)) ??
      notFoundCandidate()
    );
  const entryInput: ResolveArtifactPathInput = {
    declaredPath: main.value,
    sourcePath: packagePath,
    context: "package-entrypoint",
    files: input.files,
  };
  const chain = new Set([...packageChain, packagePath]);
  if (main.source === "legacy") {
    const entry = resolvePackagePath(entryInput, chain, "files-and-index");
    if (entry.resolution_status !== "not-found") return candidateOutcome(entry);
    const index = resolveFileCandidates(input, indexCandidates(candidate));
    if (index !== null) return index;
  }
  // Preserve recursive artifact package lookup only after legacy file/index fallbacks.
  return candidateOutcome(
    resolvePackagePath(entryInput, chain, "full", main.source === "exports"),
  );
};

const candidateOutcome = (
  nested: ArtifactPathResolution,
): CandidateResolution =>
  nested.resolution_status === "resolved"
    ? {
        resolvedPath: nested.resolved_path,
        status: nested.resolution_status,
        limitations: nested.limitations,
      }
    : {
        resolvedPath: null,
        status: nested.resolution_status,
        limitations: nested.limitations,
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

const packageEntry = (
  text: string,
  moduleKind: ResolveArtifactPathInput["moduleKind"],
  useExports: boolean,
):
  | {
      readonly status: "value";
      readonly value: string;
      readonly source: "legacy" | "exports";
    }
  | { readonly status: "missing" }
  | { readonly status: "invalid" }
  | { readonly status: "rejected"; readonly limitation: string }
  | { readonly status: "unmatched"; readonly declared: readonly string[] } => {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null)
      return { status: "invalid" };
    const rawExports = Reflect.get(value, "exports");
    if (useExports && rawExports !== undefined && rawExports !== null) {
      const exported = packageExport(rawExports, moduleKind);
      return exported.status === "value"
        ? { ...exported, source: "exports" }
        : exported;
    }
    // Node imports and requires ignore the bundler-only module field. Keep
    // that fallback for callers without an explicit module-loading kind.
    const preferred = [
      Reflect.get(value, "main"),
      ...(moduleKind === undefined ? [Reflect.get(value, "module")] : []),
    ];
    const entry = preferred.find((candidate) => candidate !== undefined);
    if (entry === undefined) return { status: "missing" };
    const legacy = packagePathValue(entry);
    return legacy.status === "value" ? { ...legacy, source: "legacy" } : legacy;
  } catch (cause: unknown) {
    // Reflect-based manifest reads fail closed as invalid.
    void cause;
    return { status: "invalid" };
  }
};

const packageExport = (
  value: unknown,
  moduleKind: ResolveArtifactPathInput["moduleKind"],
): PackageExportOutcome => {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (
      keys.some((key) => key.startsWith(".")) &&
      keys.some((key) => !key.startsWith("."))
    )
      return {
        status: "rejected",
        limitation:
          "The package exports configuration mixes subpath keys and condition keys.",
      };
  }
  const root =
    typeof value === "object" && value !== null && Object.hasOwn(value, ".")
      ? Reflect.get(value, ".")
      : value;
  const flattened = exportTargets(root, packageExportConditions(moduleKind));
  if (flattened.kind === "invalid" || flattened.kind === "invalid-config")
    return { status: "rejected", limitation: flattened.limitation };
  const first =
    flattened.kind === "unmatched" ? undefined : flattened.values[0];
  return first === undefined
    ? {
        status: "unmatched",
        declared:
          typeof root === "object" && root !== null ? Object.keys(root) : [],
      }
    : { status: "value", value: first };
};

type ExportTargets =
  | { readonly kind: "targets"; readonly values: readonly string[] }
  | { readonly kind: "unmatched" }
  | { readonly kind: "invalid"; readonly limitation: string }
  | { readonly kind: "invalid-config"; readonly limitation: string };

const invalidExportTarget = (
  value: unknown,
  reason: string,
): ExportTargets => ({
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
const exportTargets = (
  value: unknown,
  conditions: ReadonlySet<string>,
): ExportTargets => {
  if (typeof value === "string") {
    if (!value.startsWith("./"))
      return invalidExportTarget(value, 'must start with "./"');
    const forbidden = forbiddenExportSegment(value);
    return forbidden === undefined
      ? { kind: "targets", values: [value] }
      : invalidExportTarget(
          value,
          `contains forbidden path segment ${JSON.stringify(forbidden)} before URL normalization`,
        );
  }
  if (value === null) return { kind: "targets", values: [] };
  if (Array.isArray(value)) {
    let invalid: string | null = null;
    for (const entry of value) {
      const nested = exportTargets(entry, conditions);
      // Node's array fallback catches invalid targets, not invalid configuration.
      if (nested.kind === "invalid-config") return nested;
      if (nested.kind === "invalid") {
        invalid = nested.limitation;
        continue;
      }
      if (nested.kind === "unmatched") continue;
      invalid = null;
      if (nested.values.length > 0) return nested;
    }
    return invalid === null
      ? { kind: "targets", values: [] }
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
    const nested = exportTargets(target, conditions);
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

type PackageExportOutcome =
  | { readonly status: "value"; readonly value: string }
  | { readonly status: "rejected"; readonly limitation: string }
  | { readonly status: "unmatched"; readonly declared: readonly string[] };

const packagePathValue = (
  value: unknown,
):
  | { readonly status: "value"; readonly value: string }
  | { readonly status: "invalid" } =>
  typeof value === "string" && value.length > 0
    ? { status: "value", value }
    : { status: "invalid" };

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

const outcome = (
  input: ResolveArtifactPathInput,
  resolution: CandidateResolution,
): ArtifactPathResolution =>
  resolution.status === "resolved"
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

const unresolvedOutcome = (
  input: ResolveArtifactPathInput,
  status: UnresolvedArtifactPathStatus,
  limitations: readonly string[],
): ArtifactPathResolution =>
  outcome(input, { resolvedPath: null, status, limitations });
