import { accountZipMemberRegion } from "../domain/zip/zipMemberRegion.js";
import {
  decodeLimit,
  malformedInput,
  ParseFailureError,
  unsupportedInput,
} from "../domain/parseFailure.js";
import {
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  type Entry,
  type FileEntry,
} from "@zip.js/zip.js";
import type { Element, Node } from "@xmldom/xmldom";

import {
  ArtifactReaderFailure,
  decodeZipEntryText,
  zipEntryNameLimitations,
  typedZipFailure,
  ZIP_READER_OPTIONS,
  zipEntryPath,
  zipListingCoverage,
} from "../resources/index.js";
import { parseXmlDocument } from "../domain/xmlDocument.js";
import { decodeXmlPlistText } from "../domain/propertyListXmlText.js";
import { hasZipSignature } from "../domain/zipPackageFormat.js";
import {
  NUGET_NUPKG_FORMAT,
  nugetNupkgEntryRole,
  nugetNupkgLogicalPath,
  type InspectNugetNupkgInput,
  type NugetNupkg,
} from "../domain/nuget/nupkg.js";
import { redactRecordedTransportUrl } from "../domain/recordedTransportUrl.js";
import { Budget } from "../domain/budget.js";

/** Limitation wording owned by the parser; tests assert delivery through these. */
export const NUPKG_LIMITATIONS = {
  memberRoles:
    "Member roles are derived from NuGet folder conventions in the ZIP names; they are not restore-time asset selection.",
  noNuspec: "No .nuspec was selected.",
  ambiguousRootNuspec:
    "Multiple root .nuspec members are present; identity was not decoded.",
  malformedNuspec: "The selected .nuspec is not well-formed XML.",
} as const;

const BASE_LIMITATIONS = [
  "This workflow reads the .nupkg ZIP and .nuspec metadata without restoring, executing, or contacting a NuGet feed.",
  NUPKG_LIMITATIONS.memberRoles,
  "Dependency version ranges are recorded as spelled in the .nuspec; restore results are unknown.",
  "Directory ZIP markers are omitted from contents; only file members are listed.",
] as const;

const isElement = (node: Node | null): node is Element =>
  node !== null && node.nodeType === 1;

const childElements = (element: Element): Element[] => {
  const children: Element[] = [];
  for (
    let child = element.firstChild;
    child !== null;
    child = child.nextSibling
  )
    if (isElement(child)) children.push(child);
  return children;
};

const childrenNamed = (element: Element, local: string): Element[] =>
  childElements(element).filter((child) => child.localName === local);

const firstNamed = (element: Element, local: string): Element | undefined =>
  childrenNamed(element, local)[0];

const nonempty = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

const attribute = (element: Element, name: string): string | null =>
  nonempty(element.getAttribute(name));

const elementText = (element: Element): string | null => {
  const parts: string[] = [];
  for (
    let child = element.firstChild;
    child !== null;
    child = child.nextSibling
  )
    // Text (3) and CDATA section (4) nodes both carry character data.
    if (child.nodeType === 3 || child.nodeType === 4)
      parts.push(child.nodeValue ?? "");
  return nonempty(parts.join(""));
};

const zipSize = (value: number | undefined): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;

const asFileEntry = (entry: Entry): entry is FileEntry =>
  !entry.directory && "getData" in entry;

const wrapZipFailure = (
  cause: unknown,
  signal: AbortSignal | undefined,
  compressionMethod?: number,
): never => {
  // zip.js rejects with the caller's abort reason; keep it as cancellation
  // rather than reporting the package as damaged.
  if (signal?.aborted === true && Object.is(cause, signal.reason))
    throw new ArtifactReaderFailure("cancelled", "Artifact read cancelled", {
      cause: signal.reason,
    });
  if (
    cause instanceof ArtifactReaderFailure ||
    cause instanceof ParseFailureError
  )
    throw cause;
  // The shared ZIP reader owns ZIP failure classification, including native
  // decoder faults: a Zstandard window above its fixed allowance is a
  // resource limit, and a feature it cannot provide (encryption, split
  // archives, a Zstandard dictionary) is an unsupported layout. Project its
  // typed result instead of re-reading the error text here.
  const typed = typedZipFailure(cause, compressionMethod);
  if (typed instanceof ArtifactReaderFailure && typed.reason === "limit")
    throw typed;
  if (typed instanceof ArtifactReaderFailure && typed.reason === "unavailable")
    throw unsupportedInput(
      NUGET_NUPKG_FORMAT,
      `NuGet package ZIP uses an unsupported layout: ${typed.message}`,
      { cause: typed },
    );
  if (typed instanceof ArtifactReaderFailure && typed.reason === "format")
    throw malformedInput(NUGET_NUPKG_FORMAT, typed.message, { cause: typed });
  throw cause;
};

