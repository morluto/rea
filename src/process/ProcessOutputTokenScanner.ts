import { isUtf8 } from "node:buffer";

/** One confirmed token with bounded context from its raw output stream. */
export interface ProviderProcessOutputToken {
  /** Byte offset since construction or reset of the owning supervisor. */
  readonly offset: number;
  readonly line: string;
  readonly truncated: boolean;
  readonly invalidUtf8?: true;
  /** True when the line's right edge is cut or its end has not been observed. */
  readonly trailingContextIncomplete?: true;
}

/** Immutable raw byte snapshot of a confirmed token before UTF-8 decoding. */
export interface RawProcessOutputToken {
  readonly offset: number;
  readonly prefix: Buffer | undefined;
  readonly suffix: Buffer;
  readonly truncated: boolean;
  readonly trailingContextIncomplete: boolean;
}

/** Decode an immutable raw token snapshot into its UTF-8 projection. */
export const materializeProcessOutputToken = (
  raw: RawProcessOutputToken,
): ProviderProcessOutputToken => {
  const bytes =
    raw.prefix === undefined
      ? raw.suffix
      : Buffer.concat([raw.prefix, raw.suffix]);
  return {
    offset: raw.offset,
    line: bytes.toString("utf8"),
    ...(!isUtf8(bytes) ? { invalidUtf8: true as const } : {}),
    truncated: raw.truncated,
    ...(raw.trailingContextIncomplete
      ? { trailingContextIncomplete: true as const }
      : {}),
  };
};
const PROCESS_OUTPUT_TOKEN_CONTEXT_BYTES = 1024;
const NEWLINE = 0x0a;
const isWordByte = (byte: number): boolean =>
  (byte >= 0x30 && byte <= 0x39) ||
  (byte >= 0x41 && byte <= 0x5a) ||
  (byte >= 0x61 && byte <= 0x7a) ||
  byte === 0x5f;
interface Match {
  readonly offset: number;
  readonly prefix: Buffer;
  readonly prefixCut: boolean;
  suffix: Buffer;
  open: boolean;
  suffixCut: boolean;
}
const EMPTY_BUFFER = Buffer.alloc(0);

