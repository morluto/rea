import { createHash, type Hash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { createInflate, inflateSync } from "node:zlib";

import { DOMParser, type Element, type Node } from "@xmldom/xmldom";

import type { ArtifactCommand } from "../domain/artifactGraph.js";
import {
  ArtifactDecodedBudget,
  ArtifactBudgetTransform,
} from "./ArtifactDecodedBudget.js";
import { artifactStreamPipeline } from "./ArtifactStreamPipeline.js";
import {
  assertXarTocElements,
  xarInteger as integer,
  xarHeapPosition,
  XarPathBudget,
  xarMode,
} from "./XarValidation.js";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactChecksumObservation,
  type ArtifactReader,
} from "./ArtifactReader.js";

const XAR_MAGIC = 0x78617221;
/** A TOC describes members only; real installer TOCs are kilobytes. */
const MAX_TOC_BYTES = 64 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;

const CHECKSUM_ALGORITHMS: ReadonlyMap<string, string> = new Map([
  ["sha1", "sha1"],
  ["md5", "md5"],
  ["sha256", "sha256"],
  ["sha512", "sha512"],
]);
const DIGEST_BYTES: ReadonlyMap<string, number> = new Map([
  ["sha1", 20],
  ["md5", 16],
  ["sha256", 32],
  ["sha512", 64],
]);

const cancelled = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure("cancelled", "PKG traversal was cancelled");
};

/** One TOC `<data>` element: where a member's archived bytes live in the heap. */
interface XarData {
  readonly offset: number;
  readonly length: number;
  readonly size: number;
  readonly encoding: string;
  readonly extractedChecksum:
    | { readonly algorithm: string; readonly value: string }
    | undefined;
  readonly unsupportedChecksum:
    | { readonly style: string; readonly value: string }
    | undefined;
  readonly archivedChecksum:
    | { readonly algorithm: string; readonly value: string }
    | undefined;
  readonly unsupportedArchivedChecksum:
    | { readonly style: string; readonly value: string }
    | undefined;
}

interface XarMember {
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink";
  /** Raw TOC type when it is not file/directory/symlink (FIFO, device, ...). */
  readonly unsupportedType?: string;
  readonly mode: number | null;
  readonly data: XarData | undefined;
  readonly link: string | undefined;
}

const isElement = (node: Node): node is Element => node.nodeType === 1;

/** Direct child elements with one tag name, in document order. */
const childElements = (element: Element, name: string): Element[] =>
  Array.from(element.childNodes).filter(
    (child): child is Element => isElement(child) && child.tagName === name,
  );

const childElement = (element: Element, name: string): Element | undefined =>
  childElements(element, name)[0];

const textOf = (element: Element, name: string): string | undefined =>
  childElement(element, name)?.textContent ?? undefined;

const parseChecksum = (
  parent: Element,
  tag: string,
):
  | { readonly algorithm: string; readonly value: string }
  | { readonly unsupported: string; readonly value: string }
  | undefined => {
  const element = childElement(parent, tag);
  if (element === undefined) return undefined;
  const style = element.getAttribute("style")?.toLowerCase() ?? "";
  const value = (element.textContent ?? "").trim().toLowerCase();
  if (CHECKSUM_ALGORITHMS.get(style) === undefined)
    return { unsupported: style || "(missing style)", value };
  const expected = DIGEST_BYTES.get(style);
  if (
    expected === undefined ||
    value.length !== expected * 2 ||
    !/^[0-9a-f]+$/u.test(value)
  )
    throw new ArtifactReaderFailure(
      "format",
      `xar ${tag} has malformed ${style} digest text`,
    );
  return { algorithm: style, value };
};

