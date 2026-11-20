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
import { countXmlNodes, parseXmlDocument } from "../domain/xmlDocument.js";
import { decodeXmlPlistText } from "../domain/propertyListXmlText.js";
import { hasZipSignature } from "../domain/zipPackageFormat.js";
import { sha256Hex } from "../kernel/sha256Hex.js";
import { Budget } from "../domain/budget.js";
import { artifactExpansionBudgetBytes } from "../domain/artifactExpansionBudget.js";
import { boundedList } from "../domain/boundedList.js";
import {
  MAX_INSPECT_VSIX_PACKAGE_MANIFEST_XML_NODES,
  VSIX_COMMANDS_CAP,
  VSIX_PACKAGE_FORMAT,
  isVsixInterestingMemberKind,
  vsixActivationIsEager,
  vsixMemberMagicKind,
  vsixPackageLogicalPath,
  vsixPackagePathKind,
  vsixPackagePathTraverses,
  type InspectVsixPackageInput,
  type VsixMemberKind,
  type VsixPackage,
} from "../domain/vsix/vsixPackage.js";

/** Limitation wording owned by the parser; tests assert delivery through these. */
export const VSIX_LIMITATIONS = {
  noExecution:
    "This workflow reads the .vsix ZIP, extension.vsixmanifest and extension/package.json without installing, executing, or contacting a marketplace.",
  signaturesUnverified:
    "Signature files are reported as present or absent; this workflow does not verify signatures.",
  memberKinds:
    "Member kinds are derived from ZIP names and, for hashed members, from leading magic bytes; they are not a runtime load inventory.",
  noVsixmanifest: "No extension.vsixmanifest was selected.",
  malformedVsixmanifest:
    "The selected extension.vsixmanifest is not well-formed XML.",
  noPackageJson: "No extension/package.json was selected.",
  malformedPackageJson:
    "The selected extension/package.json is not well-formed JSON.",
  emptyContributesKey:
    "extension/package.json contributes has an empty key; it is not listed in contributes.keys.",
  duplicatePath: (path: string): string =>
    `ZIP member ${JSON.stringify(path)} appears more than once; later copies were inventoried and not used as the unique manifest path.`,
  traverses: (name: string): string =>
    `ZIP member ${JSON.stringify(name)} leaves the package root and was not extracted.`,
  memberOversize: (path: string, maximum: number): string =>
    `Member ${JSON.stringify(path)} exceeds the ${String(maximum)}-byte hash budget and was listed without a digest.`,
  packageExpansionSpent: (path: string, maximum: number): string =>
    `Member ${JSON.stringify(path)} was listed without a digest because the package's ${String(maximum)}-byte total decode budget was spent.`,
} as const;

const BASE_LIMITATIONS = [
  VSIX_LIMITATIONS.noExecution,
  VSIX_LIMITATIONS.memberKinds,
  VSIX_LIMITATIONS.signaturesUnverified,
  "Directory ZIP markers are omitted from contents; only file members are listed.",
] as const;

const emptyKindCounts = (): VsixPackage["member_kind_counts"] => ({
  vsixmanifest: 0,
  package_json: 0,
  content_types: 0,
  opc: 0,
  signature: 0,
  javascript: 0,
  native_addon: 0,
  wasm: 0,
  executable: 0,
  shell_script: 0,
  nested_archive: 0,
  unknown: 0,
});

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
  if (signal?.aborted === true && Object.is(cause, signal.reason))
    throw new ArtifactReaderFailure("cancelled", "Artifact read cancelled", {
      cause: signal.reason,
    });
  if (
    cause instanceof ArtifactReaderFailure ||
    cause instanceof ParseFailureError
  )
    throw cause;
  const typed = typedZipFailure(cause, compressionMethod);
  if (typed instanceof ArtifactReaderFailure && typed.reason === "limit")
    throw typed;
  if (typed instanceof ArtifactReaderFailure && typed.reason === "unavailable")
    throw unsupportedInput(
      VSIX_PACKAGE_FORMAT,
      `VS Code extension ZIP uses an unsupported layout: ${typed.message}`,
      { cause: typed },
    );
  if (typed instanceof ArtifactReaderFailure && typed.reason === "format")
    throw malformedInput(VSIX_PACKAGE_FORMAT, typed.message, { cause: typed });
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

