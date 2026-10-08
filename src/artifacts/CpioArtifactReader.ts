import { Readable } from "node:stream";
import {
  ArtifactBudgetTransform,
  ArtifactDecodedBudget,
} from "./ArtifactDecodedBudget.js";
import { createGunzip } from "node:zlib";
import { artifactStreamPipeline } from "./ArtifactStreamPipeline.js";

import type { ArtifactCommand } from "../domain/artifactGraph.js";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactChecksumObservation,
  type ArtifactReader,
} from "./ArtifactReader.js";

/** Longest member name accepted, including its terminating NUL. */
const MAX_NAME_BYTES = 64 * 1024;
/** Hard-link bytes are buffered to serve every linked path, within these bounds. */
const MAX_LINK_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_LINK_BUFFER_TOTAL = 64 * 1024 * 1024;
/** Longest symlink target read; PATH_MAX is 1024 on macOS and 4096 on Linux. */
const MAX_SYMLINK_TARGET_BYTES = 4096;
const TRAILER = "TRAILER!!!";
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

const UNRESOLVED_LINK =
  "Hard-link bytes are stored with another member of this archive and could not be associated with this path.";

/** Pull exactly the requested bytes from a stream, holding at most one chunk. */
class ByteSource {
  readonly #iterator: AsyncIterator<unknown>;
  #buffer: Buffer = Buffer.alloc(0);

  constructor(stream: Readable) {
    this.#iterator = stream[Symbol.asyncIterator]();
  }

