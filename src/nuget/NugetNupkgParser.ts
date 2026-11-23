import { accountZipMemberRegion } from "../domain/zip/zipMemberRegion.js";
import {
  decodeLimit,
  malformedInput,
  ParseFailureError,
  unsupportedInput,
} from "../domain/parseFailure.js";
import {
  Reader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  type Entry,
  type FileEntry,
} from "@zip.js/zip.js";
import type { Element, Node } from "@xmldom/xmldom";

import {
  assertArtifactReadActive,
  ArtifactReaderFailure,
  decodeZipEntryText,
  zipEntryNameLimitations,
  typedZipFailure,
  ZIP_READER_OPTIONS,
  zipEntryPath,
  zipListingCoverage,
} from "../resources/index.js";
import {
  isXmlElement,
  parseXmlDocument,
  xmlChildElements,
  xmlChildrenNamed,
  xmlFirstChildNamed,
} from "../domain/xmlDocument.js";
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
  ungroupedBesideGroups: (count: number): string =>
    `${String(count)} ungrouped <dependency> element(s) beside <group> elements were omitted: NuGet's restore-time NuspecReader reads only the groups when any group is present, and nuget pack refuses this mix.`,
} as const;

const BASE_LIMITATIONS = [
  "This workflow reads the .nupkg ZIP and .nuspec metadata without restoring, executing, or contacting a NuGet feed.",
  NUPKG_LIMITATIONS.memberRoles,
  "Dependency version ranges are recorded as spelled in the .nuspec; restore results are unknown.",
  "Directory ZIP markers are omitted from contents; only file members are listed.",
] as const;

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

/** NuGet indexes nonempty leaf metadata by local name and keeps its first value. */
const indexedMetadataText = (
  metadata: Element,
  name: string,
): string | null => {
  for (const child of xmlChildElements(metadata)) {
    if (
      child.localName?.toLowerCase() !== name ||
      xmlChildElements(child).length > 0
    )
      continue;
    const text = child.textContent ?? "";
    if (!text) continue;
    // XDocument ignores ordinary XML whitespace. CDATA and xml:space can
    // retain a whitespace-only value that occupies this key in NuGet's index.
    if (/[^\t\r\n ]/u.test(text)) return nonempty(text);
    if (
      Array.from(child.childNodes).some(
        (node) => node.nodeType === 4 && node.nodeValue,
      )
    )
      return null;
    for (
      let scope: Node | null = child;
      isXmlElement(scope);
      scope = scope.parentNode
    ) {
      const space = scope.getAttribute("xml:space");
      if (space === "preserve") return null;
      if (space === "default") break;
    }
  }
  return null;
};

const asFileEntry = (entry: Entry): entry is FileEntry =>
  !entry.directory && "getData" in entry;

