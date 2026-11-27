import { Buffer } from "node:buffer";

/**
 * Streaming scanners for Flutter payload libraries inside an APK.
 *
 * All facts are observations of byte patterns at read time: the Dart
 * snapshot hash sits 20 bytes after each snapshot magic, the GNU build-id
 * is an ELF note, and version facts are ASCII strings. Nothing is inferred or
 * looked up externally.
 */

/** Magic starting every Dart VM and isolate snapshot section. */
export const DART_SNAPSHOT_MAGIC = Uint8Array.from([0xf5, 0xf5, 0xdc, 0xdc]);
const DART_SNAPSHOT_MAGIC_BUFFER = Buffer.from(DART_SNAPSHOT_MAGIC);
export const SNAPSHOT_HASH_OFFSET = 20;
export const SNAPSHOT_HASH_LENGTH = 32;
const SNAPSHOT_RECORD_BYTES = SNAPSHOT_HASH_OFFSET + SNAPSHOT_HASH_LENGTH;
const SNAPSHOT_HASH_PATTERN = /^[0-9a-f]{32}$/u;

const asBuffer = (bytes: Uint8Array): Buffer =>
  Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export const readDartSnapshotHash = (
  bytes: Uint8Array,
  snapshotOffset: number,
): string | null => {
  const start = snapshotOffset + SNAPSHOT_HASH_OFFSET;
  const candidate = asBuffer(bytes).toString(
    "latin1",
    start,
    start + SNAPSHOT_HASH_LENGTH,
  );
  return SNAPSHOT_HASH_PATTERN.test(candidate) ? candidate : null;
};

export interface SnapshotHashScan {
  /** Snapshot sections found. */
  readonly sources: number;
  readonly capped: boolean;
  /** Distinct 32-hex hashes following the magic, in first-seen order. */
  readonly candidates: readonly string[];
}

/**
 * Incremental scanner for Dart snapshot magics and the hash that follows.
 * Feed chunks in order; a trailing carry keeps a magic-to-hash span that a
 * chunk boundary would otherwise split.
 */
export class SnapshotHashScanner {
  /** Distinct hashes retained before the scan reports itself capped. */
  constructor(private readonly maximumCandidates = 64) {}

  #sources = 0;
  #capped = false;
  private readonly candidates: string[] = [];
  private readonly candidateSet = new Set<string>();
  #buffer: Buffer = Buffer.alloc(0);

  #recordCandidate(candidate: string | null): void {
    if (candidate === null) return;
    if (!this.candidateSet.has(candidate)) {
      if (this.candidates.length === this.maximumCandidates)
        this.#capped = true;
      else {
        this.candidateSet.add(candidate);
        this.candidates.push(candidate);
      }
    }
    // Only valid hash records count toward source agreement; a complete
    // magic record whose field is not lowercase hex is not a source.
    this.#sources += 1;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    const chunkBuf = asBuffer(chunk);
    // For small chunks (including bytewise streaming), scan the tiny joined
    // buffer directly with Buffer.indexOf; for large chunks, scan a bounded
    // seam across the boundary and then scan chunkBuf zero-copy.
    if (this.#buffer.length > 0 && chunkBuf.length < SNAPSHOT_RECORD_BYTES) {
      const joined = Buffer.concat(
        [this.#buffer, chunkBuf],
        this.#buffer.length + chunkBuf.length,
      );
      let offset = 0;
      let pendingMagic: number | null = null;
      for (;;) {
        const magic = joined.indexOf(DART_SNAPSHOT_MAGIC_BUFFER, offset);
        if (magic === -1) break;
        if (magic + SNAPSHOT_RECORD_BYTES > joined.length) {
          pendingMagic = magic;
          break;
        }
        this.#recordCandidate(readDartSnapshotHash(joined, magic));
        offset = magic + DART_SNAPSHOT_MAGIC.length;
      }
      const keepFrom =
        pendingMagic ??
        Math.max(0, joined.length - (DART_SNAPSHOT_MAGIC.length - 1));
      this.#buffer = Buffer.from(joined.subarray(keepFrom));
      return;
    }

    let chunkStart = 0;
    if (this.#buffer.length > 0) {
      const seamTail = SNAPSHOT_RECORD_BYTES - 1;
      const seam = Buffer.allocUnsafe(this.#buffer.length + seamTail);
      this.#buffer.copy(seam, 0);
      chunkBuf.copy(seam, this.#buffer.length, 0, seamTail);
      let offset = 0;
      while (offset < this.#buffer.length) {
        const magic = seam.indexOf(DART_SNAPSHOT_MAGIC_BUFFER, offset);
        if (magic === -1 || magic >= this.#buffer.length) break;
        this.#recordCandidate(readDartSnapshotHash(seam, magic));
        offset = magic + DART_SNAPSHOT_MAGIC.length;
      }
      if (offset > this.#buffer.length)
        chunkStart = offset - this.#buffer.length;
    }

    let offset = chunkStart;
    let pendingMagic: number | null = null;
    for (;;) {
      const magic = chunkBuf.indexOf(DART_SNAPSHOT_MAGIC_BUFFER, offset);
      if (magic === -1) break;
      if (magic + SNAPSHOT_RECORD_BYTES > chunkBuf.length) {
        pendingMagic = magic;
        break;
      }
      this.#recordCandidate(readDartSnapshotHash(chunkBuf, magic));
      offset = magic + DART_SNAPSHOT_MAGIC.length;
    }
    // Keep a pending magic for the next chunk; otherwise keep only the
    // trailing bytes where a magic could still begin, so magic-free
    // streams never accumulate.
    const keepFrom =
      pendingMagic ??
      Math.max(chunkStart, chunkBuf.length - (DART_SNAPSHOT_MAGIC.length - 1));
    this.#buffer = Buffer.from(chunkBuf.subarray(keepFrom));
  }

  result(): SnapshotHashScan {
    return {
      sources: this.#sources,
      candidates: [...this.candidates],
      capped: this.#capped,
    };
  }
}

/** Labeled strings worth reporting when a build carries them. */
export interface LabeledStringScan {
  readonly dartVersion: string | null;
  readonly dartVersionCapped: boolean;
  readonly toolchainLines: readonly string[];
  /** True when further distinct matching lines were observed past the cap. */
  readonly toolchainCapped: boolean;
}

const DART_VERSION_PATTERN = /^Dart VM version:[^\x00\n]{0,200}$/u;
/**
 * Unlabeled Dart `Version::String()` form embedded in release engines:
 * `<version> (<channel>) (<commit time>)` with optional ` on "<os>_<arch>"`.
 * Requires a channel token so ordinary dotted version text is ignored.
 */
const DART_EMBEDDED_VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)? \((?:stable|beta|dev|main)\) \([^)\x00\n]{1,80}\)(?: on "[a-z0-9._-]+")?$/u;
const TOOLCHAIN_PATTERN =
  /^(?:Android \([^)\x00\n]{0,80}\) clang version [^\x00\n]{0,500}|based on LLVM \d[^\x00\n]{0,80})$/u;
const MAX_TOOLCHAIN_LINES = 4;
/**
 * Carry spans chunk boundaries for either accepted pattern. The toolchain
 * pattern accepts up to 605 printable bytes (9 + 80 + 16 + 500), so the
 * carry must hold at least that to preserve a line split at a boundary.
 */
const CARRY_BYTES = 640;

/**
 * Incremental ASCII string collector that keeps Dart version and toolchain
 * facts. A match is committed only when a printable run is terminated by a
 * delimiter, so a value split across chunk boundaries is never committed
 * truncated; the carry holds the longest accepted match so boundaries in
 * either pattern survive.
 */
export class LabeledStringScanner {
  #dartVersion: string | null = null;
  #dartVersionCapped = false;
  private readonly toolchainLines: string[] = [];
  readonly #carry = Buffer.allocUnsafe(CARRY_BYTES);
  #carryLength = 0;
  private overflowed = false;
  #ended = false;
  #toolchainCapped = false;