  async #fill(): Promise<boolean> {
    let next: IteratorResult<unknown>;
    try {
      next = await this.#iterator.next();
    } catch (cause: unknown) {
      if (cause instanceof ArtifactReaderFailure) throw cause;
      throw new ArtifactReaderFailure(
        "format",
        "cpio stream is not valid gzip data",
        { cause },
      );
    }
    if (next.done === true) return false;
    if (!Buffer.isBuffer(next.value))
      throw new ArtifactReaderFailure(
        "format",
        "cpio stream yielded non-binary data",
      );
    this.#buffer =
      this.#buffer.length === 0
        ? next.value
        : Buffer.concat([this.#buffer, next.value]);
    return true;
  }

  async read(length: number, label: string): Promise<Buffer> {
    while (this.#buffer.length < length)
      if (!(await this.#fill()))
        throw new ArtifactReaderFailure("format", `cpio ${label} is truncated`);
    const bytes = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return bytes;
  }

  /** Yield `length` bytes in chunks without buffering them together. */
  async *take(length: number, label: string): AsyncGenerator<Buffer> {
    let remaining = length;
    while (remaining > 0) {
      if (this.#buffer.length === 0 && !(await this.#fill()))
        throw new ArtifactReaderFailure("format", `cpio ${label} is truncated`);
      const size = Math.min(remaining, this.#buffer.length);
      const chunk = this.#buffer.subarray(0, size);
      this.#buffer = this.#buffer.subarray(size);
      remaining -= size;
      yield chunk;
    }
  }

  async close(): Promise<void> {
    await this.#iterator.return?.();
  }

  /** Consume legal zero padding through decoder EOF, including gzip trailer verification. */
  async finish(): Promise<void> {
    do {
      if (this.#buffer.some((byte) => byte !== 0))
        throw new ArtifactReaderFailure(
          "format",
          "cpio has non-padding bytes after its trailer",
        );
      this.#buffer = Buffer.alloc(0);
    } while (await this.#fill());
  }
}

interface CpioHeader {
  readonly format: "odc" | "newc" | "crc";
  readonly mode: number;
  readonly fileSize: number;
  readonly nameSize: number;
  readonly links: number;
  /** Device and inode identifying hard links. */
  readonly identity: string;
  /** `c_check` of `070702` archives: the unsigned 32-bit sum of the data bytes. */
  readonly check: number;
}

const field = (
  bytes: Buffer,
  start: number,
  width: number,
  radix: 8 | 16,
): number => {
  const text = bytes.toString("latin1", start, start + width);
  const pattern = radix === 8 ? /^[0-7]+$/u : /^[0-9a-fA-F]+$/u;
  const value = pattern.test(text) ? Number.parseInt(text, radix) : Number.NaN;
  if (!Number.isSafeInteger(value))
    throw new ArtifactReaderFailure(
      "format",
      "cpio header has a malformed numeric field",
    );
  return value;
};

/** odc (`070707`, octal) and newc/crc (`070701`/`070702`, hexadecimal) headers. */
const readHeader = async (source: ByteSource): Promise<CpioHeader> => {
  const magic = (await source.read(6, "header")).toString("latin1");
  if (magic === "070707") {
    const rest = await source.read(70, "header");
    return {
      format: "odc",
      identity: `${field(rest, 0, 6, 8)}:${field(rest, 6, 6, 8)}`,
      mode: field(rest, 12, 6, 8),
      links: field(rest, 30, 6, 8),
      nameSize: field(rest, 53, 6, 8),
      fileSize: field(rest, 59, 11, 8),
      check: 0,
    };
  }
  if (magic === "070701" || magic === "070702") {
    const rest = await source.read(104, "header");
    return {
      format: magic === "070702" ? "crc" : "newc",
      identity: `${field(rest, 56, 8, 16)}:${field(rest, 64, 8, 16)}:${field(rest, 0, 8, 16)}`,
      mode: field(rest, 8, 8, 16),
      links: field(rest, 32, 8, 16),
      fileSize: field(rest, 48, 8, 16),
      nameSize: field(rest, 88, 8, 16),
      check: field(rest, 96, 8, 16),
    };
  }
  throw new ArtifactReaderFailure(
    "format",
    "cpio member has an unsupported header; only odc and newc archives are expanded",
  );
};

const padding = (format: CpioHeader["format"], length: number): number =>
  format === "odc" ? 0 : (4 - (length % 4)) % 4;

/** Normalize a member name; reject absolute and traversing names. */
const memberPath = (raw: string): string | undefined => {
  const segments = raw
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  if (raw.startsWith("/") || segments.includes(".."))
    throw new ArtifactReaderFailure(
      "path",
      `cpio member escapes its archive: ${raw}`,
    );
  return segments.length === 0 ? undefined : segments.join("/");
};

/** Project one cpio member as an archive-neutral entry. */
const entryOf = (member: {
  readonly path: string;
  readonly kind: ArtifactEntry["kind"];
  readonly key: string;
  readonly header: CpioHeader;
  readonly limitations: readonly string[];
  readonly size?: number | null;
  readonly contentUnavailable?: boolean;
  readonly integrityMismatched?: boolean;
}): ArtifactEntry => ({
  path: member.path,
  kind: member.kind,
  declaredSize:
    member.size !== undefined
      ? member.size
      : member.kind === "file"
        ? member.header.fileSize
        : null,
  compressedSize: null,
  executable: (member.header.mode & 0o111) !== 0,
  encrypted: false,
  byteOffset: null,
  declaredSha256: null,
  unpacked: false,
  limitations: member.limitations,
  adapterKey: member.key,
  ...(member.contentUnavailable === true ? { contentUnavailable: true } : {}),
  ...(member.integrityMismatched === true ? { integrityMismatched: true } : {}),
});

interface PendingLink {
  readonly path: string;
  readonly key: string;
  readonly header: CpioHeader;
}

const drain = async (chunks: AsyncIterable<Buffer>): Promise<void> => {
  for await (const chunk of chunks) void chunk;
};

const crcObservation = (
  declared: number,
  observed: number,
): ArtifactChecksumObservation => ({
  representation: "decoded",
  algorithm: "cpio-byte-sum",
  declared: declared.toString(16).padStart(8, "0"),
  observed: observed.toString(16).padStart(8, "0"),
});

/** Same sentence the scanner uses for a streamed regular-file CRC contradiction. */
const crcMismatchDetail = (observation: ArtifactChecksumObservation): string =>
  `Declared ${observation.representation} ${observation.algorithm} ${observation.declared} disagrees with observed ${observation.observed}.`;

/** Human-readable limitation for a collected (or skipped) symlink target. */
const symlinkTargetLimitation = (
  header: CpioHeader,
  target: Buffer | undefined,
): string => {
  if (target === undefined)
    return `Symlink target of ${header.fileSize} bytes exceeds ${MAX_SYMLINK_TARGET_BYTES} bytes and was not read.`;
  try {
    return `Symlink target: ${new TextDecoder("utf-8", { fatal: true }).decode(target)}`;
  } catch {
    return "Symlink target is not valid UTF-8 and was not decoded; the archived bytes are preserved only as a byte count.";
  }
};

/**
 * Sequential reader for a gzip-compressed cpio archive, such as an installer
 * package's Scripts or Payload. Members are decompressed once, in order: open
 * an entry before advancing to the next one. `070702` data is checked against
 * its CRC. Hard links whose bytes are stored on another member are served
 * from that member's bytes; device nodes, FIFOs, and sockets are skipped.
 */
export class CpioArtifactReader implements ArtifactReader {
  readonly format = "file" as const;
  #source: ByteSource | undefined;
  #signal: AbortSignal | undefined;
  #current:
    | {
        readonly key: string;
        readonly path: string;
        readonly header: CpioHeader;
      }
    | undefined;
  #consumed = false;
  readonly #links = new Map<string, Buffer>();
  readonly #pending = new Map<string, PendingLink[]>();
  readonly #aliases = new Map<string, Buffer>();
  readonly #integrity = new Map<
    string,
    readonly ArtifactChecksumObservation[]
  >();
  readonly #linkIntegrity = new Map<
    string,
    readonly ArtifactChecksumObservation[]
  >();
  #buffered = 0;

  constructor(
    private readonly openCompressed: (
      signal?: AbortSignal,
    ) => Promise<Readable>,
    /**
     * Integrity mode for member CRC failures. Every member representation is
     * checked before the next header is read. `fail` throws. Under
     * record-and-continue the disagreement is returned as checksum evidence
     * so the occurrence and later siblings are still inventoried.
     */
    private readonly integrity: "fail" | "record-and-continue" = "fail",
    readonly decodedBudget: ArtifactDecodedBudget = new ArtifactDecodedBudget(),
  ) {}

  async *entries(signal?: AbortSignal): AsyncIterable<ArtifactEntry> {
    this.#signal = signal;
    const compressed = await this.openCompressed(signal);
    const source = new ByteSource(
      artifactStreamPipeline(
        compressed,
        [
          createGunzip(),
          new ArtifactBudgetTransform(this.decodedBudget, "gzip-cpio", signal),
        ],
        { path: "gzip-cpio", signal },
      ),
    );
    this.#source = source;
    for (let index = 0; ; index++) {
      if (signal?.aborted === true)
        throw new ArtifactReaderFailure(
          "cancelled",
          "cpio expansion was cancelled",
        );
      yield* this.#finishCurrent(source);
      const header = await readHeader(source);
      if (header.nameSize < 1 || header.nameSize > MAX_NAME_BYTES)
        throw new ArtifactReaderFailure(
          "format",
          "cpio member name size is invalid",
        );
      const nameBytes = await source.read(header.nameSize, "member name");
      await drain(
        source.take(
          padding(header.format, 110 + header.nameSize),
          "name padding",
        ),
      );
      // cpio names require exactly one terminal NUL: a missing terminator or
      // an embedded NUL with trailing bytes is malformed. Decode without
      // replacement so distinct byte names cannot collapse to one path.
      if (
        nameBytes.length === 0 ||
        nameBytes[nameBytes.length - 1] !== 0 ||
        nameBytes.indexOf(0) !== nameBytes.length - 1
      )
        throw new ArtifactReaderFailure(
          "format",
          "cpio member name is not NUL-terminated",
        );
      let raw: string;
      try {
        raw = new TextDecoder("utf-8", { fatal: true }).decode(
          nameBytes.subarray(0, nameBytes.length - 1),
        );
      } catch {
        throw new ArtifactReaderFailure(
          "format",
          "cpio member name is not valid UTF-8",
        );
      }
      this.decodedBudget.consumeEntry(raw);
      if (raw === TRAILER) {
        if (header.fileSize !== 0)
          throw new ArtifactReaderFailure(
            "format",
            "cpio trailer declares member data",
          );
        await drain(this.#verified(source, header, raw, undefined, "fail"));
        await source.finish();
        yield* this.#unresolvedLinks();
        return;
      }
      yield* this.#member(source, header, raw, `${index}:${raw}`);
    }
  }

  async *#member(
    source: ByteSource,
    header: CpioHeader,
    raw: string,
    key: string,
  ): AsyncGenerator<ArtifactEntry> {
    const type = header.mode & S_IFMT;
    const path = memberPath(raw);
    if (type === S_IFDIR) {
      const consumed = await this.#consume(source, header, raw, false);
      if (path !== undefined)
        yield entryOf({
          path,
          kind: "directory",
          key,
          header,
          limitations:
            consumed.mismatch === undefined
              ? []
              : [crcMismatchDetail(consumed.mismatch)],
          integrityMismatched: consumed.mismatch !== undefined,
        });
      return;
    }
    if (type === S_IFLNK) {
      yield* this.#symlink(source, { header, raw, key }, path);
      return;
    }
    if (
      path !== undefined &&
      type === S_IFREG &&
      header.links > 1 &&
      header.fileSize === 0
    ) {
      // Zero-size headers carry no bytes, so a CRC archive must declare zero.
      // Under record-and-continue this is the occurrence's own forgotten
      // bytes: yield it unavailable so later siblings still inventory.
      const consumed = await this.#consume(source, header, raw, false);
      if (consumed.mismatch !== undefined) {
        yield entryOf({
          path,
          kind: "file",
          key,
          header,
          size: null,
          limitations: [crcMismatchDetail(consumed.mismatch)],
          contentUnavailable: true,
        });
        return;
      }
      const stored = this.#links.get(header.identity);
      if (stored !== undefined) {
        yield this.#alias(path, key, header, stored);
        return;
      }
      // newc stores a hard link's bytes on its last member; wait for them.
      // An all-empty group is resolved to empty files at TRAILER!!!.
      const waiting = this.#pending.get(header.identity) ?? [];
      waiting.push({ path, key, header });
      this.#pending.set(header.identity, waiting);
      return;
    }
    this.#current = { key, path: raw, header };
    this.#consumed = false;
    if (path === undefined) return;
    if (type !== S_IFREG) {
      // FIFOs, device nodes, sockets and other types are not expanded; keep
      // an explicit unavailable occurrence instead of dropping the path.
      const consumed = await this.#consume(source, header, raw, false);
      this.#current = undefined;
      yield entryOf({
        path,
        kind: "file",
        key,
        header,
        size: null,
        limitations: [
          `Unsupported cpio member type ${type.toString(8)}; content not expanded.`,
          ...(consumed.mismatch === undefined
            ? []
            : [crcMismatchDetail(consumed.mismatch)]),
        ],
        contentUnavailable: true,
      });
      return;
    }
    yield entryOf({
      path,
      kind: "file",
      key,
      header,
      limitations: [],
    });
  }

  /**
   * One symlink member. A hostile header can declare a multi-gigabyte target,
   * so oversized targets stream past. The CRC is resolved before the entry is
   * yielded; under record-and-continue a disagreement stays on the occurrence
   * so later siblings are still inventoried.
   */
  async *#symlink(
    source: ByteSource,
    member: {
      readonly header: CpioHeader;
      readonly raw: string;
      readonly key: string;
    },
    path: string | undefined,
  ): AsyncGenerator<ArtifactEntry> {
    const { header, raw, key } = member;
    const consumed = await this.#consume(
      source,
      header,
      raw,
      header.fileSize <= MAX_SYMLINK_TARGET_BYTES,
    );
    if (path === undefined) return;
    if (consumed.mismatch !== undefined) {
      yield entryOf({
        path,
        kind: "symlink",
        key,
        header,
        limitations: [crcMismatchDetail(consumed.mismatch)],
        contentUnavailable: true,
      });
      return;
    }
    yield entryOf({
      path,
      kind: "symlink",
      key,
      header,
      limitations: [symlinkTargetLimitation(header, consumed.bytes)],
    });
  }

  #alias(
    path: string,
    key: string,
    header: CpioHeader,
    bytes: Buffer,
  ): ArtifactEntry {
    this.#aliases.set(key, bytes);
    const sourceIntegrity = this.#linkIntegrity.get(header.identity);
    if (sourceIntegrity !== undefined)
      this.#integrity.set(key, sourceIntegrity);
    return entryOf({
      path,
      kind: "file",
      key,
      header,
      size: bytes.length,
      limitations: [
        "Hard link: bytes are stored with another member of this archive.",
      ],
    });
  }

  *#unresolvedLinks(): Generator<ArtifactEntry> {
    for (const links of this.#pending.values())
      for (const { path, key, header } of links) {
        // A complete zero-length group establishes empty content. An orphan
        // that claims more links than appear is missing its bytes.
        const complete =
          links.length >= header.links &&
          links.every((m) => m.header.fileSize === 0);
        if (header.fileSize === 0 && complete) {
          const empty = Buffer.alloc(0);
          this.#aliases.set(key, empty);
          yield entryOf({
            path,
            kind: "file",
            key,
            header,
            size: 0,
            limitations: [
              "Hard link: every member of this link group is empty.",
            ],
          });
          continue;
        }
        yield entryOf({
          path,
          kind: "file",
          key,
          header,
          size: null,
          limitations: [UNRESOLVED_LINK],
          contentUnavailable: true,
        });
      }
    this.#pending.clear();
  }

  /** Finish the current member, then serve hard links that were waiting for it. */
  async *#finishCurrent(source: ByteSource): AsyncGenerator<ArtifactEntry> {
    const current = this.#current;
    if (current === undefined) return;
    this.#current = undefined;
    if (!this.#consumed) {
      if (this.#shouldKeep(current.header))
        this.#remember(
          current.header,
          await this.#collect(source, current.header, current.path),
        );
      else
        await drain(
          this.#verified(
            source,
            current.header,
            current.path,
            undefined,
            "fail",
          ),
        );
    }
    const waiting = this.#pending.get(current.header.identity);
    const stored = this.#links.get(current.header.identity);
    if (waiting === undefined || stored === undefined) return;
    this.#pending.delete(current.header.identity);
    for (const { path, key, header } of waiting)
      yield this.#alias(path, key, header, stored);
  }

  #shouldKeep(header: CpioHeader): boolean {
    return (
      (header.mode & S_IFMT) === S_IFREG &&
      header.links > 1 &&
      header.fileSize > 0 &&
      header.fileSize <= MAX_LINK_BUFFER_BYTES &&
      this.#buffered + header.fileSize <= MAX_LINK_BUFFER_TOTAL
    );
  }

  #remember(
    header: CpioHeader,
    bytes: Buffer,
    observations: readonly ArtifactChecksumObservation[] = [],
  ): void {
    if (this.#links.has(header.identity)) return;
    this.#links.set(header.identity, bytes);
    if (observations.length > 0)
      this.#linkIntegrity.set(header.identity, observations);
    this.#buffered += bytes.length;
  }

  /**
   * Member bytes and padding. `sum` receives the unsigned 32-bit total used
   * by `070702`. Padding is consumed before the caller reports a mismatch, so
   * a recovered archive stays aligned on the next header.
   */
  async *#payload(
    source: ByteSource,
    header: CpioHeader,
    sum: { value: number },
  ): AsyncGenerator<Buffer> {
    this.#cancelled();
    for await (const chunk of source.take(header.fileSize, "member data")) {
      this.#cancelled();
      if (header.format === "crc")
        for (const byte of chunk) sum.value = (sum.value + byte) >>> 0;
      yield chunk;
    }
    await drain(
      source.take(padding(header.format, header.fileSize), "data padding"),
    );
    this.#cancelled();
  }

  /**
   * One CRC check for every member kind. `fail` throws with the observation
   * in the message. record-and-continue returns the observation so callers
   * keep declared and observed values instead of catching a string.
   */
  #crcMismatch(
    header: CpioHeader,
    path: string,
    sum: number,
    policy: "fail" | "record-and-continue" = this.integrity,
  ): ArtifactChecksumObservation | undefined {
    if (header.format !== "crc" || sum === header.check) return undefined;
    const observation = crcObservation(header.check, sum);
    if (policy === "fail")
      throw new ArtifactReaderFailure(
        "integrity",
        `cpio CRC disagrees with content: ${path} (${crcMismatchDetail(observation)})`,
      );
    return observation;
  }