const readMemberBytes = async (
  entry: FileEntry,
  signal: AbortSignal | undefined,
  maximum: number,
  label: string,
  limitName: "max_manifest_bytes" | "max_member_bytes",
): Promise<Uint8Array> => {
  const exceeded = (required: number) =>
    decodeLimit(
      VSIX_PACKAGE_FORMAT,
      `${label} exceeds the ${String(maximum)}-byte budget.`,
      { name: limitName, maximum, required },
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

const splitCsv = (value: string | null): string[] => {
  if (value === null) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const part of value.split(",")) {
    const id = part.trim();
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
};

const asStringArray = (value: unknown): string[] => {
  if (typeof value === "string") return splitCsv(value);
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
};

const capabilityValue = (
  value: unknown,
): VsixPackage["capabilities"]["untrusted_workspaces"] => {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean")
    return { supported: value ? "true" : "false", description: null };
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : { supported: trimmed, description: null };
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const supported =
    typeof record.supported === "boolean"
      ? record.supported
        ? "true"
        : "false"
      : typeof record.supported === "string"
        ? nonempty(record.supported)
        : null;
  const description =
    typeof record.description === "string"
      ? nonempty(record.description)
      : null;
  if (supported === null && description === null) return null;
  return { supported, description };
};

const contributeCount = (value: unknown): number => {
  if (Array.isArray(value)) return value.length;
  if (value !== null && typeof value === "object")
    return Object.keys(value).length;
  return 1;
};

const packageJsonEntryPath = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return vsixPackageLogicalPath(
    `extension/${trimmed.replace(/^\.\//u, "").replace(/^\//u, "")}`,
  );
};

const sameIdSet = (
  left: readonly string[],
  right: readonly string[],
): boolean => {
  if (left.length !== right.length) return false;
  const other = new Set(right);
  return left.every((id) => other.has(id));
};

const unixExecutable = (entry: FileEntry): boolean => {
  const attributes =
    "externalFileAttribute" in entry
      ? Number(
          (entry as FileEntry & { readonly externalFileAttribute?: number })
            .externalFileAttribute,
        )
      : "externalFileAttributes" in entry
        ? Number(
            (entry as FileEntry & { readonly externalFileAttributes?: number })
              .externalFileAttributes,
          )
        : NaN;
  if (!Number.isSafeInteger(attributes) || attributes < 0) return false;
  const mode = (attributes >>> 16) & 0xffff;
  return (mode & 0o111) !== 0;
};

interface ParsedVsixManifest {
  readonly identity: VsixPackage["vsix_identity"];
  readonly engine: string | null;
  readonly extensionDependencies: string[];
  readonly extensionPack: string[];
  readonly extensionKind: string[];
  readonly assets: VsixPackage["assets"];
}

const parseVsixManifestDocument = (
  xml: string,
  limitations: string[],
  presentPaths: ReadonlySet<string>,
): ParsedVsixManifest => {
  const empty: ParsedVsixManifest = {
    identity: null,
    engine: null,
    extensionDependencies: [],
    extensionPack: [],
    extensionKind: [],
    assets: [],
  };
  const parsed = parseXmlDocument(xml, {
    doctype: "reject",
    lineEndings: "normalize",
  });
  if (!parsed.ok) {
    limitations.push(
      parsed.error.kind === "unsupported"
        ? "The selected extension.vsixmanifest declares a document type, which is unsupported."
        : VSIX_LIMITATIONS.malformedVsixmanifest,
    );
    return empty;
  }
  const root = parsed.value.documentElement;
  if (!isElement(root) || root.localName !== "PackageManifest") {
    limitations.push(
      "The selected extension.vsixmanifest root element is not PackageManifest.",
    );
    return empty;
  }
  const metadata = firstNamed(root, "Metadata");
  const identityElement =
    metadata === undefined ? undefined : firstNamed(metadata, "Identity");
  const properties =
    metadata === undefined ? undefined : firstNamed(metadata, "Properties");
  const propertyById = new Map<string, string>();
  if (properties !== undefined)
    for (const property of childrenNamed(properties, "Property")) {
      const id = attribute(property, "Id");
      const value = attribute(property, "Value");
      if (id !== null && value !== null && !propertyById.has(id))
        propertyById.set(id, value);
    }
  const assetsElement = firstNamed(root, "Assets");
  const assets: VsixPackage["assets"] =
    assetsElement === undefined
      ? []
      : childrenNamed(assetsElement, "Asset").map((asset) => {
          const path = attribute(asset, "Path");
          const logical = path === null ? null : vsixPackageLogicalPath(path);
          return {
            type: attribute(asset, "Type"),
            path,
            present:
              logical === null ? null : presentPaths.has(logical.toLowerCase()),
          };
        });
  const displayName =
    metadata === undefined ? null : firstNamed(metadata, "DisplayName");
  const description =
    metadata === undefined ? null : firstNamed(metadata, "Description");
  return {
    identity:
      identityElement === undefined
        ? null
        : {
            id: attribute(identityElement, "Id"),
            version: attribute(identityElement, "Version"),
            publisher: attribute(identityElement, "Publisher"),
            target_platform: attribute(identityElement, "TargetPlatform"),
            display_name: displayName == null ? null : elementText(displayName),
            description: description == null ? null : elementText(description),
          },
    engine: propertyById.get("Microsoft.VisualStudio.Code.Engine") ?? null,
    extensionDependencies: splitCsv(
      propertyById.get("Microsoft.VisualStudio.Code.ExtensionDependencies") ??
        null,
    ),
    extensionPack: splitCsv(
      propertyById.get("Microsoft.VisualStudio.Code.ExtensionPack") ?? null,
    ),
    extensionKind: splitCsv(
      propertyById.get("Microsoft.VisualStudio.Code.ExtensionKind") ?? null,
    ),
    assets,
  };
};

interface ParsedPackageJson {
  readonly identity: VsixPackage["package_identity"];
  readonly engine: string | null;
  readonly main: string | null;
  readonly browser: string | null;
  readonly activationEvents: string[];
  readonly contributes: VsixPackage["contributes"];
  readonly extensionDependencies: string[];
  readonly extensionPack: string[];
  readonly extensionKind: string[];
  readonly capabilities: VsixPackage["capabilities"];
  readonly enabledApiProposals: string[];
}

const parsePackageJsonDocument = (
  text: string,
  limitations: string[],
): ParsedPackageJson => {
  const empty: ParsedPackageJson = {
    identity: null,
    engine: null,
    main: null,
    browser: null,
    activationEvents: [],
    contributes: {
      keys: [],
      commands: [],
      commands_total: 0,
      commands_omitted: 0,
    },
    extensionDependencies: [],
    extensionPack: [],
    extensionKind: [],
    capabilities: {
      untrusted_workspaces: null,
      virtual_workspaces: null,
    },
    enabledApiProposals: [],
  };
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    limitations.push(VSIX_LIMITATIONS.malformedPackageJson);
    return empty;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    limitations.push(VSIX_LIMITATIONS.malformedPackageJson);
    return empty;
  }
  const record = value as Record<string, unknown>;
  const engines =
    record.engines !== null &&
    typeof record.engines === "object" &&
    !Array.isArray(record.engines)
      ? (record.engines as Record<string, unknown>)
      : undefined;
  const engine =
    engines !== undefined && typeof engines.vscode === "string"
      ? nonempty(engines.vscode)
      : null;
  const contributesRaw =
    record.contributes !== null &&
    typeof record.contributes === "object" &&
    !Array.isArray(record.contributes)
      ? (record.contributes as Record<string, unknown>)
      : undefined;
  const entries =
    contributesRaw === undefined ? [] : Object.entries(contributesRaw);
  // A contribution point is named by its key; an empty key names none.
  if (entries.some(([name]) => name.length === 0))
    limitations.push(VSIX_LIMITATIONS.emptyContributesKey);
  const keys = entries
    .filter(([name]) => name.length > 0)
    .map(([name, item]) => ({ name, count: contributeCount(item) }));
  const commandRows = Array.isArray(contributesRaw?.commands)
    ? contributesRaw.commands
    : [];
  const listedCommands = boundedList(commandRows, VSIX_COMMANDS_CAP);
  const commands = listedCommands.items.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item))
      return { command: null, title: null };
    const command = item as Record<string, unknown>;
    return {
      command:
        typeof command.command === "string" ? nonempty(command.command) : null,
      title: typeof command.title === "string" ? nonempty(command.title) : null,
    };
  });
  return {
    identity: {
      name: typeof record.name === "string" ? nonempty(record.name) : null,
      publisher:
        typeof record.publisher === "string"
          ? nonempty(record.publisher)
          : null,
      version:
        typeof record.version === "string" ? nonempty(record.version) : null,
    },
    engine,
    main: packageJsonEntryPath(record.main),
    browser: packageJsonEntryPath(record.browser),
    activationEvents: asStringArray(record.activationEvents),
    contributes: {
      keys,
      commands,
      commands_total: commandRows.length,
      commands_omitted: listedCommands.omitted,
    },
    extensionDependencies: asStringArray(record.extensionDependencies),
    extensionPack: asStringArray(record.extensionPack),
    extensionKind: asStringArray(record.extensionKind),
    capabilities: {
      untrusted_workspaces: capabilityValue(
        record.capabilities !== null &&
          typeof record.capabilities === "object" &&
          !Array.isArray(record.capabilities)
          ? (record.capabilities as Record<string, unknown>).untrustedWorkspaces
          : undefined,
      ),
      virtual_workspaces: capabilityValue(
        record.capabilities !== null &&
          typeof record.capabilities === "object" &&
          !Array.isArray(record.capabilities)
          ? (record.capabilities as Record<string, unknown>).virtualWorkspaces
          : undefined,
      ),
    },
    enabledApiProposals: asStringArray(record.enabledApiProposals),
  };
};

