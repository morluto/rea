import { Buffer } from "node:buffer";

/**
 * Streaming scanners for Flutter payload libraries inside an APK.
 *
 * All facts are observations of byte patterns at read time: the Dart
 * snapshot hash sits 20 bytes after each snapshot magic, the GNU build-id
 * is an ELF note, and engine strings are retained only when they fit a
 * complete recognized format. Nothing is inferred or looked up externally.
 */

/** First index of `needle` in `haystack` at or after `from`, or -1. */
const findBytes = (
  haystack: Uint8Array,
  needle: Uint8Array,
  from: number,
): number => {
  if (needle.length === 0) return from;
  const last = haystack.length - needle.length;
  for (let index = from; index <= last; index += 1) {
    let matched = true;
    for (let probe = 0; probe < needle.length; probe += 1) {
      if (haystack[index + probe] !== needle[probe]) {
        matched = false;
        break;
      }
    }
    if (matched) return index;
  }
  return -1;
};

/** Magic starting every Dart VM and isolate snapshot section. */
export const DART_SNAPSHOT_MAGIC = Uint8Array.from([0xf5, 0xf5, 0xdc, 0xdc]);
export const SNAPSHOT_HASH_OFFSET = 20;
export const SNAPSHOT_HASH_LENGTH = 32;
export const SNAPSHOT_HASH_PATTERN = /^[0-9a-f]{32}$/u;

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
/** Hard cap on distinct hashes retained before partial coverage reports. */
export const MAX_SNAPSHOT_HASH_CANDIDATES = 64;

export class SnapshotHashScanner {
  #sources = 0;
  #capped = false;
  private readonly candidates: string[] = [];
  private readonly candidateSet = new Set<string>();
  #buffer = new Uint8Array(0);