  push(chunk: Uint8Array): void {
    const length = chunk.length;
    for (let i = 0; i < length; i += 1) {
      const byte = chunk[i]!;
      if (byte >= 0x20 && byte < 0x7f) {
        if (this.#carryLength < CARRY_BYTES)
          this.#carry[this.#carryLength++] = byte;
        else this.overflowed = true;
      } else if (this.#carryLength > 0) {
        this.#flushCarry();
      }
    }
  }

  /** Commit any retained tail, e.g. when the stream ends mid-string. */
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#carryLength > 0) this.#flushCarry();
  }

  #flushCarry(): void {
    const len = this.#carryLength;
    const first = this.#carry[0]!;
    this.#carryLength = 0;
    // Fast pre-filter: all accepted patterns begin with 'D', 'A', 'b', or '0'..'9'.
    if (
      first === 0x44 || // 'D' ("Dart VM version:")
      first === 0x41 || // 'A' ("Android (")
      first === 0x62 || // 'b' ("based on LLVM ")
      (first >= 0x30 && first <= 0x39) // '0'..'9' (embedded Dart version)
    ) {
      this.#consider(this.#carry.toString("latin1", 0, len));
    }
    this.overflowed = false;
  }

  #recordDartVersion(text: string, accepted: boolean): void {
    if (!accepted) {
      this.#dartVersionCapped = true;
      return;
    }
    if (this.#dartVersion === null) this.#dartVersion = text;
    else if (this.#dartVersion !== text) this.#dartVersionCapped = true;
  }

  #consider(text: string): void {
    // Keep a bounded prefix plus overflow state, never a sliding suffix.
    // Every accepted label must consume its whole printable run so a
    // pattern's shorter grammar cannot publish a fabricated prefix.
    if (text.startsWith("Dart VM version:")) {
      this.#recordDartVersion(
        text,
        !this.overflowed && DART_VERSION_PATTERN.test(text),
      );
      return;
    }
    if (DART_EMBEDDED_VERSION_PATTERN.test(text)) {
      this.#recordDartVersion(text, !this.overflowed);
      return;
    }
    if (!text.startsWith("Android (") && !text.startsWith("based on LLVM "))
      return;
    if (this.overflowed || !TOOLCHAIN_PATTERN.test(text)) {
      this.#toolchainCapped = true;
      return;
    }
    const line = text;
    if (this.toolchainLines.includes(line)) return;
    if (this.toolchainLines.length < MAX_TOOLCHAIN_LINES)
      this.toolchainLines.push(line);
    else this.#toolchainCapped = true;
  }

  result(): LabeledStringScan {
    if (!this.#ended) this.end();
    return {
      dartVersion: this.#dartVersion,
      dartVersionCapped: this.#dartVersionCapped,
      toolchainLines: [...this.toolchainLines],
      toolchainCapped: this.#toolchainCapped,
    };
  }
}