const identityDisagreements = (
  vsix: VsixPackage["vsix_identity"],
  pkg: VsixPackage["package_identity"],
): VsixPackage["identity_disagreements"] => {
  if (vsix === null || pkg === null) return [];
  const disagreements: VsixPackage["identity_disagreements"] = [];
  const expectedId =
    pkg.publisher !== null && pkg.name !== null
      ? `${pkg.publisher}.${pkg.name}`
      : pkg.name;
  if (
    vsix.id !== null &&
    expectedId !== null &&
    vsix.id !== expectedId &&
    vsix.id !== pkg.name
  )
    disagreements.push({
      field: "id",
      vsixmanifest: vsix.id,
      package_json: expectedId,
    });
  if (
    vsix.publisher !== null &&
    pkg.publisher !== null &&
    vsix.publisher !== pkg.publisher
  )
    disagreements.push({
      field: "publisher",
      vsixmanifest: vsix.publisher,
      package_json: pkg.publisher,
    });
  if (
    vsix.version !== null &&
    pkg.version !== null &&
    vsix.version !== pkg.version
  )
    disagreements.push({
      field: "version",
      vsixmanifest: vsix.version,
      package_json: pkg.version,
    });
  return disagreements;
};

const resolveKind = (
  pathKind: VsixMemberKind,
  magicKind: VsixMemberKind | undefined,
): { kind: VsixMemberKind; classification: "observed" | "inferred" } => {
  if (magicKind === undefined)
    return { kind: pathKind, classification: "inferred" };
  if (pathKind === "unknown" || pathKind === magicKind)
    return { kind: magicKind, classification: "observed" };
  if (pathKind === "native_addon" && magicKind === "executable")
    return { kind: "native_addon", classification: "observed" };
  return { kind: pathKind, classification: "inferred" };
};