/** Refuse expansion past the metadata budget before buffering more output. */
class BoundedUint8ArrayWriter extends Uint8ArrayWriter {
  readonly #budget: Budget;

  constructor(
    maximum: number,
    private readonly exceeded: (required: number) => Error,
  ) {
    super();
    this.#budget = new Budget(maximum);
  }

  override async init(size?: number): Promise<void> {
    if (size !== undefined && size > this.#budget.maximum)
      throw this.exceeded(size);
    await super.init?.(size);
  }

  override async writeUint8Array(array: Uint8Array): Promise<void> {
    this.#budget.charge(array.length, () =>
      this.exceeded(this.#budget.used + array.length),
    );
    await super.writeUint8Array(array);
  }
}

/** Read one metadata member under max_nuspec_bytes, declared and expanded. */
const readMemberBytes = async (
  entry: FileEntry,
  signal: AbortSignal | undefined,
  maximum: number,
  label: string,
): Promise<Uint8Array> => {
  const exceeded = (required: number) =>
    decodeLimit(
      NUGET_NUPKG_FORMAT,
      `${label} exceeds the ${String(maximum)}-byte budget.`,
      { name: "max_nuspec_bytes", maximum, required },
    );
  const declared = zipSize(entry.uncompressedSize);
  if (declared !== null && declared > maximum) throw exceeded(declared);
  try {
    return await entry.getData(new BoundedUint8ArrayWriter(maximum, exceeded), {
      checkSignature: true,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause: unknown) {
    return wrapZipFailure(cause, signal, entry.compressionMethod);
  }
};

/**
 * Resolve a package-level relationship Target against the package root:
 * `.` segments drop, `..` pops, and escaping above the root is undefined.
 */
const resolvePackageTarget = (target: string): string | undefined => {
  const segments: string[] = [];
  for (const segment of target.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.pop() === undefined) return undefined;
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? undefined : segments.join("/");
};

interface OpcManifestTarget {
  readonly lookup: string;
  readonly display: string | null;
}

const targetLabel = (display: string | null): string =>
  display === null ? "[URL withheld]" : JSON.stringify(display);

const NUGET_MANIFEST_RELATIONSHIP =
  "http://schemas.microsoft.com/packaging/2010/07/manifest";

const opcManifestTargets = (
  xml: string,
  limitations: string[],
): OpcManifestTarget[] => {
  const parsed = parseXmlDocument(xml, {
    doctype: "reject",
    lineEndings: "preserve",
  });
  if (!parsed.ok) {
    limitations.push(
      parsed.error.kind === "unsupported"
        ? "OPC relationships declare a document type, which is unsupported; the .nuspec was selected by ZIP name when possible."
        : "OPC relationships are not well-formed XML; the .nuspec was selected by ZIP name when possible.",
    );
    return [];
  }
  const root = parsed.value.documentElement;
  if (!isElement(root) || root.localName !== "Relationships") {
    limitations.push(
      "OPC relationships root is not Relationships; the .nuspec was selected by ZIP name when possible.",
    );
    return [];
  }
  const targets = new Map<string, OpcManifestTarget>();
  for (const relationship of childrenNamed(root, "Relationship")) {
    const type = attribute(relationship, "Type");
    if (type !== NUGET_MANIFEST_RELATIONSHIP) continue;
    const target = attribute(relationship, "Target");
    if (target === null) continue;
    const displayedTarget = redactRecordedTransportUrl(target).url;
    // OPC external targets may be relative, so the mode decides, not the URI shape.
    if (attribute(relationship, "TargetMode")?.toLowerCase() === "external") {
      limitations.push(
        `OPC manifest relationship Target ${targetLabel(displayedTarget)} is external and was not followed.`,
      );
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith("//")) {
      limitations.push(
        `OPC manifest relationship Target ${targetLabel(displayedTarget)} has a URI scheme or authority and was not followed.`,
      );
      continue;
    }
    const logical = resolvePackageTarget(target);
    if (logical === undefined) {
      limitations.push(
        `OPC manifest relationship Target ${targetLabel(displayedTarget)} leaves the package and was not followed.`,
      );
      continue;
    }
    if (!targets.has(logical))
      targets.set(logical, { lookup: logical, display: displayedTarget });
  }
  return [...targets.values()];
};

const parseBooleanAttribute = (value: string | null): boolean | null => {
  if (value === null) return null;
  const folded = value.toLowerCase();
  if (folded === "true") return true;
  if (folded === "false") return false;
  return null;
};

const parseDependencies = (
  metadata: Element,
): NugetNupkg["dependency_groups"] => {
  const container = firstNamed(metadata, "dependencies");
  if (container === undefined) return [];
  const groups = childrenNamed(container, "group");
  const ungrouped = childrenNamed(container, "dependency");
  const readDependency = (
    element: Element,
  ): NugetNupkg["dependency_groups"][number]["dependencies"][number] => ({
    id: attribute(element, "id"),
    version: attribute(element, "version"),
    include: attribute(element, "include"),
    exclude: attribute(element, "exclude"),
    development_dependency: parseBooleanAttribute(
      attribute(element, "developmentDependency"),
    ),
  });
  const fromGroup = (
    element: Element,
  ): NugetNupkg["dependency_groups"][number] => ({
    target_framework: attribute(element, "targetFramework"),
    dependencies: childrenNamed(element, "dependency").map(readDependency),
  });
  if (groups.length > 0)
    return [
      ...groups.map(fromGroup),
      ...(ungrouped.length === 0
        ? []
        : [
            {
              target_framework: null,
              dependencies: ungrouped.map(readDependency),
            },
          ]),
    ];
  if (ungrouped.length === 0) return [];
  return [
    { target_framework: null, dependencies: ungrouped.map(readDependency) },
  ];
};

const parseNuspecDocument = (
  xml: string,
  limitations: string[],
): Pick<
  NugetNupkg,
  "identity" | "license" | "repository" | "dependency_groups"
> => {
  const empty: Pick<
    NugetNupkg,
    "identity" | "license" | "repository" | "dependency_groups"
  > = {
    identity: null,
    license: null,
    repository: null,
    dependency_groups: [],
  };
  const parsed = parseXmlDocument(xml, {
    doctype: "reject",
    lineEndings: "preserve",
  });
  if (!parsed.ok) {
    limitations.push(
      parsed.error.kind === "unsupported"
        ? "The selected .nuspec declares a document type, which is unsupported."
        : NUPKG_LIMITATIONS.malformedNuspec,
    );
    return empty;
  }
  const root = parsed.value.documentElement;
  if (!isElement(root) || root.localName !== "package") {
    limitations.push("The selected .nuspec root element is not package.");
    return empty;
  }
  const metadata = firstNamed(root, "metadata");
  if (metadata === undefined) {
    limitations.push("The selected .nuspec has no metadata element.");
    return empty;
  }
  const metadataText = (local: string): string | null => {
    const element = firstNamed(metadata, local);
    return element === undefined ? null : elementText(element);
  };
  const licenseElement = firstNamed(metadata, "license");
  const licenseType = licenseElement ? attribute(licenseElement, "type") : null;
  const repositoryElement = firstNamed(metadata, "repository");
  return {
    identity: {
      id: metadataText("id"),
      version: metadataText("version"),
      authors: metadataText("authors"),
      description: metadataText("description"),
    },
    license:
      licenseElement === undefined
        ? null
        : {
            type:
              licenseType === "expression" || licenseType === "file"
                ? licenseType
                : null,
            value: elementText(licenseElement),
          },
    repository:
      repositoryElement === undefined
        ? null
        : {
            type: attribute(repositoryElement, "type"),
            ...redactRecordedTransportUrl(attribute(repositoryElement, "url")),
            commit: attribute(repositoryElement, "commit"),
            branch: attribute(repositoryElement, "branch"),
          },
    dependency_groups: parseDependencies(metadata),
  };
};

/**
 * Collect the distinct members the manifest targets resolve to, stopping at
 * the second. Many package-controlled targets can each hit one large
 * case-folded bucket, so the matches are never materialized together.
 */
export const distinctTargetMatches = <T>(
  targets: readonly string[],
  match: (target: string) => readonly T[],
): T[] => {
  const found = new Set<T>();
  for (const target of targets)
    for (const member of match(target)) {
      found.add(member);
      if (found.size > 1) return [...found];
    }
  return [...found];
};

const findNuspec = (
  files: readonly { readonly entry: FileEntry; readonly name: string }[],
  relsXml: string | undefined,
  limitations: string[],
): {
  readonly member:
    | { readonly entry: FileEntry; readonly name: string }
    | undefined;
  readonly source: "opc-relationship" | "root-nuspec" | undefined;
} => {
  // Every ZIP occurrence stays distinct: duplicate or case-variant names must
  // surface as ambiguity rather than collapse to an archive-order winner.
  // Index once: every target is then a constant-time lookup, however many
  // relationships the package declares.
  const exactNames = new Map<string, (typeof files)[number][]>();
  const foldedNames = new Map<string, (typeof files)[number][]>();
  for (const file of files) {
    const exact = exactNames.get(file.name);
    if (exact === undefined) exactNames.set(file.name, [file]);
    else exact.push(file);
    const lower = file.name.toLowerCase();
    const folded = foldedNames.get(lower);
    if (folded === undefined) foldedNames.set(lower, [file]);
    else folded.push(file);
  }
  const matchTarget = (target: string) =>
    exactNames.get(target) ?? foldedNames.get(target.toLowerCase()) ?? [];
  if (relsXml !== undefined) {
    const targets = opcManifestTargets(relsXml, limitations);
    const resolved = distinctTargetMatches(
      targets.map((target) => target.lookup),
      matchTarget,
    );
    if (resolved.length > 1) {
      limitations.push(
        "OPC manifest relationships resolve to more than one .nuspec ZIP member; identity was not decoded.",
      );
      return { member: undefined, source: undefined };
    }
    if (resolved.length === 1) {
      const member = resolved[0]!;
      if (!targets.some((target) => target.lookup === member.name))
        limitations.push(
          "The OPC manifest relationship matched a .nuspec member by case-insensitive ZIP name.",
        );
      return { member, source: "opc-relationship" };
    }
    if (targets.length === 1)
      limitations.push(
        `OPC manifest relationship Target ${targetLabel(targets[0]!.display)} is missing from the package; identity was not decoded from that path.`,
      );
  }
  const rootNuspecs = files.filter(
    (file) =>
      !file.name.includes("/") && file.name.toLowerCase().endsWith(".nuspec"),
  );
  if (rootNuspecs.length > 1) {
    limitations.push(NUPKG_LIMITATIONS.ambiguousRootNuspec);
    return { member: undefined, source: undefined };
  }
  if (rootNuspecs.length === 1)
    return { member: rootNuspecs[0], source: "root-nuspec" };
  limitations.push(NUPKG_LIMITATIONS.noNuspec);
  return { member: undefined, source: undefined };
};

/** Decode one bounded NuGet .nupkg without restore, execution, or network. */
export const parseNugetNupkg = async (
  bytes: Uint8Array,
  artifact: { path: string; sha256: string; bytes: number },
  input: InspectNugetNupkgInput,
  signal?: AbortSignal,
): Promise<NugetNupkg> => {
  if (bytes.length !== artifact.bytes)
    throw malformedInput(
      NUGET_NUPKG_FORMAT,
      "Selected artifact length disagrees with the retained bytes.",
    );
  if (!hasZipSignature(bytes))
    throw malformedInput(
      NUGET_NUPKG_FORMAT,
      "Selected file is not a ZIP archive (NuGet .nupkg).",
    );
  const reader = new ZipReader(new Uint8ArrayReader(bytes), ZIP_READER_OPTIONS);
  const limitations: string[] = [...BASE_LIMITATIONS];
  try {
    // Count while enumerating so an oversized directory stops at the budget
    // instead of materializing and decoding every member first.
    const entries: Entry[] = [];
    try {
      for await (const entry of reader.getEntriesGenerator({
        decodeText: decodeZipEntryText,
        ...(signal === undefined ? {} : { signal }),
      })) {
        if (entries.length >= input.max_entries)
          throw decodeLimit(
            NUGET_NUPKG_FORMAT,
            `NuGet package ZIP exceeds the ${String(input.max_entries)}-entry budget.`,
            {
              name: "max_entries",
              maximum: input.max_entries,
              required: entries.length + 1,
            },
          );
        entries.push(entry);
      }
    } catch (cause: unknown) {
      return wrapZipFailure(cause, signal);
    }
    // The inventory comes from the central directory; local entries it omits
    // are only visible as bytes no listed record accounts for.
    const directoryOffset = reader.directoryOffset;
    const listing = zipListingCoverage(
      directoryOffset === undefined
        ? undefined
        : await accountZipMemberRegion(
            entries.map((entry) => ({
              offset: entry.offset,
              compressedSize: entry.compressedSize,
              uncompressedSize: entry.uncompressedSize,
              crc32: entry.crc32,
              zip64: entry.zip64,
              dataDescriptor: entry.bitFlag?.dataDescriptor ?? false,
            })),
            directoryOffset,
            (at, length) => Promise.resolve(bytes.subarray(at, at + length)),
          ),
    );
    limitations.push(...listing.limitations);
    const files: { entry: FileEntry; name: string }[] = [];
    const contents: NugetNupkg["contents"] = [];
    for (const entry of entries) {
      if (entry.directory) continue;
      if (!asFileEntry(entry)) continue;
      const sourceName = zipEntryPath(entry);
      const name = nugetNupkgLogicalPath(sourceName);
      if (name === "") continue;
      for (const limitation of zipEntryNameLimitations(entry))
        limitations.push(
          `ZIP member ${JSON.stringify(sourceName)}: ${limitation}`,
        );
      files.push({ entry, name });
      contents.push({
        name: sourceName,
        path: name,
        uncompressed_size: zipSize(entry.uncompressedSize),
        compressed_size: zipSize(entry.compressedSize),
        role: nugetNupkgEntryRole(name),
        encrypted: entry.encrypted === true,
      });
    }
    const relsMembers = files.filter(
      (file) => file.name.toLowerCase() === "_rels/.rels",
    );
    // Spellings such as "./_rels/.rels" normalize to the same logical path; with
    // more than one, ZIP order would choose the manifest, so follow none.
    if (relsMembers.length > 1)
      limitations.push(
        "More than one ZIP member is the OPC relationships part; relationships were not followed and the .nuspec was selected by ZIP name when possible.",
      );
    const rels = relsMembers.length === 1 ? relsMembers[0] : undefined;
    let relsXml: string | undefined;
    if (rels !== undefined) {
      if (rels.entry.encrypted)
        limitations.push(
          "OPC relationships member is encrypted and was not extracted.",
        );
      else {
        const relsBytes = await readMemberBytes(
          rels.entry,
          signal,
          input.max_nuspec_bytes,
          "OPC relationships member",
        );
        try {
          relsXml = decodeXmlPlistText(relsBytes);
        } catch {
          limitations.push(
            "OPC relationships member is not valid UTF-8 or BOM-marked UTF-16 XML text; the .nuspec was selected by ZIP name when possible.",
          );
        }
      }
    }
    const selected = findNuspec(files, relsXml, limitations);
    if (selected.member === undefined || selected.source === undefined)
      return {
        artifact: {
          path: artifact.path,
          sha256: artifact.sha256,
          bytes: artifact.bytes,
        },
        identity: null,
        license: null,
        repository: null,
        dependency_groups: [],
        contents,
        nuspec: null,
        coverage: {
          status: listing.status,
          entries: contents.length,
          examined_nuspec_bytes: 0,
        },
        limitations,
      };
    if (selected.member.entry.encrypted) {
      limitations.push(
        `Selected .nuspec ${JSON.stringify(selected.member.name)} is encrypted and was not extracted.`,
      );
      return {
        artifact: {
          path: artifact.path,
          sha256: artifact.sha256,
          bytes: artifact.bytes,
        },
        identity: null,
        license: null,
        repository: null,
        dependency_groups: [],
        contents,
        nuspec: {
          path: selected.member.name,
          // Nothing was decoded; the declared size remains in contents.
          bytes: null,
          source: selected.source,
        },
        coverage: {
          status: listing.status,
          entries: contents.length,
          examined_nuspec_bytes: 0,
        },
        limitations,
      };
    }
    const nuspecBytes = await readMemberBytes(
      selected.member.entry,
      signal,
      input.max_nuspec_bytes,
      "Selected .nuspec",
    );
    let xml: string;
    try {
      xml = decodeXmlPlistText(nuspecBytes);
    } catch {
      limitations.push(
        "The selected .nuspec is not valid UTF-8 or BOM-marked UTF-16 XML text.",
      );
      return {
        artifact: {
          path: artifact.path,
          sha256: artifact.sha256,
          bytes: artifact.bytes,
        },
        identity: null,
        license: null,
        repository: null,
        dependency_groups: [],
        contents,
        nuspec: {
          path: selected.member.name,
          bytes: nuspecBytes.length,
          source: selected.source,
        },
        coverage: {
          status: listing.status,
          entries: contents.length,
          examined_nuspec_bytes: nuspecBytes.length,
        },
        limitations,
      };
    }
    const decoded = parseNuspecDocument(xml, limitations);
    if (
      decoded.identity !== null &&
      decoded.identity.id === null &&
      decoded.identity.version === null &&
      decoded.identity.authors === null &&
      decoded.identity.description === null
    )
      limitations.push(
        "The selected .nuspec metadata did not include id, version, authors, or description.",
      );
    return {
      artifact: {
        path: artifact.path,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
      },
      ...decoded,
      contents,
      nuspec: {
        path: selected.member.name,
        bytes: nuspecBytes.length,
        source: selected.source,
      },
      coverage: {
        status: listing.status,
        entries: contents.length,
        examined_nuspec_bytes: nuspecBytes.length,
      },
      limitations,
    };
  } finally {
    await reader.close().catch(() => undefined);
  }
};