const parseData = (file: Element): XarData | undefined => {
  const data = childElement(file, "data");
  if (data === undefined) return undefined;
  const extracted = parseChecksum(data, "extracted-checksum");
  const archived = parseChecksum(data, "archived-checksum");
  return {
    offset: integer(textOf(data, "offset"), "data offset"),
    length: integer(textOf(data, "length"), "data length"),
    size: integer(textOf(data, "size"), "data size"),
    encoding:
      childElement(data, "encoding")?.getAttribute("style") ??
      "application/octet-stream",
    extractedChecksum:
      extracted === undefined || "unsupported" in extracted
        ? undefined
        : { algorithm: extracted.algorithm, value: extracted.value },
    unsupportedChecksum:
      extracted !== undefined && "unsupported" in extracted
        ? { style: extracted.unsupported, value: extracted.value }
        : undefined,
    archivedChecksum:
      archived === undefined || "unsupported" in archived
        ? undefined
        : { algorithm: archived.algorithm, value: archived.value },
    unsupportedArchivedChecksum:
      archived !== undefined && "unsupported" in archived
        ? { style: archived.unsupported, value: archived.value }
        : undefined,
  };
};

/**
 * Raw members must describe their stored bytes exactly; otherwise the source
 * range would extend into adjacent heap entries.
 */
const assertRawSize = (member: XarMember, data: XarData | undefined): void => {
  if (
    data !== undefined &&
    data.encoding === "application/octet-stream" &&
    data.size !== data.length
  )
    throw new ArtifactReaderFailure(
      "format",
      `xar member ${member.path} declares size ${data.size} with length ${data.length}`,
    );
};

/** Entry limitations from the TOC record and nested-archive classification. */
const memberLimitations = (
  member: XarMember,
  unsupportedChecksum: XarData["unsupportedChecksum"],
  unsupportedArchived: XarData["unsupportedArchivedChecksum"],
  classified: { readonly limitations: readonly string[] },
): string[] => [
  ...(member.kind === "symlink" && member.link !== undefined
    ? [`Symlink target recorded in the TOC: ${member.link}`]
    : []),
  ...(unsupportedChecksum === undefined
    ? []
    : [
        `Member declares unsupported checksum ${unsupportedChecksum.style}; integrity not verified.`,
      ]),
  ...(unsupportedArchived === undefined
    ? []
    : [
        `Member declares unsupported archived checksum ${unsupportedArchived.style}; stored-byte integrity not verified.`,
      ]),
  ...(member.data !== undefined &&
  member.data.encoding !== "application/octet-stream" &&
  member.data.encoding !== "application/x-gzip"
    ? [
        `Unsupported xar encoding ${member.data.encoding}; content is unavailable and was not expanded.`,
      ]
    : []),
  ...classified.limitations,
];

/** File, directory, symlink, or an explicitly unsupported TOC type. */
const classifyMemberType = (
  type: string | undefined,
): { readonly kind: XarMember["kind"]; readonly unsupportedType?: string } => {
  if (type === "directory" || type === "symlink") return { kind: type };
  if (type === undefined || type === "file") return { kind: "file" };
  return { kind: "file", unsupportedType: type };
};

/** Walk nested `<file>` elements in document order. */
const collectMembers = (
  toc: Element,
  budget: ArtifactDecodedBudget,
): XarMember[] => {
  const members: XarMember[] = [];
  const paths = new XarPathBudget();
  const pending: Array<{ readonly element: Element; readonly parent: string }> =
    childElements(toc, "file")
      .map((element) => ({ element, parent: "" }))
      .reverse();
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) break;
    const name = textOf(next.element, "name");
    if (
      name === undefined ||
      name === "" ||
      name.includes("/") ||
      name === "." ||
      name === ".."
    )
      throw new ArtifactReaderFailure("path", "xar member has an unsafe name");
    const path = paths.join(next.parent, name);
    budget.consumeEntry(path);
    const type = textOf(next.element, "type")?.trim();
    const mode = xarMode(textOf(next.element, "mode"));
    const { kind, unsupportedType } = classifyMemberType(type);
    if (kind !== "file" && childElement(next.element, "data") !== undefined)
      throw new ArtifactReaderFailure(
        "format",
        `xar non-file member declares data: ${path}`,
      );
    members.push({
      path,
      kind,
      ...(unsupportedType === undefined ? {} : { unsupportedType }),
      mode,
      data: parseData(next.element),
      link: kind === "symlink" ? textOf(next.element, "link") : undefined,
    });
    const children = childElements(next.element, "file");
    for (let index = children.length - 1; index >= 0; index--) {
      const element = children[index];
      if (element !== undefined) pending.push({ element, parent: path });
    }
  }
  return members;
};