interface InventoriedMember {
  readonly entry: FileEntry;
  readonly sourceName: string;
  readonly path: string;
  readonly kind: VsixMemberKind;
  readonly traverses: boolean;
  readonly encrypted: boolean;
}

/** Decode one bounded VS Code .vsix without installing, executing, or network. */
export const parseVsixPackage = async (
  bytes: Uint8Array,
  artifact: { path: string; sha256: string; bytes: number },
  input: InspectVsixPackageInput,
  signal?: AbortSignal,
): Promise<VsixPackage> => {
  if (bytes.length !== artifact.bytes)
    throw malformedInput(
      VSIX_PACKAGE_FORMAT,
      "Selected artifact length disagrees with the retained bytes.",
    );
  if (!hasZipSignature(bytes))
    throw malformedInput(
      VSIX_PACKAGE_FORMAT,
      "Selected file is not a ZIP archive (VS Code .vsix).",
    );
  const reader = new ZipReader(new Uint8ArrayReader(bytes), ZIP_READER_OPTIONS);
  const limitations: string[] = [...BASE_LIMITATIONS];
  try {
    const entries: Entry[] = [];
    try {
      for await (const entry of reader.getEntriesGenerator({
        decodeText: decodeZipEntryText,
        ...(signal === undefined ? {} : { signal }),
      })) {
        if (entries.length >= input.max_entries)
          throw decodeLimit(
            VSIX_PACKAGE_FORMAT,
            `VS Code extension ZIP exceeds the ${String(input.max_entries)}-entry budget.`,
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
    const files: InventoriedMember[] = [];
    const contents: VsixPackage["contents"] = [];
    const pathCounts = new Map<string, number>();
    for (const entry of entries) {
      if (entry.directory) continue;
      if (!asFileEntry(entry)) continue;
      const sourceName = zipEntryPath(entry);
      const path = vsixPackageLogicalPath(sourceName);
      if (path === "") continue;
      for (const limitation of zipEntryNameLimitations(entry))
        limitations.push(
          `ZIP member ${JSON.stringify(sourceName)}: ${limitation}`,
        );
      const traverses = vsixPackagePathTraverses(sourceName);
      if (traverses) limitations.push(VSIX_LIMITATIONS.traverses(sourceName));
      const folded = path.toLowerCase();
      pathCounts.set(folded, (pathCounts.get(folded) ?? 0) + 1);
      const kind = vsixPackagePathKind(path);
      files.push({
        entry,
        sourceName,
        path,
        kind,
        traverses,
        encrypted: entry.encrypted === true,
      });
      contents.push({
        name: sourceName,
        path,
        uncompressed_size: zipSize(entry.uncompressedSize),
        compressed_size: zipSize(entry.compressedSize),
        encrypted: entry.encrypted === true,
        kind,
        traverses,
      });
    }
    const duplicatePaths = [...pathCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([path]) => path);
    for (const path of duplicatePaths)
      limitations.push(VSIX_LIMITATIONS.duplicatePath(path));
    const presentPaths = new Set(files.map((file) => file.path.toLowerCase()));
    const uniqueByPath = (logical: string): InventoriedMember | undefined => {
      const folded = logical.toLowerCase();
      if ((pathCounts.get(folded) ?? 0) !== 1) return undefined;
      return files.find((file) => file.path.toLowerCase() === folded);
    };
    const vsixMember = uniqueByPath("extension.vsixmanifest");
    const packageMember = uniqueByPath("extension/package.json");
    let examined = 0;
    let vsixParsed: ParsedVsixManifest | undefined;
    let vsixBytes: number | null = null;
    if (vsixMember === undefined)
      limitations.push(VSIX_LIMITATIONS.noVsixmanifest);
    else if (vsixMember.traverses || vsixMember.encrypted) {
      limitations.push(
        vsixMember.encrypted
          ? "Selected extension.vsixmanifest is encrypted and was not extracted."
          : VSIX_LIMITATIONS.traverses(vsixMember.sourceName),
      );
    } else {
      const decoded = await readMemberBytes(
        vsixMember.entry,
        signal,
        input.max_manifest_bytes,
        "Selected extension.vsixmanifest",
        "max_manifest_bytes",
      );
      vsixBytes = decoded.length;
      examined += decoded.length;
      let vsixText: string | undefined;
      try {
        vsixText = decodeXmlPlistText(decoded);
      } catch {
        limitations.push(
          "The selected extension.vsixmanifest is not valid UTF-8 or BOM-marked UTF-16 XML text.",
        );
      }
      if (vsixText !== undefined) {
        // Count nodes as a stream first, so a compressed manifest of many tiny
        // elements is refused before its document tree is allocated.
        const nodes = countXmlNodes(
          vsixText,
          MAX_INSPECT_VSIX_PACKAGE_MANIFEST_XML_NODES,
        );
        if (nodes > MAX_INSPECT_VSIX_PACKAGE_MANIFEST_XML_NODES)
          throw decodeLimit(
            VSIX_PACKAGE_FORMAT,
            `Selected extension.vsixmanifest holds more than ${String(MAX_INSPECT_VSIX_PACKAGE_MANIFEST_XML_NODES)} XML nodes, above the node allowance for its document tree.`,
            {
              name: "xml_nodes",
              maximum: MAX_INSPECT_VSIX_PACKAGE_MANIFEST_XML_NODES,
              required: nodes,
            },
          );
        vsixParsed = parseVsixManifestDocument(
          vsixText,
          limitations,
          presentPaths,
        );
      }
    }
    let packageParsed: ParsedPackageJson | undefined;
    let packageBytes: number | null = null;
    if (packageMember === undefined)
      limitations.push(VSIX_LIMITATIONS.noPackageJson);
    else if (packageMember.traverses || packageMember.encrypted) {
      limitations.push(
        packageMember.encrypted
          ? "Selected extension/package.json is encrypted and was not extracted."
          : VSIX_LIMITATIONS.traverses(packageMember.sourceName),
      );
    } else {
      const decoded = await readMemberBytes(
        packageMember.entry,
        signal,
        input.max_manifest_bytes,
        "Selected extension/package.json",
        "max_manifest_bytes",
      );
      packageBytes = decoded.length;
      examined += decoded.length;
      try {
        packageParsed = parsePackageJsonDocument(
          decodeXmlPlistText(decoded),
          limitations,
        );
      } catch {
        limitations.push(
          "The selected extension/package.json is not valid UTF-8 or BOM-marked UTF-16 JSON text.",
        );
      }
    }
    const interestingMembers: VsixPackage["interesting_members"] = [];
    const kindCounts = emptyKindCounts();
    // One package-wide ceiling on decoded member bytes, so many small
    // compressed members cannot each spend a full per-member budget.
    const expansion = new Budget(artifactExpansionBudgetBytes(bytes.length));
    for (const [index, file] of files.entries()) {
      let kind = file.kind;
      let classification: "observed" | "inferred" = "inferred";
      const shouldHash =
        isVsixInterestingMemberKind(kind) ||
        (kind === "unknown" && unixExecutable(file.entry));
      let hashed: Uint8Array | undefined;
      if (shouldHash && !file.traverses && !file.encrypted) {
        const declared = zipSize(file.entry.uncompressedSize);
        const allowance = Math.min(input.max_member_bytes, expansion.remaining);
        const unread = () =>
          allowance < input.max_member_bytes
            ? VSIX_LIMITATIONS.packageExpansionSpent(
                file.path,
                expansion.maximum,
              )
            : VSIX_LIMITATIONS.memberOversize(
                file.path,
                input.max_member_bytes,
              );
        if (declared !== null && declared > allowance) {
          limitations.push(
            declared > input.max_member_bytes
              ? VSIX_LIMITATIONS.memberOversize(
                  file.path,
                  input.max_member_bytes,
                )
              : unread(),
          );
        } else {
          try {
            hashed = await readMemberBytes(
              file.entry,
              signal,
              allowance,
              `Member ${file.path}`,
              "max_member_bytes",
            );
            expansion.chargeOverCommitting(hashed.length);
          } catch (cause: unknown) {
            if (
              cause instanceof ParseFailureError &&
              cause.failure.kind === "limit" &&
              cause.failure.limit?.name === "max_member_bytes"
            ) {
              limitations.push(unread());
            } else throw cause;
          }
        }
      } else if (shouldHash && file.encrypted) {
        limitations.push(
          `Member ${JSON.stringify(file.path)} is encrypted and was not hashed.`,
        );
      }
      if (hashed !== undefined) {
        const resolved = resolveKind(kind, vsixMemberMagicKind(hashed));
        kind = resolved.kind;
        classification = resolved.classification;
        contents[index] = { ...contents[index]!, kind };
        if (isVsixInterestingMemberKind(kind))
          interestingMembers.push({
            path: file.path,
            kind,
            bytes: hashed.length,
            sha256: sha256Hex(hashed),
            classification,
          });
      } else if (isVsixInterestingMemberKind(kind)) {
        interestingMembers.push({
          path: file.path,
          kind,
          bytes: zipSize(file.entry.uncompressedSize),
          sha256: null,
          classification: "inferred",
        });
      }
      kindCounts[kind] += 1;
    }
    const vsixIdentity = vsixParsed?.identity ?? null;
    const packageIdentity = packageParsed?.identity ?? null;
    const vsixEngine = vsixParsed?.engine ?? null;
    const packageEngine = packageParsed?.engine ?? null;
    const mainPath = packageParsed?.main ?? null;
    const browserPath = packageParsed?.browser ?? null;
    const extensionDependencies = {
      vsixmanifest: vsixParsed?.extensionDependencies ?? [],
      package_json: packageParsed?.extensionDependencies ?? [],
      disagreement: false,
    };
    extensionDependencies.disagreement = !sameIdSet(
      extensionDependencies.vsixmanifest,
      extensionDependencies.package_json,
    );
    const extensionPack = {
      vsixmanifest: vsixParsed?.extensionPack ?? [],
      package_json: packageParsed?.extensionPack ?? [],
      disagreement: false,
    };
    extensionPack.disagreement = !sameIdSet(
      extensionPack.vsixmanifest,
      extensionPack.package_json,
    );
    const signatures = {
      p7s: presentPaths.has("extension.signature.p7s"),
      manifest: presentPaths.has(".signature.manifest"),
    };
    return {
      artifact: {
        path: artifact.path,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
      },
      vsix_identity: vsixIdentity,
      package_identity: packageIdentity,
      identity_disagreements: identityDisagreements(
        vsixIdentity,
        packageIdentity,
      ),
      engine: {
        vsixmanifest: vsixEngine,
        package_json: packageEngine,
        disagreement:
          vsixEngine !== null &&
          packageEngine !== null &&
          vsixEngine !== packageEngine,
      },
      target_platform: vsixIdentity?.target_platform ?? null,
      entry_points: {
        main:
          mainPath === null
            ? null
            : {
                path: mainPath,
                present: presentPaths.has(mainPath.toLowerCase()),
              },
        browser:
          browserPath === null
            ? null
            : {
                path: browserPath,
                present: presentPaths.has(browserPath.toLowerCase()),
              },
      },
      activation_events: (packageParsed?.activationEvents ?? []).map(
        (event) => ({
          event,
          eager: vsixActivationIsEager(event),
        }),
      ),
      contributes: packageParsed?.contributes ?? {
        keys: [],
        commands: [],
        commands_total: 0,
        commands_omitted: 0,
      },
      extension_dependencies: extensionDependencies,
      extension_pack: extensionPack,
      extension_kind:
        (packageParsed?.extensionKind.length ?? 0) > 0
          ? (packageParsed?.extensionKind ?? [])
          : (vsixParsed?.extensionKind ?? []),
      capabilities: packageParsed?.capabilities ?? {
        untrusted_workspaces: null,
        virtual_workspaces: null,
      },
      enabled_api_proposals: packageParsed?.enabledApiProposals ?? [],
      assets: vsixParsed?.assets ?? [],
      signatures,
      contents,
      member_kind_counts: kindCounts,
      interesting_members: interestingMembers,
      duplicate_paths: duplicatePaths,
      vsixmanifest:
        vsixMember === undefined
          ? null
          : { path: vsixMember.path, bytes: vsixBytes },
      package_json:
        packageMember === undefined
          ? null
          : { path: packageMember.path, bytes: packageBytes },
      coverage: {
        status: listing.status,
        entries: contents.length,
        examined_manifest_bytes: examined,
      },
      limitations,
    };
  } finally {
    await reader.close().catch(() => undefined);
  }
};
