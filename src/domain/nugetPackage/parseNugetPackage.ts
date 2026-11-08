import { createHash } from "node:crypto";
import type { Document, Element } from "@xmldom/xmldom";
import { parseXmlDocument } from "../xmlDocument.js";
import { err, ok, type Result } from "../result.js";
import {
  NUGET_PACKAGE_MAX_DIAGNOSTICS,
  NUGET_PACKAGE_MAX_NUSPEC_BYTES,
  type NugetAsset,
  type NugetDiagnostic,
  type NugetNuspec,
  type NugetPackage,
  type NugetPackageArtifact,
} from "./nugetPackage.js";

const digest = (prefix: string, ...parts: readonly (string | number)[]) =>
  `${prefix}_${createHash("sha256")
    .update(parts.map(String).join("\u0000"))
    .digest("hex")}`;

/** One admitted archive member, as the ZIP directory states it. */
export interface NugetArchiveMember {
  readonly path: string;
  /** The reader's own name for the member, present only when `path` rewrote it. */
  readonly sourcePath?: string | undefined;
  /** Whether the reader verified the stored name; false means it is decoded guesswork. */
  readonly nameVerified?: boolean | undefined;
  readonly bytes: number | null;
  readonly directory: boolean;
  readonly encrypted: boolean;
  /** The decoded text of a `.nuspec` member; absent for every other member. */
  readonly text?: string | undefined;
  /** A `.nuspec` that exceeds the read allowance, which is not the same as unreadable. */
  readonly oversized?: boolean | undefined;
  /** Reader uncertainty about the member itself, such as an undecoded stored name. */
  readonly limitations?: readonly string[] | undefined;
}

export interface ParseNugetPackageOptions {
  /** Member paths beyond this count are not inventoried. */
  readonly maxEntries: number;
}

/** A failure that belongs to the package as a whole, not to one member. */
export type NugetPackageParseError =
  | { readonly kind: "not-a-zip-archive"; readonly message: string }
  | { readonly kind: "entry-limit-reached"; readonly message: string };

const ASSET_PREFIXES = [
  ["lib/", "assemblies"],
  ["ref/", "ref"],
  ["runtimes/", "runtime"],
  ["analyzers/", "analyzers"],
  ["buildTransitive/", "build-transitive"],
  ["buildMultiTargeting/", "build-multitargeting"],
  ["build/", "build"],
  ["contentFiles/", "content-files"],
  ["content/", "content"],
  ["tools/", "tools"],
  ["resources/", "resources"],
  ["docs/", "docs"],
] as const;
type AssetKind = NugetAsset["kind"];

/**
 * A member path is safe when it stays inside the package: NuGet forbids
 * absolute roots, drive letters and `..` segments, and a hostile archive must
 * not hand those downstream as if they were ordinary package content.
 */
export const isSafeMemberPath = (path: string): boolean =>
  path.length > 0 &&
  !path.startsWith("/") &&
  !path.startsWith("\\") &&
  !/^[A-Za-z]:/u.test(path) &&
  !path.split(/[\\/]/u).some((segment) => segment === "..") &&
  !path.includes("\u0000");

const normalisePath = (path: string): string => path.replace(/\\/gu, "/");

