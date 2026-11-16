import { Readable, Transform } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { inflateSync } from "node:zlib";

import type {
  MacosPkgEntryMetadata,
  MacosPkgMetadata,
  MacosPkgRefusal,
} from "../domain/artifactFormatMetadata.js";
import { artifactExpansionBudgetBytes } from "../domain/artifactExpansionBudget.js";
import {
  MACOS_PKG_MAX_CPIO_ARCHIVE_BYTES,
  MACOS_PKG_MAX_METADATA_XML_BYTES,
  MACOS_PKG_MAX_TOC_UNCOMPRESSED_BYTES,
  XAR_HEADER_MIN_BYTES,
  XAR_MAGIC_TEXT,
  XAR_VERSION,
  hasXarMagic,
  type MacosPkgParseError,
} from "../domain/macosPkgFormat.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import { readArtifactFileBytes } from "./ArtifactFileRange.js";
import { ArtifactPreparation } from "./ArtifactPreparation.js";
import {
  ArtifactEntryContentUnavailable,
  ArtifactFileSource,
  ArtifactReaderFailure,
  ArtifactResourceScope,
  artifactReaderLimitFailure,
  assertArtifactReadActive,
  assertProducedEntry,
  copyArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactReaderTraversal,
  type ArtifactTraversalOptions,
} from "../resources/index.js";
import { ownArtifactStream } from "./OwnedArtifactStream.js";
import {
  detectPayloadCompression,
  inventoryCompressedArchive,
  isInstallScriptName,
  type CpioMember,
  type PayloadCompression,
} from "./macosPkg/CpioOdc.js";
import {
  createBoundedXarInflate,
  extractedSizeExceedsBudget,
  extractedSizeLimitError,
  extractedSizeMismatchError,
  inflateXarMemberBytes,
  isXarStoredEncoding,
  isXarZlibEncoding,
  maxXarArchivedBytes,
} from "./macosPkg/XarInflate.js";
import {
  parseDistributionXml,
  parsePackageInfoXml,
} from "./macosPkg/InstallerXml.js";
import { parseXarHeader } from "./macosPkg/XarHeader.js";
import {
  heapRangeRefusal,
  parseXarTocXml,
  type XarTocFile,
} from "./macosPkg/XarToc.js";

const READ_CHUNK_BYTES = 64 * 1024;

type StoredEntry = ArtifactEntry & {
  readonly formatMetadata: MacosPkgEntryMetadata;
  readonly origin:
    | {
        readonly kind: "xar";
        readonly heapOffset: number;
        readonly archivedLength: number;
        readonly encoding: string;
      }
    | { readonly kind: "memory"; readonly bytes: Buffer };
};

const emptyMetadata = (): MacosPkgMetadata => ({
  kind: "macos-pkg",
  xar: {
    magic: XAR_MAGIC_TEXT,
    header_size: null,
    version: null,
    toc_compressed_length: null,
    toc_uncompressed_length: null,
    checksum_algorithm: null,
    checksum_algorithm_id: null,
    heap_offset: null,
    heap_length: null,
  },
  signature: {
    present: false,
    toc_signature: false,
    toc_x_signature: false,
    algorithm: null,
    certificate_count: 0,
    certificates: [],
    verification: "not_verified",
  },
  archive_kind: "unknown",
  distribution: null,
  packages: [],
  scripts: {
    present: false,
    compression: "absent",
    preinstall: false,
    postinstall: false,
    members: [],
  },
  payload: {
    present: false,
    compression: "absent",
    members: [],
  },
  bom: { present: false, path: null, size: null },
  refusals: [],
});

const cpioMetadataMembers = (members: readonly CpioMember[]) =>
  members.map((member) => ({
    name: member.name,
    kind: member.kind,
    mode: member.mode,
    uid: member.uid,
    gid: member.gid,
    size: member.size,
    symlink_target: member.symlinkTarget,
  }));

const specialMemberType = (mode: number): string => {
  switch (mode & 0o170000) {
    case 0o010000:
      return "FIFO";
    case 0o020000:
      return "character device";
    case 0o060000:
      return "block device";
    case 0o140000:
      return "socket";
    default:
      return "special file";
  }
};

/** Any owner, group or other execute bit in the parsed XAR TOC mode counts. */
const xarModeIsExecutable = (mode: number | null): boolean =>
  mode !== null && (mode & 0o111) !== 0;

const basename = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
};