/** Expose a member's extracted checksum so a caller can apply its own policy. */
const declaredDigest = (
  checksum: { readonly algorithm: string; readonly value: string } | undefined,
): Pick<ArtifactEntry, "declaredSha256" | "declaredChecksum"> => {
  if (checksum === undefined) return { declaredSha256: null };
  if (checksum.algorithm === "sha256")
    return { declaredSha256: checksum.value };
  const algorithm = checksum.algorithm;
  return algorithm === "sha1" || algorithm === "md5" || algorithm === "sha512"
    ? {
        declaredSha256: null,
        declaredChecksum: { algorithm, value: checksum.value },
      }
    : { declaredSha256: null };
};

/**
 * Absolute decoded-byte ceiling for one gzip member. The declared size is
 * attacker-controlled, so it cannot be the only inflation bound.
 */
const MAX_DECODED_MEMBER_BYTES = 256 * 1024 * 1024;

/** Bound decoded output to the TOC-declared extracted size. */
class SizeBound extends Transform {
  #seen = 0;
  #cap: number;

  constructor(
    private readonly path: string,
    private readonly expected: number,
    private readonly budget: ArtifactDecodedBudget,
    private readonly signal?: AbortSignal,
  ) {
    super();
    this.#cap = Math.min(expected, MAX_DECODED_MEMBER_BYTES);
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: TransformCallback,
  ): void {
    if (this.signal?.aborted) {
      done(
        new ArtifactReaderFailure(
          "cancelled",
          `xar member decoding cancelled: ${this.path}`,
        ),
      );
      return;
    }
    try {
      this.budget.consume(chunk.length, this.path);
    } catch (cause: unknown) {
      done(cause instanceof Error ? cause : new Error(String(cause)));
      return;
    }
    this.#seen += chunk.length;
    if (this.#seen > this.#cap) {
      done(
        new ArtifactReaderFailure(
          "limit",
          this.expected > MAX_DECODED_MEMBER_BYTES
            ? `xar member ${this.path} decodes beyond the ${MAX_DECODED_MEMBER_BYTES}-byte member ceiling`
            : `xar member ${this.path} decodes beyond its declared ${this.expected} bytes`,
        ),
      );
      return;
    }
    done(null, chunk);
  }

  override _flush(done: TransformCallback): void {
    done(
      this.#seen === this.expected
        ? null
        : new ArtifactReaderFailure(
            "format",
            `xar member ${this.path} decoded ${this.#seen} bytes, expected ${this.expected}`,
          ),
    );
  }
}

/** Verify a member's extracted checksum as its decoded bytes stream past. */
class ChecksumVerifier extends Transform {
  readonly #hash: Hash;

  constructor(
    private readonly path: string,
    private readonly expected: {
      readonly algorithm: string;
      readonly value: string;
    },
    private readonly record?: (
      observation: ArtifactChecksumObservation,
    ) => void,
  ) {
    super();
    this.#hash = createHash(expected.algorithm);
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: TransformCallback,
  ): void {
    this.#hash.update(chunk);
    done(null, chunk);
  }

  override _flush(done: TransformCallback): void {
    const observed = this.#hash.digest("hex");
    if (this.record !== undefined) {
      this.record({
        representation: "stored",
        algorithm: this.expected.algorithm,
        declared: this.expected.value,
        observed,
      });
      done();
      return;
    }
    done(
      observed === this.expected.value
        ? null
        : new ArtifactReaderFailure(
            "integrity",
            `xar ${this.expected.algorithm} checksum disagrees with content: ${this.path} (declared ${this.expected.value}, observed ${observed})`,
          ),
    );
  }
}

