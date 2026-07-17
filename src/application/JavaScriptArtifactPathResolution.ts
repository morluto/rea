import { posix } from "node:path";

import type { JavaScriptArtifactFile } from "./JavaScriptArtifactFiles.js";

/** Explicit outcome of bounded, artifact-confined path resolution. */
export interface ArtifactPathResolution {
  readonly declared_path: string;
  readonly resolution_context:
    | "package-entrypoint"
    | "filesystem-expression"
    | "module-specifier"
    | "html-reference";
  readonly resolved_path: string | null;
  readonly resolution_status:
    | "resolved"
    | "not-found"
    | "unavailable"
    | "external"
    | "rejected";
  readonly limitations: readonly string[];
}

/** Values needed to resolve a declaration without filesystem access. */
export interface ResolveArtifactPathInput {
  readonly declaredPath: string;
  readonly sourcePath: string;
  readonly context:
    | "package-entrypoint"
    | "filesystem-expression"
    | "module-specifier"
    | "html-reference";
  readonly files: ReadonlyMap<string, JavaScriptArtifactFile>;
  readonly htmlBaseHref?: string | null;
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
const MAX_PACKAGE_DEPTH = 4;

interface CandidateResolution {
  readonly resolvedPath: string | null;
  readonly status: ArtifactPathResolution["resolution_status"];
  readonly limitations: readonly string[];
}

/** Resolve one declaration under its exact syntax/metadata context. */
export const resolveArtifactPathByContext = (
  input: ResolveArtifactPathInput,
): ArtifactPathResolution => resolveAtDepth(input, 0);

const resolveAtDepth = (
  input: ResolveArtifactPathInput,
  packageDepth: number,
): ArtifactPathResolution => {
  const rejected = rejectDeclaration(input);
  if (rejected !== null) return rejected;
  const candidate = contextualCandidate(input);
  if (typeof candidate !== "string") return candidate;
  const confined = confineCandidate(input, candidate);
  if (typeof confined !== "string") return confined;
  const resolved = resolveCandidate(input, confined, packageDepth);
  return outcome(
    input,
    resolved.status,
    resolved.resolvedPath,
    resolved.limitations,
  );
};

const rejectDeclaration = (
  input: ResolveArtifactPathInput,
): ArtifactPathResolution | null => {
  const declared = input.declaredPath;
  if (declared.length === 0)
    return outcome(input, "rejected", null, ["The declared path is empty."]);
  if (declared.length > 4_096)
    return outcome(input, "rejected", null, [
      "The declared path exceeds the 4096-character resolution bound.",
    ]);
  if (declared.includes("\0") || declared.includes("\\"))
    return outcome(input, "rejected", null, [
      "NUL and backslash path syntax are not admitted for canonical artifact paths.",
    ]);
  if (/%(?:2e|2f|5c)/iu.test(declared))
    return outcome(input, "rejected", null, [
      "Encoded dot or separator bytes are rejected before artifact path resolution.",
    ]);
  return null;
};

const contextualCandidate = (
  input: ResolveArtifactPathInput,
): string | ArtifactPathResolution => {
  const { context } = input;
  const declared =
    context === "module-specifier" || context === "html-reference"
      ? stripQueryAndFragment(input.declaredPath)
      : input.declaredPath;
  if (context === "html-reference") return htmlCandidate(input);
  if (context === "module-specifier") {
    const fileUrl = fileUrlPath(declared);
    if (fileUrl !== undefined) return fileUrl;
    if (hasScheme(declared))
      return outcome(input, "external", null, [
        "URL and Node builtin schemes are outside static artifact module resolution.",
      ]);
    if (!declared.startsWith(".") && !declared.startsWith("/"))
      return outcome(input, "external", null, [
        "Bare package and Node builtin specifiers are not artifact entrypoints.",
      ]);
  } else if (hasScheme(declared))
    return outcome(input, "external", null, [
      "URL schemes are outside this local artifact path context.",
    ]);
  const relative = declared.startsWith("/") ? declared.slice(1) : declared;
  return declared.startsWith("/")
    ? relative
    : posix.join(posix.dirname(input.sourcePath), relative);
};

const htmlCandidate = (
  input: ResolveArtifactPathInput,
): string | ArtifactPathResolution => {
  const declared = stripQueryAndFragment(input.declaredPath);
  if (hasScheme(declared))
    return outcome(input, "external", null, [
      "External HTML references are not mapped to local artifact assets.",
    ]);
  if (declared.startsWith("/")) return declared.slice(1);
  const base = input.htmlBaseHref;
  if (base === undefined || base === null || base === "")
    return posix.join(posix.dirname(input.sourcePath), declared);
  if (hasScheme(base))
    return outcome(input, "external", null, [
      "The document base href is external, so its script reference is not a local artifact path.",
    ]);
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
    return outcome(input, "rejected", null, [
      "The resolved candidate escapes the canonical artifact root.",
    ]);
  return normalized === "." ? "" : normalized;
};

const resolveCandidate = (
  input: ResolveArtifactPathInput,
  candidate: string,
  packageDepth: number,
): CandidateResolution => {
  const source = input.files.get(input.sourcePath);
  for (const path of directCandidates(candidate)) {
    const target = input.files.get(path);
    if (
      target !== undefined &&
      (source === undefined ||
        target.container_sha256 === source.container_sha256)
    )
      return { resolvedPath: path, status: "resolved", limitations: [] };
  }
  if (packageDepth >= MAX_PACKAGE_DEPTH)
    return {
      resolvedPath: null,
      status: "unavailable",
      limitations: [
        `Directory package resolution exceeded its ${String(MAX_PACKAGE_DEPTH)}-package recursion bound.`,
      ],
    };
  const packagePath = posix.join(candidate, "package.json");
  const packageFile = input.files.get(packagePath);
  if (
    packageFile === undefined ||
    (source !== undefined &&
      packageFile.container_sha256 !== source.container_sha256)
  )
    return notFoundCandidate();
  if (!packageFile.text.included)
    return {
      resolvedPath: null,
      status: "unavailable",
      limitations: [
        `Directory package metadata ${packagePath} was inventoried but its text is unavailable: ${packageFile.text.reason}.`,
      ],
    };
  const main = packageMain(packageFile.text.value);
  if (main.status === "invalid")
    return {
      resolvedPath: null,
      status: "unavailable",
      limitations: [
        `Directory package metadata ${packagePath} is not valid bounded package JSON.`,
      ],
    };
  if (main.status === "missing") return notFoundCandidate();
  const nested = resolveAtDepth(
    {
      declaredPath: main.value,
      sourcePath: packagePath,
      context: "package-entrypoint",
      files: input.files,
    },
    packageDepth + 1,
  );
  return {
    resolvedPath: nested.resolved_path,
    status: nested.resolution_status,
    limitations: nested.limitations,
  };
};

const directCandidates = (candidate: string): readonly string[] => [
  candidate,
  ...EXTENSIONS.map((extension) => `${candidate}${extension}`),
  ...EXTENSIONS.map((extension) => posix.join(candidate, `index${extension}`)),
];

const packageMain = (
  text: string,
):
  | { readonly status: "value"; readonly value: string }
  | { readonly status: "missing" }
  | { readonly status: "invalid" } => {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null)
      return { status: "invalid" };
    const main = Reflect.get(value, "main");
    if (main === undefined) return { status: "missing" };
    return typeof main === "string" && main.length <= 4_096
      ? { status: "value", value: main }
      : { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
};

const notFoundCandidate = (): CandidateResolution => ({
  resolvedPath: null,
  status: "not-found",
  limitations: [
    "No bounded extension, directory package, or index candidate exists in the inventoried artifact container.",
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
  status: ArtifactPathResolution["resolution_status"],
  resolvedPath: string | null,
  limitations: readonly string[],
): ArtifactPathResolution => ({
  declared_path: input.declaredPath,
  resolution_context: input.context,
  resolved_path: resolvedPath,
  resolution_status: status,
  limitations,
});