const wrapZipFailure = (cause: unknown, compressionMethod?: number): never => {
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
    return wrapZipFailure(cause, entry.compressionMethod);
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

const OPC_RELATIONSHIP_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";

const NUGET_MANIFEST_RELATIONSHIP =
  "http://schemas.microsoft.com/packaging/2010/07/manifest";

const opcManifestTargets = (
  xml: string,
  limitations: string[],
): OpcManifestTarget[] => {
  const parsed = parseXmlDocument(xml, {
    doctype: "reject",
    lineEndings: "normalize",
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
  if (
    !isXmlElement(root) ||
    root.localName !== "Relationships" ||
    root.namespaceURI !== OPC_RELATIONSHIP_NAMESPACE
  ) {
    limitations.push(
      "OPC relationships root is not Relationships in the OPC namespace; the .nuspec was selected by ZIP name when possible.",
    );
    return [];
  }
  const targets = new Map<string, OpcManifestTarget>();
  for (const relationship of xmlChildrenNamed(root, "Relationship")) {
    if (relationship.namespaceURI !== OPC_RELATIONSHIP_NAMESPACE) continue;
    const type = attribute(relationship, "Type");
    if (type !== NUGET_MANIFEST_RELATIONSHIP) continue;
    const target = attribute(relationship, "Target");
    if (target === null) continue;
    const displayedTarget = redactRecordedTransportUrl(target).url;
    // Only an absent mode defaults to Internal. External targets can be relative.
    const mode = relationship.getAttributeNS(null, "TargetMode");
    if (mode === "External") {
      limitations.push(
        `OPC manifest relationship Target ${targetLabel(displayedTarget)} is external and was not followed.`,
      );
      continue;
    }
    if (mode !== null && mode !== "Internal") {
      limitations.push(
        `OPC manifest relationship Target ${targetLabel(displayedTarget)} has an invalid TargetMode and was not followed.`,
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
  namespace: string,
  limitations: string[],
): NugetNupkg["dependency_groups"] => {
  // NuspecReader walks every <dependencies> element, with one decision about
  // groups across all of them.
  const containers = xmlChildrenNamed(metadata, "dependencies", namespace);
  const groups = containers.flatMap((container) =>
    xmlChildrenNamed(container, "group", namespace),
  );
  const ungrouped = containers.flatMap((container) =>
    xmlChildrenNamed(container, "dependency", namespace),
  );
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
    dependencies: xmlChildrenNamed(element, "dependency", namespace).map(
      readDependency,
    ),
  });
  // NuGet's NuspecReader reads ungrouped dependencies only when no group is
  // present, so those beside groups never reach restore.
  if (groups.length > 0) {
    if (ungrouped.length > 0)
      limitations.push(
        NUPKG_LIMITATIONS.ungroupedBesideGroups(ungrouped.length),
      );
    return groups.map(fromGroup);
  }
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
  // NuGet reads the .nuspec with XDocument, which applies XML 1.0 end-of-line
  // handling, so a description packed with CRLF reads with LF line breaks.
  const parsed = parseXmlDocument(xml, {
    doctype: "reject",
    lineEndings: "normalize",
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
  if (!isXmlElement(root) || root.localName !== "package") {
    limitations.push("The selected .nuspec root element is not package.");
    return empty;
  }
  const metadata = xmlFirstChildNamed(root, "metadata");
  if (metadata === undefined) {
    limitations.push("The selected .nuspec has no metadata element.");
    return empty;
  }
  // NuGet's typed getters select children in the default namespace in scope.
  // Authors and description come from its local-name metadata index.
  const metadataNamespace = metadata.lookupNamespaceURI("") ?? "";
  const metadataText = (local: string): string | null => {
    const element = xmlFirstChildNamed(metadata, local, metadataNamespace);
    return element === undefined ? null : elementText(element);
  };
  const licenseElement = xmlFirstChildNamed(
    metadata,
    "license",
    metadataNamespace,
  );
  const licenseType = licenseElement
    ? attribute(licenseElement, "type")?.toLowerCase()
    : undefined;
  const repositoryElement = xmlFirstChildNamed(
    metadata,
    "repository",
    metadataNamespace,
  );
  return {
    identity: {
      id: metadataText("id"),
      version: metadataText("version"),
      authors: indexedMetadataText(metadata, "authors"),
      description: indexedMetadataText(metadata, "description"),
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
    dependency_groups: parseDependencies(
      metadata,
      metadataNamespace,
      limitations,
    ),
  };
};

/** OPC part-name equivalence folds ASCII case only. */
const opcPartNameKey = (name: string): string =>
  name.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());

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
  if (relsXml !== undefined) {
    const targets = opcManifestTargets(relsXml, limitations);
    const targetKeys = new Set(
      targets.map(({ lookup }) => opcPartNameKey(lookup)),
    );
    let member: (typeof files)[number] | undefined;
    if (targetKeys.size > 0) {
      // Visit each physical occurrence once. Aliases of one part agree, but
      // even an exact target cannot choose between two equivalent members.
      for (const file of files) {
        if (!targetKeys.has(opcPartNameKey(file.name))) continue;
        if (member !== undefined) {
          limitations.push(
            "OPC manifest relationships resolve to more than one .nuspec ZIP member; identity was not decoded.",
          );
          return { member: undefined, source: undefined };
        }
        member = file;
      }
    }
    if (member !== undefined) {
      const name = member.name;
      if (!targets.some((target) => target.lookup === name))
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

/** Random-access source over one verified .nupkg descriptor. */
export interface NugetNupkgRandomAccessSource {
  readonly prefix: Uint8Array;
  readonly size: number;
  readonly readRange: (offset: number, length: number) => Promise<Uint8Array>;
}

class RandomAccessZipReader extends Reader<undefined> {
  readonly #source: NugetNupkgRandomAccessSource;
  readonly #path: string;

  constructor(source: NugetNupkgRandomAccessSource, path: string) {
    super(undefined);
    this.#source = source;
    this.#path = path;
    this.size = source.size;
  }

  override async readUint8Array(
    index: number,
    length: number,
  ): Promise<Uint8Array> {
    const readBytes = Math.min(length, this.size - index);
    if (readBytes < 0)
      throw new ArtifactReaderFailure(
        "format",
        `ZIP archive is malformed: read at ${String(index)} extends beyond the ${String(this.size)}-byte archive`,
      );
    const bytes = await this.#source.readRange(index, readBytes);
    if (bytes.length !== readBytes)
      throw new ArtifactReaderFailure(
        "integrity",
        `ZIP source ended before its admitted extent: ${this.#path}`,
        { integrityCheck: "read-coverage" },
      );
    return bytes;
  }
}

/** Decode one bounded NuGet .nupkg without restore, execution, or network. */
export const parseNugetNupkg = async (
  source: Uint8Array | NugetNupkgRandomAccessSource,
  artifact: { path: string; sha256: string; bytes: number },
  input: InspectNugetNupkgInput,
  signal?: AbortSignal,
): Promise<NugetNupkg> => {
  const isBuffer = source instanceof Uint8Array;
  const sourceLength = isBuffer ? source.length : source.size;
  if (sourceLength !== artifact.bytes)
    throw malformedInput(
      NUGET_NUPKG_FORMAT,
      "Selected artifact length disagrees with the retained bytes.",
    );
  const signatureBytes = isBuffer ? source : source.prefix;
  if (!hasZipSignature(signatureBytes))
    throw malformedInput(
      NUGET_NUPKG_FORMAT,
      "Selected file is not a ZIP archive (NuGet .nupkg).",
    );
  const reader = new ZipReader(
    isBuffer
      ? new Uint8ArrayReader(source)
      : new RandomAccessZipReader(source, artifact.path),
    ZIP_READER_OPTIONS,
  );
  const readLocalRange: (at: number, length: number) => Promise<Uint8Array> =
    isBuffer
      ? (at, length) => Promise.resolve(source.subarray(at, at + length))
      : (at, length) => source.readRange(at, length);
  const limitations: string[] = [...BASE_LIMITATIONS];
  const zipAbort = signal === undefined ? undefined : new AbortController();
  const zipSignal = zipAbort?.signal;
  // zip.js throws its signal's reason. Give it an owned cancellation record
  // so an independent ZIP failure cannot be confused with the caller's reason.
  const onAbort = () =>
    zipAbort?.abort(
      new ArtifactReaderFailure("cancelled", "Artifact read cancelled", {
        cause: signal?.reason,
      }),
    );
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    assertArtifactReadActive(signal);
    // Count while enumerating so an oversized directory stops at the budget
    // instead of materializing and decoding every member first.
    const entries: Entry[] = [];
    try {
      for await (const entry of reader.getEntriesGenerator({
        decodeText: decodeZipEntryText,
      })) {
        // zip.js observes cancellation for member reads, but not for directory enumeration.
        assertArtifactReadActive(signal);
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
      return wrapZipFailure(cause);
    }
    assertArtifactReadActive(signal);
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
            readLocalRange,
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
      (file) => opcPartNameKey(file.name) === "_rels/.rels",
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
          zipSignal,
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
      zipSignal,
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
    signal?.removeEventListener("abort", onAbort);
    await reader.close().catch(() => undefined);
  }
};