/** First bytes that identify an installer archive member's own format. */
export type XarNestedArchive = "gzip-cpio";

/**
 * Read-only reader for xar archives, the container of flat installer
 * packages. Members are decoded and checksum-verified on demand. Gzip cpio
 * `Scripts` and `Payload` members are marked for nested expansion; pbzx
 * (LZMA) payloads are recorded as files with a limitation.
 */
export class XarArtifactReader implements ArtifactReader {
  readonly format = "pkg" as const;
  #handle: FileHandle | undefined;
  #heap = 0;
  #size = 0;
  readonly decodedBudget: ArtifactDecodedBudget;
  #members: readonly XarMember[] = [];
  readonly #byPath = new Map<string, XarMember>();
  #loading: Promise<void> | undefined;
  #closed = false;
  readonly #streams = new Set<Readable>();
  readonly #integrity = new Map<string, ArtifactChecksumObservation[]>();

  readonly #verifyChecksums: boolean;

  /**
   * @param options.verifyChecksums Fail `open()` streams whose bytes disagree
   * with the member's extracted checksum (default). Inventory passes false and
   * verifies the declared checksum itself under the caller's integrity policy.
   * Archived checksums are always computed. When inventory owns the policy,
   * integrityObservations exposes their declared/observed values after reading.
   */
  constructor(
    private readonly path: string,
    options: {
      readonly verifyChecksums?: boolean;
      readonly decodedBudget?: ArtifactDecodedBudget;
    } = {},
  ) {
    this.#verifyChecksums = options.verifyChecksums ?? true;
    this.decodedBudget = options.decodedBudget ?? new ArtifactDecodedBudget();
  }

  async #load(signal?: AbortSignal): Promise<void> {
    if (this.#closed)
      throw new ArtifactReaderFailure("unavailable", "xar archive is closed");
    this.#loading ??= this.#readToc(signal);
    await this.#loading;
  }

  /** Load/index once; a rejected parse remains rejected, never a partial inventory. */
  async #readToc(signal?: AbortSignal): Promise<void> {
    cancelled(signal);
    const handle = await open(this.path, "r");
    this.#handle = handle;
    this.#size = (await handle.stat()).size;
    const header = Buffer.alloc(28);
    const { bytesRead } = await handle.read(header, 0, 28, 0);
    if (bytesRead < 28 || header.readUInt32BE(0) !== XAR_MAGIC)
      throw new ArtifactReaderFailure("format", "File is not a xar archive");
    const headerSize = header.readUInt16BE(4);
    const tocCompressed = header.readBigUInt64BE(8);
    const tocSize = header.readBigUInt64BE(16);
    // Fixed-header checksum algorithm at offset 24: 0 is none, 1 is SHA-1,
    // 2 is MD5. A declared algorithm requires a matching <checksum> element.
    const headerChecksumAlg = header.readUInt32BE(24);
    if (headerSize < 28)
      throw new ArtifactReaderFailure("format", "xar header is too short");
    if (
      tocCompressed > BigInt(MAX_TOC_BYTES) ||
      tocSize > BigInt(MAX_TOC_BYTES)
    )
      throw new ArtifactReaderFailure(
        "limit",
        `xar TOC exceeds the ${MAX_TOC_BYTES}-byte limit`,
      );
    const compressed = Buffer.alloc(Number(tocCompressed));
    const toc = await handle.read(compressed, 0, compressed.length, headerSize);
    if (toc.bytesRead < compressed.length)
      throw new ArtifactReaderFailure("format", "xar TOC is truncated");
    this.#heap = headerSize + compressed.length;
    let xml: string;
    try {
      const inflated = inflateSync(compressed, {
        maxOutputLength: MAX_TOC_BYTES,
      });
      if (BigInt(inflated.length) !== tocSize)
        throw new ArtifactReaderFailure(
          "format",
          `xar TOC decoded ${inflated.length} bytes, expected ${tocSize}`,
        );
      try {
        xml = new TextDecoder("utf-8", { fatal: true }).decode(inflated);
      } catch (cause: unknown) {
        throw new ArtifactReaderFailure(
          "format",
          "xar TOC is not valid UTF-8",
          { cause },
        );
      }
      assertXarTocElements(xml);
    } catch (cause: unknown) {
      if (cause instanceof ArtifactReaderFailure) throw cause;
      throw new ArtifactReaderFailure("format", "xar TOC is not zlib data", {
        cause,
      });
    }
    let document;
    try {
      document = new DOMParser({
        onError: (level, message) => {
          if (level !== "warning") throw new Error(message);
        },
      }).parseFromString(xml, "text/xml");
    } catch (cause: unknown) {
      throw new ArtifactReaderFailure(
        "format",
        "xar TOC is not well-formed XML",
        { cause },
      );
    }
    const root = document.documentElement;
    const tocElement = root === null ? undefined : childElement(root, "toc");
    if (tocElement === undefined)
      throw new ArtifactReaderFailure("format", "xar TOC has no <toc> element");
    await this.#verifyToc(tocElement, compressed, headerChecksumAlg);
    this.#members = collectMembers(tocElement, this.decodedBudget);
    for (const member of this.#members) {
      if (member.data !== undefined)
        xarHeapPosition(
          this.#heap,
          member.data.offset,
          member.data.length,
          this.#size,
        );
      if (this.#byPath.has(member.path))
        throw new ArtifactReaderFailure(
          "path",
          `Duplicate xar member path: ${member.path}`,
        );
      this.#byPath.set(member.path, member);
    }
  }