  /** Read one member fully. `collect` retains bytes for symlinks and hard links. */
  async #consume(
    source: ByteSource,
    header: CpioHeader,
    path: string,
    collect: boolean,
    policy?: "fail" | "record-and-continue",
  ): Promise<{
    readonly bytes: Buffer | undefined;
    readonly mismatch: ArtifactChecksumObservation | undefined;
  }> {
    const sum = { value: 0 };
    const chunks: Buffer[] = [];
    for await (const chunk of this.#payload(source, header, sum))
      if (collect) chunks.push(chunk);
    return {
      bytes: collect ? Buffer.concat(chunks) : undefined,
      mismatch: this.#crcMismatch(header, path, sum.value, policy),
    };
  }

  /** Member data and its padding, checked against a `070702` CRC. */
  async *#verified(
    source: ByteSource,
    header: CpioHeader,
    path: string,
    record?: (observation: ArtifactChecksumObservation) => void,
    policy?: "fail" | "record-and-continue",
  ): AsyncGenerator<Buffer> {
    const sum = { value: 0 };
    yield* this.#payload(source, header, sum);
    const mismatch = this.#crcMismatch(
      header,
      path,
      sum.value,
      policy ?? this.integrity,
    );
    if (mismatch !== undefined) record?.(mismatch);
  }

  async #collect(
    source: ByteSource,
    header: CpioHeader,
    path: string,
  ): Promise<Buffer> {
    // Unopened linked bytes are not a recovered occurrence. A disagreement
    // still fails the archive instead of being remembered as verified content.
    const consumed = await this.#consume(source, header, path, true, "fail");
    return consumed.bytes ?? Buffer.alloc(0);
  }

  #cancelled(): void {
    if (this.#signal?.aborted)
      throw new ArtifactReaderFailure(
        "cancelled",
        "cpio expansion was cancelled",
      );
  }

  open(entry: ArtifactEntry): Promise<Readable> {
    const alias = this.#aliases.get(entry.adapterKey);
    if (alias !== undefined) {
      this.decodedBudget.consume(alias.length, entry.path);
      return Promise.resolve(Readable.from([alias]));
    }
    const source = this.#source;
    const current = this.#current;
    if (
      source === undefined ||
      current === undefined ||
      current.key !== entry.adapterKey ||
      this.#consumed
    )
      return Promise.reject(
        new ArtifactReaderFailure(
          "unavailable",
          entry.contentUnavailable === true
            ? UNRESOLVED_LINK
            : "cpio members can be read only once, in archive order",
        ),
      );
    this.#consumed = true;
    const chunks = this.#verified(
      source,
      current.header,
      current.path,
      this.integrity === "record-and-continue"
        ? (observed) => this.#integrity.set(entry.adapterKey, [observed])
        : undefined,
    );
    if (!this.#shouldKeep(current.header))
      return Promise.resolve(Readable.from(chunks));
    // Keep a linked member's bytes for paths that share them.
    const kept: Buffer[] = [];
    const remember = (): void => {
      this.#remember(
        current.header,
        Buffer.concat(kept),
        this.#integrity.get(entry.adapterKey),
      );
    };
    return Promise.resolve(
      Readable.from(
        (async function* () {
          for await (const chunk of chunks) {
            kept.push(chunk);
            yield chunk;
          }
          remember();
        })(),
      ),
    );
  }

  provenance(): readonly ArtifactCommand[] {
    return [];
  }

  /** Completed member CRC evidence, including inherited hard-link source contradictions. */
  integrityObservations(
    entry: ArtifactEntry,
  ): readonly ArtifactChecksumObservation[] {
    return this.#integrity.get(entry.adapterKey) ?? [];
  }

  async close(): Promise<void> {
    await this.#source?.close();
    this.#source = undefined;
  }
}