const assembleKind = (path: string): AssetKind => {
  // NuGet ships native assets under runtimes/<rid>/native/, so that subtree has
  // to be classified before the broader runtimes/ rule claims it as runtime.
  if (/^runtimes\/[^/]+\/native\//u.test(path)) return "native";
  for (const [prefix, kind] of ASSET_PREFIXES)
    if (path.startsWith(prefix)) return kind;
  return "other";
};

/**
 * `lib/<tfm>/…` and `ref/<tfm>/…` put the framework in the second segment.
 * `runtimes/<rid>/lib/<tfm>/…` puts the RID second and the framework fourth.
 * A file placed directly under `lib/` has no framework folder.
 */
const frameworkSegment = (segment: string | undefined): string | null =>
  segment === undefined || segment.length === 0 ? null : segment;

const targetFramework = (path: string, directory: boolean): string | null => {
  const segments = path.split("/");
  if (segments.length < 3) return null;
  if (segments[0] === "lib" || segments[0] === "ref")
    return frameworkSegment(segments[1]);
  // build/, buildTransitive/ and buildMultiTargeting/ qualify their framework
  // in the second segment: <prefix>/<tfm>/<file|folder>. contentFiles/ keeps
  // its code language there: contentFiles/<codeLanguage>/<tfm>/<file|folder>.
  if (
    segments[0] === "build" ||
    segments[0] === "buildTransitive" ||
    segments[0] === "buildMultiTargeting"
  )
    return directory || segments.length >= 3
      ? frameworkSegment(segments[1])
      : null;
  if (segments[0] === "contentFiles")
    return directory || segments.length >= 4
      ? frameworkSegment(segments[2])
      : null;
  // A file's fourth segment is only a framework folder when another segment
  // follows it; otherwise it is the filename.
  if (segments[0] === "runtimes" && segments[2] === "lib")
    return directory || segments.length >= 5
      ? frameworkSegment(segments[3])
      : null;
  return null;
};

/**
 * `runtimes/<rid>/…` puts the RID in the second segment, and it is a directory
 * in both member kinds: a file written straight under `runtimes/` has a
 * filename there, and the `runtimes/` marker itself normalises to the bare
 * directory with no second segment.
 */
const runtimeIdentifier = (path: string, directory: boolean): string | null => {
  const segments = path.split("/");
  if (segments[0] !== "runtimes") return null;
  const rid = segments[1];
  if (rid === undefined || rid.length === 0) return null;
  // A file's second segment is only a directory when another segment follows.
  return !directory && segments.length < 3 ? null : rid;
};

/** Namespaces NuGet has published for the manifest root; a foreign one is not a nuspec. */
const NUSPEC_NAMESPACES: ReadonlySet<string> = new Set([
  "http://schemas.microsoft.com/packaging/2010/07/nuspec.xsd",
  "http://schemas.microsoft.com/packaging/2011/08/nuspec.xsd",
  "http://schemas.microsoft.com/packaging/2011/10/nuspec.xsd",
  "http://schemas.microsoft.com/packaging/2012/06/nuspec.xsd",
  "http://schemas.microsoft.com/packaging/2013/01/nuspec.xsd",
  "http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd",
]);

/** Read the text of the first descendant with the given local name. */
const textOf = (parent: Element, localName: string): string | null => {
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    const child = parent.childNodes.item(i);
    if (child === null || child.nodeType !== 1) continue;
    const element = child as Element;
    if (element.localName === localName) return element.textContent ?? null;
  }
  return null;
};

const childrenNamed = (parent: Element, localName: string): Element[] => {
  const found: Element[] = [];
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    const child = parent.childNodes.item(i);
    if (child === null || child.nodeType !== 1) continue;
    const element = child as Element;
    if (element.localName === localName) found.push(element);
  }
  return found;
};

class DiagnosticBudget {
  readonly diagnostics: NugetDiagnostic[] = [];
  readonly #packageWide: NugetDiagnostic[] = [];
  #exhausted = false;