  /** The TOC checksum in the heap covers the compressed TOC bytes. */
  async #verifyToc(
    toc: Element,
    compressed: Buffer,
    headerAlg: number,
  ): Promise<void> {
    // Fixed-header checksum IDs follow libarchive's XAR reader: 0 is none,
    // 1 is SHA-1, 2 is MD5, 3 is SHA-256, 4 is SHA-512.
    const expectedStyle =
      headerAlg === 0
        ? null
        : headerAlg === 1
          ? "sha1"
          : headerAlg === 2
            ? "md5"
            : headerAlg === 3
              ? "sha256"
              : headerAlg === 4
                ? "sha512"
                : undefined;
    if (expectedStyle === undefined)
      throw new ArtifactReaderFailure(
        "format",
        `xar header declares unsupported TOC checksum algorithm ${headerAlg}`,
      );
    const checksum = childElement(toc, "checksum");
    if (expectedStyle === null && checksum !== undefined)
      throw new ArtifactReaderFailure(
        "format",
        "xar header declares no TOC checksum but the TOC supplies one",
      );
    if (checksum === undefined) {
      if (headerAlg !== 0)
        throw new ArtifactReaderFailure(
          "format",
          "xar header declares a TOC checksum but the TOC has no <checksum> element",
        );
      return;
    }
    const style = checksum.getAttribute("style")?.toLowerCase() ?? "";
    if (expectedStyle !== null && style !== expectedStyle)
      throw new ArtifactReaderFailure(
        "format",
        `xar TOC checksum style ${style || "(missing)"} does not match header algorithm ${expectedStyle ?? "none"}`,
      );
    const algorithm = CHECKSUM_ALGORITHMS.get(style);
    if (algorithm === undefined)
      throw new ArtifactReaderFailure(
        "format",
        `xar TOC declares unsupported checksum style ${style || "(missing)"}`,
      );
    const size = integer(textOf(checksum, "size"), "checksum size");
    // The stored checksum is exactly one digest; never allocate a declared size.
    if (size !== DIGEST_BYTES.get(style))
      throw new ArtifactReaderFailure(
        "format",
        `xar TOC declares a ${size}-byte ${style} checksum`,
      );
    const stored = await this.#heapBytes(
      integer(textOf(checksum, "offset"), "checksum offset"),
      size,
    );
    if (!createHash(algorithm).update(compressed).digest().equals(stored))
      throw new ArtifactReaderFailure(
        "integrity",
        "xar TOC checksum disagrees with the TOC",
      );
  }

  async #heapBytes(offset: number, length: number): Promise<Buffer> {
    const handle = this.#handle;
    if (handle === undefined)
      throw new ArtifactReaderFailure("unavailable", "xar archive is closed");
    const position = xarHeapPosition(this.#heap, offset, length, this.#size);
    const bytes = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const { bytesRead } = await handle.read(
        bytes,
        done,
        length - done,
        position + done,
      );
      if (bytesRead === 0)
        throw new ArtifactReaderFailure(
          "format",
          "xar member extends beyond the archive",
        );
      done += bytesRead;
    }
    return bytes;
  }

  /** Classify a raw-stored installer member by its leading bytes. */
  async #nestedArchive(member: XarMember): Promise<{
    readonly nested: XarNestedArchive | undefined;
    readonly limitations: readonly string[];
  }> {
    const name = member.path.split("/").at(-1);
    const data = member.data;
    if (
      (name !== "Payload" && name !== "Scripts") ||
      data === undefined ||
      data.length < 4
    )
      return { nested: undefined, limitations: [] };
    if (data.encoding !== "application/octet-stream")
      return {
        nested: undefined,
        limitations: [
          `${name} is stored with ${data.encoding}; its archive is not expanded.`,
        ],
      };
    const head = await this.#heapBytes(data.offset, 4);
    if (head[0] === 0x1f && head[1] === 0x8b)
      return { nested: "gzip-cpio", limitations: [] };
    if (head.toString("latin1") === "pbzx")
      return {
        nested: undefined,
        limitations: [
          `${name} is a pbzx (LZMA) archive; its members are not expanded. Expand it with pkgutil --expand-full to inspect them.`,
        ],
      };
    return {
      nested: undefined,
      limitations: [
        `${name} has an unrecognized archive format and is not expanded.`,
      ],
    };
  }

  async *entries(signal?: AbortSignal): AsyncIterable<ArtifactEntry> {
    await this.#load(signal);
    for (const member of this.#members) {
      cancelled(signal);
      yield await this.#memberEntry(member);
    }
  }

  /** Project one TOC member as an archive-neutral entry. */
  async #memberEntry(member: XarMember): Promise<ArtifactEntry> {
    if (member.unsupportedType !== undefined)
      return {
        path: member.path,
        kind: "file",
        declaredSize: null,
        compressedSize: null,
        executable: false,
        encrypted: false,
        byteOffset: null,
        declaredSha256: null,
        unpacked: false,
        limitations: [
          `Unsupported xar member type ${member.unsupportedType}; content not expanded.`,
        ],
        adapterKey: member.path,
        contentUnavailable: true,
      };
    const data = member.data;
    assertRawSize(member, data);
    const unsupportedChecksum = data?.unsupportedChecksum;
    const unsupportedArchived = data?.unsupportedArchivedChecksum;
    const unsupportedEncoding =
      data !== undefined &&
      data.encoding !== "application/octet-stream" &&
      data.encoding !== "application/x-gzip";
    const classified =
      member.kind === "file" &&
      unsupportedChecksum === undefined &&
      unsupportedArchived === undefined &&
      !unsupportedEncoding
        ? await this.#nestedArchive(member)
        : {
            nested: undefined as XarNestedArchive | undefined,
            limitations: [] as readonly string[],
          };
    return {
      path: member.path,
      kind: member.kind,
      declaredSize: member.data?.size ?? (member.kind === "file" ? 0 : null),
      compressedSize: member.data?.length ?? null,
      executable: member.mode !== null && (member.mode & 0o111) !== 0,
      encrypted: false,
      byteOffset:
        member.data?.encoding === "application/octet-stream"
          ? this.#heap + member.data.offset
          : null,
      ...declaredDigest(member.data?.extractedChecksum),
      unpacked: false,
      limitations: memberLimitations(
        member,
        unsupportedChecksum,
        unsupportedArchived,
        classified,
      ),
      adapterKey: member.path,
      ...(unsupportedEncoding ||
      unsupportedChecksum !== undefined ||
      unsupportedArchived !== undefined
        ? { contentUnavailable: true }
        : {}),
      ...(classified.nested === undefined
        ? {}
        : { nestedArchive: classified.nested }),
    };
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    cancelled(signal);
    this.#integrity.delete(entry.adapterKey);
    await this.#load(signal);
    const member = this.#byPath.get(entry.adapterKey);
    if (member === undefined || member.kind !== "file")
      throw new ArtifactReaderFailure(
        "path",
        `xar member is not a file: ${entry.path}`,
      );
    if (member.unsupportedType !== undefined)
      throw new ArtifactReaderFailure(
        "unavailable",
        `xar member ${entry.path} has unsupported type ${member.unsupportedType}`,
      );
    const data = member.data;
    if (data === undefined) return Readable.from([]);
    if (entry.contentUnavailable === true)
      throw new ArtifactReaderFailure(
        "unavailable",
        `xar member ${entry.path} is not expandable`,
      );
    // Raw members must describe their stored bytes exactly.
    if (
      data.encoding === "application/octet-stream" &&
      data.size !== data.length
    )
      throw new ArtifactReaderFailure(
        "format",
        `xar member ${entry.path} declares size ${data.size} with length ${data.length}`,
      );
    // Validate before creating any streams: otherwise an early throw would
    // orphan a flowing source that keeps reading after close().
    if (
      data.encoding !== "application/octet-stream" &&
      data.encoding !== "application/x-gzip"
    )
      throw new ArtifactReaderFailure(
        "format",
        `xar member ${entry.path} uses unsupported encoding ${data.encoding}`,
      );
    // Archived checksums cover the stored stream, which inventory's scanner
    // never observes: it hashes decoded bytes. Always verify them here; the
    // scanner's per-entry recovery still honors record-and-continue.
    const archived = data.archivedChecksum;
    const archivedVerifier =
      archived === undefined
        ? undefined
        : new ChecksumVerifier(
            `${entry.path} (archived)`,
            archived,
            this.#verifyChecksums
              ? undefined
              : (observation) => {
                  this.#integrity.set(entry.adapterKey, [observation]);
                },
          );
    const stages: Transform[] = [
      new ArtifactBudgetTransform(this.decodedBudget, entry.path, signal),
    ];
    if (archivedVerifier !== undefined) stages.push(archivedVerifier);
    if (data.encoding === "application/x-gzip")
      stages.push(
        createInflate(),
        new SizeBound(entry.path, data.size, this.decodedBudget, signal),
      );
    const checksum = data.extractedChecksum;
    if (checksum !== undefined && this.#verifyChecksums)
      stages.push(new ChecksumVerifier(entry.path, checksum));
    const stream = artifactStreamPipeline(
      Readable.from(this.#chunks(data.offset, data.length, signal)),
      stages,
      { path: entry.path, signal },
    );
    this.#streams.add(stream);
    stream.once("close", () => this.#streams.delete(stream));
    return stream;
  }

  async *#chunks(
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): AsyncGenerator<Buffer> {
    for (let done = 0; done < length;) {
      cancelled(signal);
      const size = Math.min(READ_CHUNK_BYTES, length - done);
      yield await this.#heapBytes(offset + done, size);
      done += size;
    }
  }

  provenance(): readonly ArtifactCommand[] {
    return [];
  }

  /** Stored-byte checksums computed while consuming the member stream. */
  integrityObservations(
    entry: ArtifactEntry,
  ): readonly ArtifactChecksumObservation[] {
    return this.#integrity.get(entry.adapterKey) ?? [];
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const stream of this.#streams) stream.destroy();
    await this.#loading?.catch(() => undefined);
    const handle = this.#handle;
    this.#handle = undefined;
    this.#members = [];
    this.#byPath.clear();
    this.#integrity.clear();
    await handle?.close();
  }
}