/** True when a decode stopped at the remaining shared expansion budget. */
const stoppedBySharedBudget = (
  error: MacosPkgParseError,
  remainingBudget: number,
): boolean =>
  error.kind === "limit" &&
  error.failure.limit.name === "macos_pkg_cpio_archive_bytes" &&
  remainingBudget < MACOS_PKG_MAX_CPIO_ARCHIVE_BYTES &&
  error.failure.limit.maximum === remainingBudget;

const refusalFromParse = (
  error: MacosPkgParseError,
  path: string | null,
): MacosPkgRefusal => {
  const field = error.failure.field;
  const cpioField =
    field === "cpio" ||
    field === "name" ||
    field === "filesize" ||
    field === "mode" ||
    field === "uid" ||
    field === "gid" ||
    field === "namesize";
  let code: MacosPkgRefusal["code"];
  if (error.kind === "limit") code = "oversize";
  else if (error.kind === "unsupported")
    code =
      field === "encoding" ? "unsupported-encoding" : "unsupported-compression";
  else if (error.kind === "truncated") {
    if (field === "header") code = "truncated-header";
    else if (field === "toc" || field === "toc_length_compressed")
      code = "toc-past-eof";
    else if (cpioField) code = "cpio-malformed";
    else code = "heap-out-of-bounds";
  } else if (field === "extracted-size") code = "extracted-size-mismatch";
  else if (field === "gzip") code = "gzip-inflate";
  else if (cpioField) code = "cpio-malformed";
  else if (field === "toc") code = "toc-xml";
  else code = "cpio-malformed";
  return { code, message: error.message, path };
};

const readerFailure = (error: MacosPkgParseError): ArtifactReaderFailure =>
  error.kind === "limit"
    ? new ArtifactReaderFailure("limit", error.message, {
        boundary: "capacity",
        cause: error,
      })
    : new ArtifactReaderFailure("format", error.message, { cause: error });