  push(chunk: Uint8Array): void {
    const joined = new Uint8Array(this.#buffer.length + chunk.length);
    joined.set(this.#buffer, 0);
    joined.set(chunk, this.#buffer.length);
    // Carried bytes are an unprocessed pending magic or too short to hold a
    // magic, so rescanning them never counts a record twice. Within a chunk
    // the scan resumes after each magic, so a magic inside a previous
    // record's span is found wherever the chunk boundaries fall.
    let offset = 0;
    let pendingMagic: number | null = null;
    for (;;) {
      const magic = findBytes(joined, DART_SNAPSHOT_MAGIC, offset);
      if (magic === -1) break;
      if (magic + SNAPSHOT_HASH_OFFSET + SNAPSHOT_HASH_LENGTH > joined.length) {
        pendingMagic = magic;
        break;
      }
      const candidate = Buffer.from(
        joined.slice(
          magic + SNAPSHOT_HASH_OFFSET,
          magic + SNAPSHOT_HASH_OFFSET + SNAPSHOT_HASH_LENGTH,
        ),
      ).toString("latin1");
      const isValidHash = SNAPSHOT_HASH_PATTERN.test(candidate);
      if (isValidHash && !this.candidateSet.has(candidate)) {
        if (this.candidates.length === MAX_SNAPSHOT_HASH_CANDIDATES)
          this.#capped = true;
        else {
          this.candidateSet.add(candidate);
          this.candidates.push(candidate);
        }
      }
      // Only valid hash records count toward source agreement; a complete
      // magic record whose field is not lowercase hex is not a source.
      if (isValidHash) this.#sources += 1;
      offset = magic + DART_SNAPSHOT_MAGIC.length;
    }
    // Keep a pending magic for the next chunk; otherwise keep only the
    // trailing bytes where a magic could still begin, so magic-free
    // streams never accumulate.
    const keepFrom =
      pendingMagic ??
      Math.max(0, joined.length - (DART_SNAPSHOT_MAGIC.length - 1));
    this.#buffer = joined.slice(keepFrom);
  }

  result(): SnapshotHashScan {
    return {
      sources: this.#sources,
      candidates: [...this.candidates],
      capped: this.#capped,
    };
  }
}

/** Engine strings worth reporting when a build carries them. */
export interface FlutterEngineStringScan {
  readonly dartVersion: string | null;
  readonly dartVersionCapped: boolean;
  readonly toolchainLines: readonly string[];
  /** True when further distinct matching lines were observed past the cap. */
  readonly toolchainCapped: boolean;
}

const DART_LABELED_VERSION_PATTERN = /^Dart VM version:[^\x00\n]{0,200}$/u;
// Dart version_in.cc supplies the current channelled and legacy channel-less
// templates; tools/utils.py defines each era's constrained version tokens.
const DART_VERSION_NUMBER = "(?:0|[1-9]\\d{0,8})";
const DART_VERSION_CORE = `${DART_VERSION_NUMBER}\\.${DART_VERSION_NUMBER}\\.${DART_VERSION_NUMBER}`;
// Legacy Version::String tokens place "dev" before the numeric prerelease.
const DART_VERSION_TOKEN = `${DART_VERSION_CORE}(?:-dev\\.${DART_VERSION_NUMBER}\\.${DART_VERSION_NUMBER}|-edge(?:\\.(?:[0-9a-f]{40}|${DART_VERSION_NUMBER}))?)?`;
const DART_BUILD_TIME =
  "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:0[1-9]|[12][0-9]|3[01]| [1-9]) (?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9] \\d{4} [+-]\\d{4}";
const DART_PLATFORM = "[a-z][a-z0-9]{0,15}_(?:sim)?[a-z][a-z0-9]{0,15}";
// Current channelled builds repeat beta/dev after the version prerelease.
const DART_CHANNELLED_VERSION = `(?:${DART_VERSION_CORE} \\(stable\\)|${DART_VERSION_CORE}-${DART_VERSION_NUMBER}\\.${DART_VERSION_NUMBER}\\.(beta|dev) \\(\\1\\)|${DART_VERSION_CORE}-edge(?:\\.(?:[0-9a-f]{40}|${DART_VERSION_NUMBER}))? \\((?:main|be)\\))`;
const DART_VERSION_STRING_PATTERN = new RegExp(
  `^(?:${DART_CHANNELLED_VERSION} \\(${DART_BUILD_TIME}\\)(?: on "${DART_PLATFORM}")?|${DART_VERSION_TOKEN} \\(${DART_BUILD_TIME}\\) on "${DART_PLATFORM}")$`,
  "u",
);
const MAX_DART_VERSION_STRING_LENGTH = 192;
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
 * Incremental ASCII string collector that keeps only recognized Dart
 * version and toolchain facts. A match is committed only when a printable
 * run is terminated by a delimiter, so a value split across chunk
 * boundaries is never committed truncated.
 */
export class FlutterEngineStringScanner {
  #dartVersion: string | null = null;
  #dartVersionCapped = false;
  private readonly toolchainLines: string[] = [];
  private carry = "";
  private overflowed = false;
  #ended = false;
  #toolchainCapped = false;

  push(chunk: Uint8Array): void {
    for (const byte of chunk) {
      if (byte >= 0x20 && byte < 0x7f) {
        if (this.carry.length < CARRY_BYTES)
          this.carry += String.fromCharCode(byte);
        else this.overflowed = true;
      } else {
        this.#consider(this.carry);
        this.carry = "";
        this.overflowed = false;
      }
    }
  }

  /** Commit any retained tail, e.g. when the stream ends mid-string. */
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#consider(this.carry);
    this.carry = "";
    this.overflowed = false;
  }

  #recordDartVersion(text: string): void {
    if (this.#dartVersion === null) this.#dartVersion = text;
    else if (this.#dartVersion !== text) this.#dartVersionCapped = true;
  }

  #consider(text: string): void {
    // Keep a bounded prefix plus overflow state, never a sliding suffix.
    // Every accepted version must consume its whole printable run so a
    // shorter grammar cannot publish a fabricated prefix.
    if (text.startsWith("Dart VM version:")) {
      if (this.overflowed || !DART_LABELED_VERSION_PATTERN.test(text))
        this.#dartVersionCapped = true;
      else this.#recordDartVersion(text);
      return;
    }
    if (
      !this.overflowed &&
      text.length <= MAX_DART_VERSION_STRING_LENGTH &&
      DART_VERSION_STRING_PATTERN.test(text)
    ) {
      this.#recordDartVersion(text);
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

  result(): FlutterEngineStringScan {
    if (!this.#ended) this.end();
    return {
      dartVersion: this.#dartVersion,
      dartVersionCapped: this.#dartVersionCapped,
      toolchainLines: [...this.toolchainLines],
      toolchainCapped: this.#toolchainCapped,
    };
  }
}
