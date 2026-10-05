import { builtinModules } from "node:module";
import { posix } from "node:path";

import type { JavaScriptArtifactFile } from "./JavaScriptArtifactFiles.js";

type ArtifactPathResolutionContext =
  | "package-entrypoint"
  | "filesystem-expression"
  | "module-specifier"
  | "html-reference";

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
const NODE_BUILTINS = new Set(
  builtinModules.map((name) => name.replace(/^node:/u, "")),
);

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
): ArtifactPathResolution => {
  const rejected = rejectDeclaration(input);
  if (rejected !== null) return rejected;
  const candidate = contextualCandidate(input);
  if (typeof candidate !== "string") return candidate;
  const confined = confineCandidate(input, candidate);
  if (typeof confined !== "string") return confined;
  const resolved =
    mode === "files-and-index"
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
  if (/%(?:2e|2f|5c)/iu.test(declared))
    return unresolvedOutcome(input, "rejected", [
      "Encoded dot or separator bytes are rejected before artifact path resolution.",
    ]);
  return null;
};

const contextualCandidate = (
  input: ResolveArtifactPathInput,
): string | ArtifactPathResolution => {
  const { context } = input;
  const declared =
    context === "html-reference" ||
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
  } else if (hasScheme(declared))
    return unresolvedOutcome(input, "external", [
      "URL schemes are outside this local artifact path context.",
    ]);
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
  if (
    packageName === null ||
    NODE_BUILTINS.has(packageName) ||
    declared.startsWith("#")
  )
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
  const declared = stripQueryAndFragment(input.declaredPath);
  if (hasScheme(declared) || declared.startsWith("//"))
    return unresolvedOutcome(input, "external", [
      "External HTML references are not mapped to local artifact assets.",
    ]);
  const rawBase = input.htmlBaseHref;
  const base =
    rawBase === undefined || rawBase === null
      ? rawBase
      : stripQueryAndFragment(rawBase);
  if (
    base !== undefined &&
    base !== null &&
    (hasScheme(base) || base.startsWith("//"))
  )
    return unresolvedOutcome(input, "external", [
      "The document base href is external, so its script reference is not a local artifact path.",
    ]);
  if (declared.startsWith("/")) return declared.slice(1);
  if (base === undefined || base === null || base === "")
    return posix.join(posix.dirname(input.sourcePath), declared);
  const basePath = base.startsWith("/")
    ? base.slice(1)
    : posix.join(posix.dirname(input.sourcePath), base);
  const baseDirectory = base.endsWith("/") ? basePath : posix.dirname(basePath);
  return posix.join(baseDirectory, declared);
};

const confineCandidate = (
  input: ResolveArtifactPathInput,
  candidate: string,
): string | ArtifactPathResolution => {
  const normalized = posix.normalize(candidate);
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  )
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
  return candidateOutcome(resolvePackagePath(entryInput, chain));
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
  | { readonly status: "invalid" } => {
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
    const preferred =
      moduleKind === "import"
        ? [Reflect.get(value, "module"), Reflect.get(value, "main")]
        : [Reflect.get(value, "main"), Reflect.get(value, "module")];
    const entry = preferred.find((candidate) => candidate !== undefined);
    if (entry === undefined) return { status: "missing" };
    const legacy = packagePathValue(entry);
    return legacy.status === "value" ? { ...legacy, source: "legacy" } : legacy;
  } catch {
    return { status: "invalid" };
  }
};

const packageExport = (
  value: unknown,
  moduleKind: ResolveArtifactPathInput["moduleKind"],
):
  | { readonly status: "value"; readonly value: string }
  | { readonly status: "invalid" } => {
  if (typeof value === "string") return packagePathValue(value);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { status: "invalid" };
  const root = Reflect.get(value, ".") ?? value;
  if (typeof root === "string") return packagePathValue(root);
  if (typeof root !== "object" || root === null || Array.isArray(root))
    return { status: "invalid" };
  const condition =
    Reflect.get(root, moduleKind ?? "default") ?? Reflect.get(root, "default");
  return packagePathValue(condition);
};

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

const hasScheme = (value: string): boolean =>
  /^[A-Za-z][A-Za-z+.-]*:/u.test(value);

const fileUrlPath = (value: string): string | undefined => {
  if (!value.startsWith("file://")) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "file:" || url.hostname !== "") return undefined;
    return decodeURIComponent(url.pathname).replace(/^\/+/, "");
  } catch {
    return undefined;
  }
};

const stripQueryAndFragment = (value: string): string =>
  value.split("#", 1)[0]?.split("?", 1)[0] ?? "";

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