/** Inventory a macOS flat installer package (XAR `.pkg`) without executing it. */
export class MacosPkgArtifactReader implements ArtifactReader {
  readonly format = "pkg" as const;
  readonly #scope = new ArtifactResourceScope();
  readonly #entries = new Map<string, StoredEntry>();
  /** Members whose stored bytes failed decoding during preparation. */
  readonly #refusedContent = new Map<string, string>();
  readonly #streams = new Set<Readable>();
  readonly #source: ArtifactFileSource;
  readonly #preparation = new ArtifactPreparation();
  readonly #expandedBytes: number | undefined;
  #expansionBudgetBytes = 0;
  #metadata: MacosPkgMetadata = emptyMetadata();
  #coverage: ArtifactReaderTraversal = {
    status: "unknown",
    limitations: [],
  };
  #closing = false;

  constructor(
    path: string,
    admitted?: StableRegularFileDescriptor,
    expandedBytes?: number,
  ) {
    this.#expandedBytes = expandedBytes;
    this.#source = new ArtifactFileSource(
      path,
      "macOS installer package",
      admitted,
    );
  }

  formatMetadata(): MacosPkgMetadata | undefined {
    return structuredClone(this.#metadata);
  }

  async prepareContainer(
    expectedSha256: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#scope.run(async () => {
      this.#assertOpen(signal);
      await this.#source.bindSha256(expectedSha256, signal);
    });
  }

  async *entries(
    signal?: AbortSignal,
    options?: ArtifactTraversalOptions,
  ): AsyncIterable<ArtifactEntry> {
    await this.#scope.run(async () => {
      this.#assertOpen(signal);
      await this.#preparation.run(
        signal,
        () => this.#prepare(signal),
        () => this.#assertOpen(signal),
      );
      await this.#source.read(signal);
    });
    this.#assertOpen(signal);
    options?.onCoverage?.({
      ...this.#coverage,
      limitations: [...this.#coverage.limitations],
    });
    let index = 0;
    for (const entry of this.#entries.values()) {
      if (index % 256 === 0) await setImmediate();
      index += 1;
      this.#assertOpen(signal);
      yield copyArtifactEntry(entry);
    }
    this.#assertOpen(signal);
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    return this.#scope.run(async () => {
      this.#assertOpen(signal);
      const stored = this.#entries.get(entry.adapterKey);
      assertProducedEntry(
        entry,
        stored,
        "Installer package entry does not match its owning inventory",
      );
      if (stored.kind === "directory")
        throw new ArtifactReaderFailure(
          "unavailable",
          `Installer package directory has no file contents: ${stored.path}`,
        );
      if (stored.kind === "metadata")
        throw new ArtifactReaderFailure(
          "unavailable",
          `Installer package special file has no file contents: ${stored.path}`,
        );
      const refused = this.#refusedContent.get(stored.adapterKey);
      if (refused !== undefined)
        throw new ArtifactEntryContentUnavailable(refused, refused, {
          traversal: { status: "unknown", limitations: [refused] },
        });
      const { handle } = await this.#source.read(signal);
      this.#assertOpen(signal);
      const cancellationFailure = (reason: unknown): ArtifactReaderFailure =>
        new ArtifactReaderFailure(
          "cancelled",
          "Installer package read cancelled",
          { cause: reason },
        );
      let source: Readable;
      let decode: Transform | undefined;
      if (stored.origin.kind === "memory")
        source = Readable.from([stored.origin.bytes]);
      else if (stored.origin.archivedLength === 0) source = Readable.from([]);
      else if (isXarStoredEncoding(stored.origin.encoding))
        source = readFileHandleChunks(handle, {
          start: stored.origin.heapOffset,
          end: stored.origin.heapOffset + stored.origin.archivedLength - 1,
          signal,
          cancellationFailure,
        });
      else if (isXarZlibEncoding(stored.origin.encoding)) {
        const budget = this.#expansionBudgetBytes;
        const declared = stored.declaredSize;
        if (declared !== null && extractedSizeExceedsBudget(declared, budget))
          throw artifactReaderLimitFailure(
            "artifact_limits.expanded_bytes",
            budget,
            "bytes",
            declared,
            "memory",
          );
        source = readFileHandleChunks(handle, {
          start: stored.origin.heapOffset,
          end: stored.origin.heapOffset + stored.origin.archivedLength - 1,
          signal,
          cancellationFailure,
        });
        decode = createBoundedXarInflate(budget, stored.path);
      } else
        throw new ArtifactEntryContentUnavailable(
          `XAR member encoding ${stored.origin.encoding} is unsupported`,
          `XAR member encoding ${stored.origin.encoding} is unsupported; stored bytes were not decoded.`,
          {
            traversal: {
              status: "unknown",
              limitations: [
                `XAR member encoding ${stored.origin.encoding} is unsupported.`,
              ],
            },
          },
        );
      const output = this.#memberStream(stored, signal, cancellationFailure);
      ownArtifactStream(source, output, {
        scope: this.#scope,
        streams: this.#streams,
        signal,
        cancellationFailure,
        label: "macOS installer package",
        ...(decode === undefined ? {} : { decode }),
      });
      return output;
    });
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const stream of this.#streams)
      stream.destroy(
        new ArtifactReaderFailure(
          "unavailable",
          "Installer package reader closed",
        ),
      );
    await this.#scope.close();
    await this.#source.close();
    this.#entries.clear();
    this.#refusedContent.clear();
  }

  provenance(): readonly [] {
    return [];
  }

  #assertOpen(signal?: AbortSignal): void {
    assertArtifactReadActive(signal);
    if (this.#closing)
      throw new ArtifactReaderFailure(
        "unavailable",
        "Installer package reader is closed",
      );
  }

  async #prepare(signal?: AbortSignal): Promise<void> {
    const { handle, initial } = await this.#source.read(signal);
    this.#expansionBudgetBytes =
      this.#expandedBytes ?? artifactExpansionBudgetBytes(initial.size);
    const metadata = emptyMetadata();
    const prefix = await readArtifactFileBytes(
      handle,
      0,
      Math.min(initial.size, XAR_HEADER_MIN_BYTES),
      initial.size,
      signal,
    );
    if (!hasXarMagic(prefix))
      throw new ArtifactReaderFailure(
        "format",
        "Installer package magic is not xar!",
      );
    metadata.xar.magic = XAR_MAGIC_TEXT;
    if (prefix.length < XAR_HEADER_MIN_BYTES) {
      metadata.refusals.push({
        code: "truncated-header",
        message: `XAR header is truncated: ${String(prefix.length)} bytes, expected ${String(XAR_HEADER_MIN_BYTES)}`,
        path: null,
      });
      this.#metadata = metadata;
      this.#coverage = {
        status: "unknown",
        limitations: [metadata.refusals[0]!.message],
      };
      return;
    }
    const parsed = parseXarHeader(prefix);
    if (!parsed.ok) {
      metadata.refusals.push(refusalFromParse(parsed.error, null));
      if (parsed.error.kind === "limit") throw readerFailure(parsed.error);
      this.#metadata = metadata;
      this.#coverage = {
        status: "unknown",
        limitations: [parsed.error.message],
      };
      return;
    }
    const header = parsed.value;
    metadata.xar = {
      magic: XAR_MAGIC_TEXT,
      header_size: header.headerSize,
      version: header.version,
      toc_compressed_length: header.tocCompressedLength,
      toc_uncompressed_length: header.tocUncompressedLength,
      checksum_algorithm: header.checksumAlgorithm,
      checksum_algorithm_id: header.checksumAlgorithmId,
      heap_offset: header.heapOffset,
      heap_length: Math.max(0, initial.size - header.heapOffset),
    };
    if (header.version !== XAR_VERSION)
      metadata.refusals.push({
        code: "header-version",
        message: `XAR header version ${String(header.version)} is not ${String(XAR_VERSION)}; remaining fields were still read`,
        path: null,
      });
    if (header.heapOffset > initial.size) {
      metadata.refusals.push({
        code: "toc-past-eof",
        message: `XAR TOC compressed length ${String(header.tocCompressedLength)} extends past the ${String(initial.size)}-byte file`,
        path: null,
      });
      this.#metadata = metadata;
      this.#coverage = {
        status: "unknown",
        limitations: [metadata.refusals.at(-1)!.message],
      };
      return;
    }
    const compressedToc = await readArtifactFileBytes(
      handle,
      header.headerSize,
      header.tocCompressedLength,
      initial.size,
      signal,
    );
    let tocXml: Buffer;
    try {
      tocXml = inflateSync(compressedToc, {
        maxOutputLength: MACOS_PKG_MAX_TOC_UNCOMPRESSED_BYTES,
      });
    } catch (cause: unknown) {
      metadata.refusals.push({
        code: "toc-inflate",
        message:
          cause instanceof Error
            ? `XAR TOC zlib inflate failed: ${cause.message}`
            : "XAR TOC zlib inflate failed",
        path: null,
      });
      this.#metadata = metadata;
      this.#coverage = {
        status: "unknown",
        limitations: [metadata.refusals.at(-1)!.message],
      };
      return;
    }
    const toc = parseXarTocXml(tocXml);
    if (!toc.ok) {
      if (toc.error.kind === "limit") throw readerFailure(toc.error);
      metadata.refusals.push(refusalFromParse(toc.error, null));
      this.#metadata = metadata;
      this.#coverage = {
        status: "unknown",
        limitations: [toc.error.message],
      };
      return;
    }
    const heapLength = metadata.xar.heap_length ?? 0;
    const signatures = toc.value.signatures;
    const chosen =
      signatures.find((record) => record.kind === "x-signature") ??
      signatures[0];
    metadata.signature = {
      present: signatures.length > 0,
      toc_signature: signatures.some((record) => record.kind === "signature"),
      toc_x_signature: signatures.some(
        (record) => record.kind === "x-signature",
      ),
      algorithm: chosen?.algorithm ?? null,
      certificate_count: chosen?.certificates.length ?? 0,
      certificates: (chosen?.certificates ?? []).map((cert) => ({
        subject_cn: cert.subjectCn,
        issuer_cn: cert.issuerCn,
      })),
      verification: "not_verified",
    };
    const limitations: string[] = [];
    if (metadata.signature.present)
      limitations.push(
        "XAR table of contents signature is reported and not verified.",
      );
    for (const [index, file] of toc.value.files.entries()) {
      if (index % 256 === 0) await setImmediate();
      this.#assertOpen(signal);
      const rangeError = heapRangeRefusal(file, heapLength);
      if (rangeError !== undefined) {
        metadata.refusals.push({
          code: "heap-out-of-bounds",
          message: rangeError.message,
          path: file.path,
        });
        limitations.push(rangeError.message);
        continue;
      }
      if (file.type === "directory" || file.data === null)
        this.#addXarDeclaration(file, index);
      else this.#addXarFile(file, index, header.heapOffset);
    }
    const skipped = await this.#decodeInstallerDocuments(
      handle,
      metadata,
      signal,
    );
    this.#metadata = metadata;
    // Completeness comes from examined coverage: a budget skip or any refusal
    // that left content unread (heap range, encoding, decode, cpio, pbzx)
    // keeps coverage unknown. A version notice still reads every field.
    const unexamined =
      skipped.length > 0 ||
      metadata.refusals.some((item) => item.code !== "header-version");
    this.#coverage = {
      status: unexamined ? "unknown" : "complete",
      limitations: [
        ...limitations,
        ...skipped,
        ...metadata.refusals.map((item) => item.message),
      ].filter((message, offset, list) => list.indexOf(message) === offset),
    };
  }

  #addXarFile(file: XarTocFile, tocIndex: number, heapStart: number): void {
    const data = file.data;
    if (data === null) return;
    const role = "xar-file" as const;
    // Key by TOC occurrence: a later record at the same path is a distinct
    // occurrence, not a replacement of the earlier one.
    const adapterKey = `pkg:xar:${String(tocIndex)}:${file.path}`;
    const executable = xarModeIsExecutable(file.mode);
    this.#entries.set(adapterKey, {
      path: file.path,
      sourcePath: file.path,
      kind: file.type === "symlink" ? "symlink" : "file",
      declaredSize: data.size,
      compressedSize: data.length,
      executable,
      encrypted: false,
      byteOffset: heapStart + data.offset,
      byteLength: data.length,
      declaredIntegrity: null,
      unpacked: data.encoding !== "application/octet-stream",
      limitations: [],
      adapterKey,
      formatMetadata: {
        kind: "macos-pkg-entry",
        role,
        encoding: data.encoding,
        data_offset: data.offset,
        archived_length: data.length,
        extracted_size: data.size,
        archived_checksum: data.archivedChecksum,
        extracted_checksum: data.extractedChecksum,
        mode: file.mode,
        uid: null,
        gid: null,
        symlink_target: file.link,
      },
      origin: {
        kind: "xar",
        heapOffset: heapStart + data.offset,
        archivedLength: data.length,
        encoding: data.encoding,
      },
    });
  }

  /**
   * Keep a TOC record with no heap body (a directory, a `<link>`-only symlink,
   * an empty file or a special node) as its own occurrence. Nothing is read
   * from the heap; a symlink opens as its declared target text.
   */
  #addXarDeclaration(file: XarTocFile, tocIndex: number): void {
    const adapterKey = `pkg:xar:${String(tocIndex)}:${file.path}`;
    const kind =
      file.type === "directory"
        ? "directory"
        : file.type === "symlink"
          ? "symlink"
          : file.type === "file"
            ? "file"
            : "metadata";
    const bytes =
      kind === "symlink" ? Buffer.from(file.link ?? "") : Buffer.alloc(0);
    const sized = kind === "file" || kind === "symlink";
    this.#entries.set(adapterKey, {
      path: file.path,
      sourcePath: file.path,
      kind,
      declaredSize: sized ? bytes.length : null,
      compressedSize: null,
      executable: kind !== "metadata" && xarModeIsExecutable(file.mode),
      encrypted: false,
      byteOffset: null,
      declaredIntegrity: null,
      unpacked: false,
      limitations:
        kind === "metadata"
          ? [
              `XAR ${file.type} record has no file contents and is not materialized.`,
            ]
          : [],
      adapterKey,
      formatMetadata: {
        kind: "macos-pkg-entry",
        role: "xar-file",
        encoding: null,
        data_offset: null,
        archived_length: null,
        extracted_size: null,
        archived_checksum: null,
        extracted_checksum: null,
        mode: file.mode,
        uid: null,
        gid: null,
        symlink_target: file.link,
      },
      origin: { kind: "memory", bytes },
    });
  }

  async #decodeInstallerDocuments(
    handle: Parameters<typeof readArtifactFileBytes>[0],
    metadata: MacosPkgMetadata,
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    // Only records with a heap body can carry installer documents.
    const xarEntries = [...this.#entries.values()].filter(
      (entry) =>
        entry.formatMetadata.role === "xar-file" && entry.origin.kind === "xar",
    );
    const distribution = xarEntries.find(
      (entry) => basename(entry.path) === "Distribution",
    );
    const packageInfos = xarEntries.filter(
      (entry) => basename(entry.path) === "PackageInfo",
    );
    const bom = xarEntries.find((entry) => basename(entry.path) === "Bom");
    const scripts = xarEntries.filter(
      (entry) => basename(entry.path) === "Scripts",
    );
    const payloads = xarEntries.filter(
      (entry) => basename(entry.path) === "Payload",
    );
    metadata.bom =
      bom === undefined
        ? { present: false, path: null, size: null }
        : {
            present: true,
            path: bom.path,
            size: bom.declaredSize,
          };
    if (distribution !== undefined) {
      const bytes = await this.#readXarEntry(
        handle,
        distribution,
        MACOS_PKG_MAX_METADATA_XML_BYTES,
        metadata,
        signal,
      );
      if (bytes !== undefined) {
        const parsed = parseDistributionXml(bytes);
        if (parsed.ok)
          metadata.distribution = {
            title: parsed.value.title,
            pkg_refs: parsed.value.pkgRefs.map((ref) => ({
              id: ref.id,
              version: ref.version,
              install_kbytes: ref.installKBytes,
            })),
            choices: [...parsed.value.choices],
            allowed_os_versions: parsed.value.allowedOsVersions.map(
              (range) => ({
                min: range.min,
                max: range.max,
              }),
            ),
            installation_check_script_bytes:
              parsed.value.installationCheckScriptBytes,
            volume_check_script_bytes: parsed.value.volumeCheckScriptBytes,
          };
        else
          metadata.refusals.push(
            refusalFromParse(parsed.error, distribution.path),
          );
      }
    }
    for (const pkg of packageInfos) {
      const bytes = await this.#readXarEntry(
        handle,
        pkg,
        MACOS_PKG_MAX_METADATA_XML_BYTES,
        metadata,
        signal,
      );
      if (bytes === undefined) continue;
      const parsed = parsePackageInfoXml(bytes);
      if (!parsed.ok) {
        metadata.refusals.push(refusalFromParse(parsed.error, pkg.path));
        continue;
      }
      metadata.packages.push({
        path: pkg.path,
        identifier: parsed.value.identifier,
        version: parsed.value.version,
        install_location: parsed.value.installLocation,
        auth: parsed.value.auth,
        postinstall_action: parsed.value.postinstallAction,
        bundles: parsed.value.bundles.map((bundle) => ({
          id: bundle.id,
          path: bundle.path,
          cf_bundle_identifier: bundle.cfBundleIdentifier,
          cf_bundle_version: bundle.cfBundleVersion,
        })),
        preinstall: parsed.value.preinstall,
        postinstall: parsed.value.postinstall,
      });
    }
    metadata.archive_kind =
      metadata.distribution !== null
        ? "product"
        : metadata.packages.length > 0
          ? "component"
          : "unknown";
    let used = 0;
    const skipped: string[] = [];
    const expandListed = async (
      listed: readonly StoredEntry[],
      role: "scripts" | "payload",
    ): Promise<void> => {
      for (const archive of listed) {
        const declared = archive.declaredSize ?? 0;
        const remaining = this.#expansionBudgetBytes - used;
        if (declared > remaining) {
          skipped.push(archive.path);
          continue;
        }
        const charged = await this.#expandArchive(
          handle,
          archive,
          role,
          metadata,
          remaining,
          signal,
        );
        if (charged === "over-budget") {
          skipped.push(archive.path);
          continue;
        }
        used += Math.max(declared, charged);
      }
    };
    // Presence comes from the TOC. An archive that is listed but not read
    // (budget skip or read refusal) stays present with "unread" contents.
    if (scripts.length > 0)
      metadata.scripts = {
        present: true,
        compression: "unread",
        preinstall: false,
        postinstall: false,
        members: [],
      };
    if (payloads.length > 0)
      metadata.payload = { present: true, compression: "unread", members: [] };
    await expandListed(scripts, "scripts");
    await expandListed(payloads, "payload");
    if (skipped.length === 0) return [];
    return [
      `Did not expand Scripts/Payload for ${skipped.join(", ")}; coverage of those component archives is unknown.`,
    ];
  }

  async #expandArchive(
    handle: Parameters<typeof readArtifactFileBytes>[0],
    entry: StoredEntry | undefined,
    role: "scripts" | "payload",
    metadata: MacosPkgMetadata,
    remainingBudget: number,
    signal?: AbortSignal,
  ): Promise<number | "over-budget"> {
    if (entry === undefined) return 0;
    const bytes = await this.#readXarEntry(
      handle,
      entry,
      MACOS_PKG_MAX_CPIO_ARCHIVE_BYTES,
      metadata,
      signal,
    );
    if (bytes === undefined) return 0;
    const compression = detectPayloadCompression(bytes);
    // Decoded cpio bytes are retained as member contents, so the decode is
    // capped by what remains of the shared expansion budget, not only by the
    // per-archive allowance.
    const parsed = inventoryCompressedArchive(bytes, remainingBudget);
    if (!parsed.ok && stoppedBySharedBudget(parsed.error, remainingBudget))
      return "over-budget";
    if (!parsed.ok) {
      const item = refusalFromParse(parsed.error, entry.path);
      metadata.refusals.push(item);
      if (role === "scripts")
        this.#mergeScripts(metadata, {
          present: true,
          compression,
          preinstall: false,
          postinstall: false,
          members: [],
        });
      else
        this.#mergePayload(metadata, {
          present: true,
          compression,
          members: [],
        });
      return 0;
    }
    // A damaged tail keeps the members read before it and records why the
    // rest of the archive could not be read.
    if (parsed.value.partialFailure !== null)
      metadata.refusals.push(
        refusalFromParse(parsed.value.partialFailure, entry.path),
      );
    const members = parsed.value.members;
    const names = members.map((member) => basename(member.name));
    this.#keepStoredArchive(entry, parsed.value.compression);
    if (role === "scripts")
      this.#mergeScripts(metadata, {
        present: true,
        compression: parsed.value.compression,
        preinstall: names.includes("preinstall"),
        postinstall: names.includes("postinstall"),
        members: cpioMetadataMembers(members),
      });
    else
      this.#mergePayload(metadata, {
        present: true,
        compression: parsed.value.compression,
        members: cpioMetadataMembers(members),
      });
    for (const [index, member] of members.entries()) {
      if (member.name === "." || member.name === "./") continue;
      const logical = `${entry.path}/${member.name.replace(/^\.\//u, "")}`;
      const adapterKey = `${entry.adapterKey}:${role}:${String(index)}:${logical}`;
      // FIFOs, devices and sockets have no file contents; they stay as
      // non-materializable declarations instead of becoming empty files.
      const special = member.kind === "other";
      const kind =
        member.kind === "directory"
          ? "directory"
          : member.kind === "symlink"
            ? "symlink"
            : special
              ? "metadata"
              : "file";
      const bytesForOpen =
        member.kind === "symlink"
          ? Buffer.from(member.symlinkTarget ?? "")
          : (member.contents ?? Buffer.alloc(0));
      const limitations: string[] = [];
      if (role === "scripts" && isInstallScriptName(member.name))
        limitations.push("Installer script bytes are not executed.");
      if (special)
        limitations.push(
          `cpio ${specialMemberType(member.mode)} member has no file contents and is not materialized.`,
        );
      this.#entries.set(adapterKey, {
        path: logical,
        sourcePath: member.name,
        kind,
        declaredSize:
          member.kind === "symlink" ? bytesForOpen.length : member.size,
        compressedSize: null,
        executable: !special && (member.mode & 0o111) !== 0,
        encrypted: false,
        byteOffset: null,
        declaredIntegrity: null,
        unpacked: true,
        limitations,
        adapterKey,
        formatMetadata: {
          kind: "macos-pkg-entry",
          role: role === "scripts" ? "scripts-member" : "payload-member",
          encoding: parsed.value.compression,
          data_offset: null,
          archived_length: null,
          extracted_size: member.size,
          archived_checksum: null,
          extracted_checksum: null,
          mode: member.mode,
          uid: member.uid,
          gid: member.gid,
          symlink_target: member.symlinkTarget,
        },
        origin: { kind: "memory", bytes: bytesForOpen },
      });
    }
    return parsed.value.decodedBytes;
  }

  /**
   * Keep an expanded Scripts/Payload archive as evidence (heap location, sizes,
   * TOC checksums). Its members claim `<path>/...`, so the stored occurrence
   * moves to a sibling logical path; `sourcePath` keeps the XAR name.
   */
  #keepStoredArchive(
    entry: StoredEntry,
    compression: PayloadCompression,
  ): void {
    const base = `${entry.path}${compression === "gzip-cpio-odc" ? ".cpio.gz" : ".cpio"}`;
    const taken = new Set([...this.#entries.values()].map((item) => item.path));
    let path = base;
    for (let suffix = 2; taken.has(path); suffix += 1)
      path = `${base}.${String(suffix)}`;
    this.#entries.set(entry.adapterKey, { ...entry, path });
  }

  #mergeScripts(
    metadata: MacosPkgMetadata,
    next: MacosPkgMetadata["scripts"],
  ): void {
    const current = metadata.scripts;
    if (!current.present) {
      metadata.scripts = next;
      return;
    }
    metadata.scripts = {
      present: true,
      compression:
        current.members.length > 0 ? current.compression : next.compression,
      preinstall: current.preinstall || next.preinstall,
      postinstall: current.postinstall || next.postinstall,
      members: [...current.members, ...next.members],
    };
  }

  #mergePayload(
    metadata: MacosPkgMetadata,
    next: MacosPkgMetadata["payload"],
  ): void {
    const current = metadata.payload;
    if (!current.present) {
      metadata.payload = next;
      return;
    }
    metadata.payload = {
      present: true,
      compression:
        current.members.length > 0 ? current.compression : next.compression,
      members: [...current.members, ...next.members],
    };
  }

  async #readXarEntry(
    handle: Parameters<typeof readArtifactFileBytes>[0],
    entry: StoredEntry,
    maxBytes: number,
    metadata: MacosPkgMetadata,
    signal?: AbortSignal,
  ): Promise<Buffer | undefined> {
    if (entry.origin.kind !== "xar") return undefined;
    const declared = entry.declaredSize;
    if (declared !== null && extractedSizeExceedsBudget(declared, maxBytes)) {
      metadata.refusals.push(
        refusalFromParse(
          extractedSizeLimitError(entry.path, declared, maxBytes),
          entry.path,
        ),
      );
      return undefined;
    }
    const { encoding, archivedLength, heapOffset } = entry.origin;
    const supported =
      isXarStoredEncoding(encoding) || isXarZlibEncoding(encoding);
    if (supported && archivedLength > maxXarArchivedBytes(encoding, maxBytes)) {
      metadata.refusals.push({
        code: "oversize",
        message: `${entry.path} exceeds the ${String(maxBytes)}-byte decode allowance`,
        path: entry.path,
      });
      return undefined;
    }
    // An unsupported encoding is refused by inflateXarMemberBytes; never read its range.
    const archived = supported
      ? await readArtifactFileBytes(
          handle,
          heapOffset,
          archivedLength,
          heapOffset + archivedLength,
          signal,
        )
      : Buffer.alloc(0);
    const decoded = inflateXarMemberBytes(
      archived,
      encoding,
      maxBytes,
      entry.path,
    );
    if (!decoded.ok) {
      const refusal = refusalFromParse(decoded.error, entry.path);
      metadata.refusals.push(refusal);
      // A metadata allowance refusal leaves open() to its own expansion budget.
      if (decoded.error.kind !== "limit")
        this.#refusedContent.set(entry.adapterKey, refusal.message);
      return undefined;
    }
    if (declared !== null && declared !== decoded.value.length) {
      const refusal = refusalFromParse(
        extractedSizeMismatchError(entry.path, declared, decoded.value.length),
        entry.path,
      );
      metadata.refusals.push(refusal);
      this.#refusedContent.set(entry.adapterKey, refusal.message);
      return undefined;
    }
    return decoded.value;
  }

  #memberStream(
    entry: StoredEntry,
    signal: AbortSignal | undefined,
    cancellationFailure: (reason: unknown) => Error,
  ): Transform {
    let bytes = 0;
    let validating = false;
    const expected =
      entry.origin.kind === "memory"
        ? entry.origin.bytes.length
        : isXarStoredEncoding(entry.origin.encoding)
          ? entry.origin.archivedLength
          : entry.declaredSize;
    const mismatch = (): ArtifactReaderFailure =>
      new ArtifactReaderFailure(
        "format",
        `${entry.path} extracted size ${String(expected)} does not match the ${String(bytes)}-byte decoded member`,
      );
    const check = async (): Promise<void> => {
      if (expected !== null && bytes !== expected) throw mismatch();
      await this.#source.read(signal);
    };
    const output = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (expected !== null && bytes > expected) {
          callback(mismatch());
          return;
        }
        callback(null, chunk);
      },
      flush(callback) {
        validating = true;
        void check().then(
          () => callback(),
          (cause: unknown) =>
            callback(
              cause instanceof Error
                ? cause
                : new Error("Installer package read failed", { cause }),
            ),
        );
      },
    });
    // Retained bytes involve no descriptor I/O, so a paused consumer must not
    // hold cancellation until production finishes. Final validation, once
    // started, still owns failure precedence.
    if (entry.origin.kind === "memory" && signal !== undefined) {
      const onAbort = (): void => {
        if (!validating && !output.destroyed)
          output.destroy(cancellationFailure(signal.reason));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      output.once("close", () => signal.removeEventListener("abort", onAbort));
      if (signal.aborted) onAbort();
    }
    return output;
  }
}