  /** Package-level failures are reserved so per-entry growth cannot hide them. */
  add(
    path: string | null,
    code: NugetDiagnostic["code"],
    message: string,
    scope: "entry" | "package" = "entry",
  ): void {
    const diagnostic = {
      diagnostic_id: digest("nuget_diagnostic", code, path ?? "", message),
      path,
      code,
      message,
    };
    if (scope === "package") {
      this.#packageWide.push(diagnostic);
      return;
    }
    if (this.#exhausted) return;
    if (this.diagnostics.length >= NUGET_PACKAGE_MAX_DIAGNOSTICS) {
      this.#exhausted = true;
      this.diagnostics.push({
        diagnostic_id: digest("nuget_diagnostic", code, path ?? "", "limit"),
        path: null,
        code: "diagnostic-limit-reached",
        message: `Stopped recording diagnostics after ${String(NUGET_PACKAGE_MAX_DIAGNOSTICS)} entries; the remaining failures are not listed.`,
      });
      return;
    }
    this.diagnostics.push(diagnostic);
  }

  /** Per-entry diagnostics first, then the package-level ones that summary relies on. */
  report(): NugetDiagnostic[] {
    return [...this.diagnostics, ...this.#packageWide];
  }
}

const licenseOf = (metadata: Element): NugetNuspec["license"] => {
  const licence = childrenNamed(metadata, "license")[0];
  if (licence === undefined) return null;
  const value = licence.textContent ?? "";
  // Only the two declared kinds are modelled. A missing or unrecognised `type`
  // (e.g. the deprecated `url` form) is not an expression claim, so it stays
  // unknown rather than being reported as one; `license_url` carries its value.
  const type = licence.getAttribute("type");
  if (type !== "expression" && type !== "file") return null;
  return {
    kind: type === "file" ? "file" : "expression",
    value,
  };
};

const repositoryOf = (metadata: Element): NugetNuspec["repository"] => {
  const repository = childrenNamed(metadata, "repository")[0];
  if (repository === undefined) return null;
  return {
    url: declaredAttribute(repository, "url"),
    kind: declaredAttribute(repository, "type"),
    branch: declaredAttribute(repository, "branch"),
    commit: declaredAttribute(repository, "commit"),
  };
};

/**
 * An attribute the document did not write stays null; one written as the empty
 * string is the empty string. `|| null` conflates the two, and the declaration
 * contract keeps them apart.
 */
const declaredAttribute = (element: Element, name: string): string | null => {
  const value = element.getAttribute(name);
  return value === null ? null : value;
};

const dependenciesOf = (
  parent: Element,
): NugetNuspec["dependency_groups"][number]["dependencies"] =>
  childrenNamed(parent, "dependency").map((dependency) => ({
    // A dependency with no `id` names no package; reporting "" would invent a
    // name the document did not write and hide the omission from the reader.
    name: declaredAttribute(dependency, "id"),
    version_range: declaredAttribute(dependency, "version"),
    exclude: declaredAttribute(dependency, "exclude"),
    include: declaredAttribute(dependency, "include"),
  }));

const dependencyGroupsOf = (
  metadata: Element,
): NugetNuspec["dependency_groups"] => {
  const dependencies = childrenNamed(metadata, "dependencies")[0];
  if (dependencies === undefined) return [];
  const groups = childrenNamed(dependencies, "group").map((group) => ({
    target_framework: declaredAttribute(group, "targetFramework"),
    dependencies: dependenciesOf(group),
  }));
  // NuGet also writes <dependencies> with no <group>, listing the declarations
  // directly. That is the untargeted group, not an empty declaration set.
  const untargeted = dependenciesOf(dependencies);
  return untargeted.length === 0
    ? groups
    : [{ target_framework: null, dependencies: untargeted }, ...groups];
};

const nuspecOf = (
  member: NugetArchiveMember,
  nuspecs: NugetNuspec[],
  budget: DiagnosticBudget,
): void => {
  const source = member.text;
  if (member.oversized === true) {
    budget.add(
      member.path,
      "nuspec-too-large",
      `The .nuspec member exceeds the ${String(NUGET_PACKAGE_MAX_NUSPEC_BYTES)}-byte read allowance and was not parsed.`,
    );
    return;
  }
  if (source === undefined) {
    budget.add(
      member.path,
      "invalid-nuspec",
      "The .nuspec member could not be read as text.",
    );
    return;
  }
  const parsed = parseXmlDocument(source, {
    doctype: "reject",
    lineEndings: "normalize",
  });
  if (!parsed.ok) {
    budget.add(
      member.path,
      parsed.error.reason === "doctype"
        ? "unsupported-nuspec-doctype"
        : "invalid-nuspec",
      parsed.error.message,
    );
    return;
  }
  // A `.nuspec` is `<package><metadata>…`. `firstDescendant` alone would also
  // accept a nested or unrelated `<metadata>`, turning arbitrary XML into the
  // observed package identity, so require both the root and the direct child.
  const root = parsed.value.documentElement;
  // A foreign namespace with a <package> local name is not a NuGet manifest,
  // and the local-name lookups below would otherwise read its elements.
  if (root === null || root.localName !== "package") {
    budget.add(
      member.path,
      "invalid-nuspec",
      "The document element is not <package>.",
    );
    return;
  }
  if (root.namespaceURI !== null && !NUSPEC_NAMESPACES.has(root.namespaceURI)) {
    budget.add(
      member.path,
      "invalid-nuspec",
      `The document element is <package> in ${root.namespaceURI}, which is not a nuspec namespace.`,
    );
    return;
  }
  const metadata = childrenNamed(root, "metadata")[0];
  if (metadata === undefined) {
    budget.add(
      member.path,
      "invalid-nuspec",
      "The document has no <metadata> element.",
    );
    return;
  }
  nuspecs.push({
    nuspec_id: digest("nuspec", member.path, source),
    path: member.path,
    bytes: member.bytes ?? Buffer.byteLength(source, "utf8"),
    id: textOf(metadata, "id"),
    version: textOf(metadata, "version"),
    authors: textOf(metadata, "authors"),
    description: textOf(metadata, "description"),
    license: licenseOf(metadata),
    license_url: textOf(metadata, "licenseUrl"),
    project_url: textOf(metadata, "projectUrl"),
    repository: repositoryOf(metadata),
    dependency_groups: dependencyGroupsOf(metadata),
  });
};

const assetOf = (member: NugetArchiveMember): NugetAsset => {
  const path = normalisePath(member.path);
  return {
    asset_id: digest("nuget_asset", path),
    path,
    bytes: member.bytes,
    kind: assembleKind(path),
    target_framework: targetFramework(path, member.directory),
    runtime_identifier: runtimeIdentifier(path, member.directory),
    directory: member.directory,
  };
};

const isNuspecPath = (path: string): boolean =>
  normalisePath(path).toLowerCase().endsWith(".nuspec");

/**
 * Build the inventory in archive order. Members that the archive states as
 * encrypted, malformed or outside the package are reported rather than read;
 * their absence never reads as "the package does not contain this".
 */
export const parseNugetPackage = (
  artifact: NugetPackageArtifact,
  members: readonly NugetArchiveMember[],
  options: ParseNugetPackageOptions,
): Result<NugetPackage, NugetPackageParseError> => {
  const budget = new DiagnosticBudget();
  const nuspecs: NugetNuspec[] = [];
  const assets: NugetAsset[] = [];
  let nuspecMembers = 0;
  let truncated = false;
  const nameLimitations = new Set<string>();
  // Normalisation is recorded but never reduces coverage, so it needs its own
  // set: a fully read package with a `./` member is not a partial package.
  const normalisations = new Set<string>();
  let admitted = 0;

  for (const member of members) {
    // `members` is already the admitted slice, so the allowance applies to the
    // archive members once; counting assets plus nuspecs again would spend a
    // readable `.nuspec` twice and report a complete package as truncated.
    if (admitted >= options.maxEntries) {
      truncated = true;
      break;
    }
    for (const limitation of member.limitations ?? [])
      // A rewritten name is a normalisation the reader states structurally, so
      // it never reduces coverage; an unverified stored name is uncertainty and
      // always does, whether or not the same member was also normalised.
      if (member.sourcePath !== undefined && member.nameVerified !== false)
        normalisations.add(limitation);
      else nameLimitations.add(limitation);
    const path = normalisePath(member.path);
    if (!isSafeMemberPath(path)) {
      budget.add(
        member.path,
        "unsafe-entry-path",
        "The member path leaves the package root and is not inventoried.",
      );
      admitted += 1;
      continue;
    }
    if (member.encrypted) {
      budget.add(
        member.path,
        "encrypted-entry",
        "Encrypted archive members are not supported and were not read.",
      );
      admitted += 1;
      continue;
    }
    if (isNuspecPath(path)) {
      // Count candidates before parsing: a second nuspec that fails to parse
      // is still a second nuspec, and rejecting it must not erase the fact.
      nuspecMembers += 1;
      nuspecOf(member, nuspecs, budget);
    }
    assets.push(assetOf(member));
    admitted += 1;
  }

  const packageWide = (code: NugetDiagnostic["code"], message: string) =>
    budget.add(null, code, message, "package");
  if (truncated)
    packageWide(
      "entry-limit-reached",
      `Stopped after ${String(options.maxEntries)} inventoried members; the archive continues beyond this allowance.`,
    );
  if (nuspecs.length === 0)
    packageWide(
      "no-nuspec",
      "No readable .nuspec member was found, so package identity and declared dependencies are unknown.",
    );
  if (nuspecMembers > 1)
    packageWide(
      "duplicate-nuspec",
      `${String(nuspecMembers)} .nuspec members were found; each is reported separately rather than choosing one.`,
    );

  const diagnostics = budget.report();
  // A member name the reader could not verify makes the inventory a prefix in
  // two ways: this pass kept every read member but cannot trust their spelling,
  // and any member past the allowance was never read at all.
  const nameUnverified = members.some((member) => member.nameVerified === false);
  const partial =
    truncated ||
    nameUnverified ||
    nameLimitations.size > 0 ||
    diagnostics.some((entry) => entry.code !== "duplicate-nuspec");

  return ok({
    package_id: digest("nuget_package", artifact.sha256),
    format: "nupkg",
    artifact,
    nuspecs,
    assets,
    diagnostics,
    summary: {
      nuspecs: nuspecs.length,
      assets: assets.length,
      assemblies: assets.filter((asset) => asset.kind === "assemblies").length,
      diagnostics: diagnostics.length,
    },
    source_coverage: {
      scope: "package-contents",
      status: partial ? "partial" : "complete-within-scope",
      target_framework_selection: "not-applied",
      dependency_resolution: "not-performed",
      signatures: "not-verified",
      package_contents: "not-executed",
      network: "not-contacted",
    },
    limitations: [
      "Package metadata is publisher-provided; this inventory does not establish that the package is safe.",
      "Assets are listed by their archive paths. NuGet's restore-time selection for a target framework is not applied, so a listed asset is not a claim that a consumer receives it.",
      "Dependency groups and version ranges are declarations; packages are not restored and feeds are not contacted.",
      "Package signatures and the archive's member checksums beyond the ZIP reader's own verification are not evaluated.",
      ...nameLimitations,
      ...normalisations,
    ],
  });
};
