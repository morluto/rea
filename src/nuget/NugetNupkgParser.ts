import {
  ERR_AMBIGUOUS_ARCHIVE,
  ERR_BAD_FORMAT,
  ERR_CENTRAL_DIRECTORY_NOT_FOUND,
  ERR_ENCRYPTED_CENTRAL_DIRECTORY,
  ERR_ENTRY_DATA_OUT_OF_BOUNDS,
  ERR_EOCDR_LOCATOR_ZIP64_NOT_FOUND,
  ERR_EOCDR_NOT_FOUND,
  ERR_EXTRAFIELD_ZIP64_NOT_FOUND,
  ERR_INVALID_COMPRESSED_DATA,
  ERR_INVALID_CRC32,
  ERR_INVALID_UNCOMPRESSED_SIZE,
  ERR_LOCAL_FILE_HEADER_NOT_FOUND,
  ERR_OVERLAPPING_ENTRY,
  ERR_SPLIT_ZIP_FILE,
  ERR_UNSUPPORTED_COMPRESSION,
  ERR_UNSUPPORTED_ENCRYPTION,
  ERR_UNSUPPORTED_UINT64,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  type Entry,
  type FileEntry,
} from "@zip.js/zip.js";
import type { Element, Node } from "@xmldom/xmldom";

import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  decodeZipEntryText,
  ZIP_READER_OPTIONS,
  zipEntryPath,
} from "../artifacts/ZipArtifactReader.js";
import { parseXmlDocument } from "../domain/xmlDocument.js";
import { hasZipSignature } from "../domain/zipPackageFormat.js";
import {
  nugetNupkgEntryRole,
  nugetNupkgLogicalPath,
  type InspectNugetNupkgInput,
  type NugetNupkg,
} from "../domain/nuget/nupkg.js";
import {
  NugetNupkgCapacityFailure,
  NugetNupkgFormatFailure,
} from "./NugetNupkg.errors.js";

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const ZIP_FORMAT_MESSAGES = new Set([
  ERR_AMBIGUOUS_ARCHIVE,
  ERR_BAD_FORMAT,
  ERR_CENTRAL_DIRECTORY_NOT_FOUND,
  ERR_ENTRY_DATA_OUT_OF_BOUNDS,
  ERR_EOCDR_LOCATOR_ZIP64_NOT_FOUND,
  ERR_EOCDR_NOT_FOUND,
  ERR_EXTRAFIELD_ZIP64_NOT_FOUND,
  ERR_INVALID_COMPRESSED_DATA,
  ERR_INVALID_CRC32,
  ERR_INVALID_UNCOMPRESSED_SIZE,
  ERR_LOCAL_FILE_HEADER_NOT_FOUND,
  ERR_OVERLAPPING_ENTRY,
  ERR_UNSUPPORTED_UINT64,
]);

const ZIP_UNSUPPORTED_MESSAGES = new Set([
  ERR_ENCRYPTED_CENTRAL_DIRECTORY,
  ERR_SPLIT_ZIP_FILE,
  ERR_UNSUPPORTED_COMPRESSION,
  ERR_UNSUPPORTED_ENCRYPTION,
]);

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
    if (child.nodeType === 3) parts.push(child.nodeValue ?? "");
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
): never => {
  // zip.js rejects with the caller's abort reason; keep it as cancellation
  // rather than reporting the package as damaged.
  if (signal?.aborted === true && Object.is(cause, signal.reason))
    throw new ArtifactReaderFailure("cancelled", "Artifact read cancelled", {
      cause: signal.reason,
    });
  if (
    cause instanceof ArtifactReaderFailure ||
    cause instanceof NugetNupkgFormatFailure ||
    cause instanceof NugetNupkgCapacityFailure
  )
    throw cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  if (ZIP_UNSUPPORTED_MESSAGES.has(message))
    throw new NugetNupkgFormatFailure(
      "unsupported",
      `NuGet package ZIP uses an unsupported layout: ${message}`,
    );
  if (ZIP_FORMAT_MESSAGES.has(message) || cause instanceof Error)
    throw new NugetNupkgFormatFailure(
      "malformed",
      `NuGet package ZIP is malformed: ${message}`,
    );
  throw new NugetNupkgFormatFailure(
    "malformed",
    "NuGet package ZIP could not be read.",
  );
};