/** Bounded literal token capture, delimited on the right by a non-ASCII-word byte or actual EOF. */
export class ProcessOutputTokenScanner {
  readonly #marker: Buffer;
  #lineTail: Buffer = EMPTY_BUFFER;
  #lineTailCut = false;
  #latest: Match | undefined;
  #pending: Match | undefined;
  constructor(marker: string) {
    if (marker.length === 0 || marker.includes("\n"))
      throw new RangeError("Output token must be non-empty single-line text");
    this.#marker = Buffer.from(marker, "utf8");
    if (!isWordByte(this.#marker[this.#marker.length - 1]!))
      throw new RangeError("Output token must end in an ASCII word byte");
  }

  scan(chunk: Buffer, start: number): void {
    if (chunk.length === 0) return;
    // The next byte can invalidate a pending prefix without erasing the last
    // confirmed token from an earlier line.

    if (this.#pending !== undefined) {
      if (!isWordByte(chunk[0]!)) this.#latest = this.#pending;
      this.#pending = undefined;
    }
    this.#extendOpenLine(chunk);
    const carried = this.#lineTail.byteLength;
    const markerLen = this.#marker.byteLength;
    let foundConfirmed = false;
    // Fast path: scan `chunk` directly without concatenating `#lineTail`.
    let index = chunk.lastIndexOf(this.#marker);
    while (index >= 0) {
      const end = index + markerLen;
      const isPending = end === chunk.byteLength;
      const isConfirmed = !isPending && !isWordByte(chunk[end]!);
      if (isPending || isConfirmed) {
        const hasNewlineBefore =
          carried === 0 ||
          (index > 0 && chunk.lastIndexOf(NEWLINE, index - 1) >= 0);
        const match = hasNewlineBefore
          ? this.#record(chunk, index, start)
          : this.#record(
              Buffer.concat([
                this.#lineTail,
                chunk.subarray(
                  0,
                  Math.min(
                    chunk.byteLength,
                    end + PROCESS_OUTPUT_TOKEN_CONTEXT_BYTES,
                  ),
                ),
              ]),
              carried + index,
              start - carried,
            );
        if (isPending) this.#pending = match;
        else {
          this.#latest = match;
          foundConfirmed = true;
          break;
        }
      }
      index = index === 0 ? -1 : chunk.lastIndexOf(this.#marker, index - 1);
    }
    if (!foundConfirmed && carried > 0) {
      // Only a match straddling the `#lineTail` / `chunk` seam remains possible.
      const seamEnd = Math.min(
        chunk.byteLength,
        markerLen + PROCESS_OUTPUT_TOKEN_CONTEXT_BYTES,
      );
      const seam = Buffer.concat([this.#lineTail, chunk.subarray(0, seamEnd)]);
      let seamIndex = seam.lastIndexOf(this.#marker, carried - 1);
      while (seamIndex >= 0 && seamIndex + markerLen > carried) {
        const end = seamIndex + markerLen;
        if (end === carried + chunk.byteLength)
          this.#pending = this.#record(seam, seamIndex, start - carried);
        else if (end < seam.byteLength && !isWordByte(seam[end]!)) {
          this.#latest = this.#record(seam, seamIndex, start - carried);
          break;
        }
        seamIndex =
          seamIndex === 0 ? -1 : seam.lastIndexOf(this.#marker, seamIndex - 1);
      }
    }
    this.#retainLineTail(chunk);
  }
  /** Only a true stream end proves the boundary of a trailing bare token. */
  finish(): void {
    if (this.#pending !== undefined) this.#latest = this.#pending;
    this.#pending = undefined;
    if (this.#latest !== undefined) this.#latest.open = false;
  }
  /** Capture event-time bytes and truncation flags without UTF-8 decoding. */
  snapshotLatestWithin(
    start: number,
    end: number,
  ): RawProcessOutputToken | undefined {
    const latest = this.#latest;
    if (latest === undefined || latest.offset < start || latest.offset >= end)
      return undefined;
    // Omit a prefix crossing the checkpoint in full: neither its old cause
    // text nor a credential fragment cut on the left belongs to this scope.
    const prefixInRange = latest.offset - latest.prefix.length >= start;
    return {
      offset: latest.offset,
      prefix: prefixInRange ? latest.prefix : undefined,
      suffix: latest.suffix,
      truncated: latest.prefixCut || latest.suffixCut || !prefixInRange,
      trailingContextIncomplete: latest.suffixCut || latest.open,
    };
  }

  latestWithin(
    start: number,
    end: number,
  ): ProviderProcessOutputToken | undefined {
    const raw = this.snapshotLatestWithin(start, end);
    return raw === undefined ? undefined : materializeProcessOutputToken(raw);
  }
  #record(searched: Buffer, index: number, searchedStart: number): Match {
    const lineStart =
      index === 0 ? 0 : searched.lastIndexOf(NEWLINE, index - 1) + 1;
    const prefixFits =
      index - lineStart <= PROCESS_OUTPUT_TOKEN_CONTEXT_BYTES &&
      (lineStart > 0 || !this.#lineTailCut);
    const lineEnd = searched.indexOf(NEWLINE, index);
    const available = lineEnd < 0 ? searched.byteLength : lineEnd;
    const suffixEnd = Math.min(
      available,
      index + this.#marker.byteLength + PROCESS_OUTPUT_TOKEN_CONTEXT_BYTES,
    );
    return {
      offset: searchedStart + index,
      prefix: prefixFits
        ? Buffer.from(searched.subarray(lineStart, index))
        : Buffer.alloc(0),
      prefixCut: !prefixFits,
      suffix: Buffer.from(searched.subarray(index, suffixEnd)),
      open: lineEnd < 0 && suffixEnd === available,
      suffixCut: suffixEnd < available,
    };
  }
  #extendOpenLine(chunk: Buffer): void {
    const latest = this.#latest;
    if (latest?.open !== true) return;
    const lineEnd = chunk.indexOf(NEWLINE);
    const available = lineEnd < 0 ? chunk.byteLength : lineEnd;
    const room =
      this.#marker.byteLength +
      PROCESS_OUTPUT_TOKEN_CONTEXT_BYTES -
      latest.suffix.byteLength;
    const taken = Math.min(available, Math.max(0, room));
    if (taken > 0)
      latest.suffix = Buffer.concat([latest.suffix, chunk.subarray(0, taken)]);
    latest.suffixCut = taken < available;
    latest.open = lineEnd < 0 && taken === available;
  }
  #retainLineTail(chunk: Buffer): void {
    const lineStart = chunk.lastIndexOf(NEWLINE) + 1;
    const limit =
      PROCESS_OUTPUT_TOKEN_CONTEXT_BYTES + this.#marker.byteLength - 1;
    if (lineStart === chunk.byteLength) {
      this.#lineTail = EMPTY_BUFFER;
      this.#lineTailCut = false;
      return;
    }
    if (lineStart > 0) {
      const len = chunk.byteLength - lineStart;
      this.#lineTailCut = len > limit;
      this.#lineTail = Buffer.from(
        chunk.subarray(Math.max(lineStart, chunk.byteLength - limit)),
      );
      return;
    }
    const total = this.#lineTail.byteLength + chunk.byteLength;
    this.#lineTailCut = total > limit || this.#lineTailCut;
    if (chunk.byteLength >= limit) {
      this.#lineTail = Buffer.from(chunk.subarray(chunk.byteLength - limit));
      return;
    }
    const keepFromTail = Math.min(
      this.#lineTail.byteLength,
      limit - chunk.byteLength,
    );
    const next = Buffer.allocUnsafe(keepFromTail + chunk.byteLength);
    if (keepFromTail > 0)
      this.#lineTail.copy(
        next,
        0,
        this.#lineTail.byteLength - keepFromTail,
        this.#lineTail.byteLength,
      );
    chunk.copy(next, keepFromTail);
    this.#lineTail = next;
  }
}