const readMemberBytes = async (
  entry: FileEntry,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> => {
  try {
    return await entry.getData(new Uint8ArrayWriter(), {
      checkSignature: true,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause: unknown) {
    return wrapZipFailure(cause, signal);
  }
};

const opcManifestTargets = (xml: string, limitations: string[]): string[] => {
  const parsed = parseXmlDocument(xml, {
    doctype: "reject",
    lineEndings: "preserve",
  });
  if (!parsed.ok) {
    limitations.push(
      parsed.error.reason === "doctype"
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
  const targets: string[] = [];
  for (const relationship of childrenNamed(root, "Relationship")) {
    const type = attribute(relationship, "Type");
    if (type === null || !type.toLowerCase().endsWith("/manifest")) continue;
    const target = attribute(relationship, "Target");
    if (target === null) continue;
    if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) {
      limitations.push(
        `OPC manifest relationship Target ${JSON.stringify(target)} is an absolute URI and was not followed.`,
      );
      continue;
    }
    const logical = nugetNupkgLogicalPath(target.replace(/^\//u, ""));
    if (logical.split("/").includes("..")) {
      limitations.push(
        `OPC manifest relationship Target ${JSON.stringify(target)} leaves the package and was not followed.`,
      );
      continue;
    }
    targets.push(logical);
  }
  return [...new Set(targets)];
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
      parsed.error.reason === "doctype"
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
            url: attribute(repositoryElement, "url"),
            commit: attribute(repositoryElement, "commit"),
            branch: attribute(repositoryElement, "branch"),
          },
    dependency_groups: parseDependencies(metadata),
  };
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
  const byName = new Map(files.map((file) => [file.name.toLowerCase(), file]));
  const matchTarget = (target: string) =>
    files.find((file) => file.name === target) ??
    byName.get(target.toLowerCase());
  if (relsXml !== undefined) {
    const targets = opcManifestTargets(relsXml, limitations);
    const resolved = targets.flatMap((target) => {
      const member = matchTarget(target);
      return member === undefined ? [] : [member];
    });
    const unique = [
      ...new Map(resolved.map((member) => [member.name.toLowerCase(), member])),
    ].map(([, member]) => member);
    if (targets.length > 1 && unique.length > 1) {
      limitations.push(
        "Multiple OPC manifest relationships name different .nuspec members; identity was not decoded.",
      );
      return { member: undefined, source: undefined };
    }
    if (unique.length === 1) {
      const member = unique[0]!;
      if (member.name.toLowerCase() !== targets[0]?.toLowerCase())
        limitations.push(
          "The OPC manifest relationship matched a .nuspec member by case-insensitive ZIP name.",
        );
      return { member, source: "opc-relationship" };
    }
    if (targets.length === 1)
      limitations.push(
        `OPC manifest relationship Target ${JSON.stringify(targets[0])} is missing from the package; identity was not decoded from that path.`,
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
    throw new NugetNupkgFormatFailure(
      "malformed",
      "Selected artifact length disagrees with the retained bytes.",
    );
  if (!hasZipSignature(bytes))
    throw new NugetNupkgFormatFailure(
      "malformed",
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
          throw new NugetNupkgCapacityFailure(
            "max_entries",
            input.max_entries,
            `NuGet package ZIP exceeds the ${String(input.max_entries)}-entry budget.`,
          );
        entries.push(entry);
      }
    } catch (cause: unknown) {
      return wrapZipFailure(cause, signal);
    }
    const files: { entry: FileEntry; name: string }[] = [];
    const contents: NugetNupkg["contents"] = [];
    for (const entry of entries) {
      if (entry.directory) continue;
      if (!asFileEntry(entry)) continue;
      const name = nugetNupkgLogicalPath(zipEntryPath(entry));
      if (name === "") continue;
      files.push({ entry, name });
      contents.push({
        name,
        uncompressed_size: zipSize(entry.uncompressedSize),
        compressed_size: zipSize(entry.compressedSize),
        role: nugetNupkgEntryRole(name),
        encrypted: entry.encrypted === true,
      });
    }
    const rels = files.find(
      (file) => file.name.toLowerCase() === "_rels/.rels",
    );
    let relsXml: string | undefined;
    if (rels !== undefined) {
      if (rels.entry.encrypted)
        limitations.push(
          "OPC relationships member is encrypted and was not extracted.",
        );
      else {
        const relsBytes = await readMemberBytes(rels.entry, signal);
        try {
          relsXml = UTF8.decode(relsBytes);
        } catch {
          limitations.push(
            "OPC relationships member is not valid UTF-8; the .nuspec was selected by ZIP name when possible.",
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
          status: "complete",
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
          bytes: zipSize(selected.member.entry.uncompressedSize) ?? 0,
          source: selected.source,
        },
        coverage: {
          status: "complete",
          entries: contents.length,
          examined_nuspec_bytes: 0,
        },
        limitations,
      };
    }
    const declared = zipSize(selected.member.entry.uncompressedSize);
    if (declared !== null && declared > input.max_nuspec_bytes)
      throw new NugetNupkgCapacityFailure(
        "max_nuspec_bytes",
        input.max_nuspec_bytes,
        `Selected .nuspec exceeds the ${String(input.max_nuspec_bytes)}-byte budget.`,
      );
    const nuspecBytes = await readMemberBytes(selected.member.entry, signal);
    if (nuspecBytes.length > input.max_nuspec_bytes)
      throw new NugetNupkgCapacityFailure(
        "max_nuspec_bytes",
        input.max_nuspec_bytes,
        `Selected .nuspec exceeds the ${String(input.max_nuspec_bytes)}-byte budget.`,
      );
    let xml: string;
    try {
      xml = UTF8.decode(nuspecBytes);
    } catch {
      limitations.push("The selected .nuspec is not valid UTF-8.");
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
          status: "complete",
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
        status: "complete",
        entries: contents.length,
        examined_nuspec_bytes: nuspecBytes.length,
      },
      limitations,
    };
  } finally {
    await reader.close().catch(() => undefined);
  }
};
