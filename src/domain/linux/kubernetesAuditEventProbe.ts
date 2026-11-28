import { getManyValues, isMany, none, type Many } from "stream-chain/defs.js";
import { jsonParser, type Token } from "stream-json/core/parser.js";
import { MAX_KUBERNETES_AUDIT_LINE_BYTES } from "../artifactReaderLimits.js";
import { isHostLimitFailure } from "../parseFailure.js";
import { strictUtf8Decoder } from "../strictUtf8.js";
import {
  isTokenizerDepth,
  KUBERNETES_AUDIT_JSON_DEPTH,
} from "./kubernetesAuditRecord.js";

/** The stages one request's `auditID` can pass through, in Kubernetes' order. */
export const KUBERNETES_AUDIT_STAGES = [
  "RequestReceived",
  "ResponseStarted",
  "ResponseComplete",
  "Panic",
] as const;
export type KubernetesAuditStage = (typeof KUBERNETES_AUDIT_STAGES)[number];

export const kubernetesAuditStageOf = (
  value: unknown,
): KubernetesAuditStage | null =>
  KUBERNETES_AUDIT_STAGES.find((stage) => stage === value) ?? null;

/** Leading blank lines and JSON whitespace do not shrink the first record. */
const PREAMBLE_BYTES = MAX_KUBERNETES_AUDIT_LINE_BYTES;
/** Byte allowance includes the optional newline after the first record. */
const RECORD_BYTES = MAX_KUBERNETES_AUDIT_LINE_BYTES + 1;
/** Each tokenizer call may emit several token fragments per input byte. */
const TOKEN_CHUNK_BYTES = 64 * 1024;
const IDENTITY_TOKEN_LIMIT = Math.max(
  "auditID".length,
  "stage".length,
  ...KUBERNETES_AUDIT_STAGES.map((stage) => stage.length),
);

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

export const kubernetesAuditNeedsMore = (
  prefix: Uint8Array,
  fileSize: number,
): boolean => {
  if (prefix.length === 0 || prefix.length >= fileSize) return false;
  const probe = new KubernetesAuditEventProbe();
  probe.write(prefix);
  return probe.pending;
};

/** Query the same top-level identity from a prefix or an extended source. */
export const hasKubernetesAuditEvent = (
  prefix: Uint8Array,
  fileSize: number,
): boolean => {
  const probe = new KubernetesAuditEventProbe();
  probe.write(prefix);
  return probe.finish(fileSize) === true;
};

type AuditIdentityField = "auditID" | "stage";
/** The tokenizer is flushable with `none`, which its string-only type omits. */
type AuditJsonTokenizer = (
  value: string | typeof none,
) => Many<Token> | typeof none;

/**
 * Inspect the first non-empty JSON line without assembling its body or its
 * values. Empty lines, JSON whitespace, and one U+FEFF at the start of a
 * line are padding, the same bytes the reader ignores. A finished line must
 * be valid JSON; a clipped
 * prefix retains only complete top-level audit fields. Padding and the first
 * record each have their own allowance, so blank lines do not shrink the
 * record window. The reader admits and decodes the record under the caller's
 * line allowance.
 */
export class KubernetesAuditEventProbe {
  #decoder: TextDecoder | undefined;
  #tokens: AuditJsonTokenizer | undefined;
  #observed = 0;
  /** File offset of the first record's `{`, once padding has ended. */
  #recordStart: number | undefined;
  #lineEnded = false;
  #done = false;
  #failed = false;
  #depthStopped = false;
  /** Decoded slices of the first record, kept only to reread a depth overflow. */
  #recordSlices: string[] = [];
  #preamble = true;
  #atLineStart = true;
  #bomMatched = 0;
  #depth = 0;
  #field: AuditIdentityField | undefined;
  #capture: "key" | "stage" | undefined;
  // not-an-allowance: text longer than every recognized key or stage cannot match.
  #text = "";
  #hasAuditId = false;
  #hasStage = false;

  get limit(): number {
    if (this.#done) return this.#observed;
    if (this.#recordStart === undefined) return PREAMBLE_BYTES + RECORD_BYTES;
    return this.#recordStart + RECORD_BYTES;
  }

  /** Another byte of this file could still change the format decision. */
  get pending(): boolean {
    return !this.#done;
  }

  write(chunk: Uint8Array): void {
    if (this.#done || chunk.length === 0) return;
    let input = chunk;
    if (this.#preamble) {
      const room = Math.max(0, PREAMBLE_BYTES - this.#observed);
      const take = Math.min(input.length, room);
      if (take > 0) {
        const window = input.subarray(0, take);
        const before = this.#observed;
        this.#observed += window.length;
        input = input.subarray(take);
        const offset = this.#consumePreamble(window);
        if (this.#done) return;
        if (!this.#preamble) {
          this.#recordStart = before + offset;
          this.#consumeRecord(window.subarray(offset));
        }
      }
      if (this.#preamble) {
        if (this.#observed < PREAMBLE_BYTES || input.length === 0) return;
        if (input[0] !== 0x7b) {
          this.#done = true;
          return;
        }
        this.#preamble = false;
        this.#atLineStart = false;
        this.#recordStart = this.#observed;
      } else if (this.#done || input.length === 0) return;
    }
    const room = this.limit - this.#observed;
    if (room <= 0) {
      this.#done = true;
      return;
    }
    const rest = input.subarray(0, Math.min(input.length, room));
    this.#observed += rest.length;
    this.#consumeRecord(rest);
  }

  /** Tokenize the first record. `bytes` are already included in `#observed`. */
  #consumeRecord(bytes: Uint8Array): void {
    if (this.#done || bytes.length === 0) return;
    const newline = bytes.indexOf(0x0a);
    if (newline !== -1) this.#lineEnded = true;
    const line = newline === -1 ? bytes : bytes.subarray(0, newline);
    if (
      this.#lineEnded ||
      (this.#recordStart !== undefined &&
        this.#observed >= this.#recordStart + RECORD_BYTES)
    )
      this.#done = true;
    if (line.length === 0) return;
    if (this.#decoder === undefined) {
      this.#decoder = strictUtf8Decoder("preserve");
      this.#tokens = jsonParser({
        packValues: false,
        packKeys: false,
        packStrings: false,
        packNumbers: false,
        streamValues: true,
        maxDepth: KUBERNETES_AUDIT_JSON_DEPTH,
      }) as AuditJsonTokenizer;
    }
    try {
      for (let start = 0; start < line.length; start += TOKEN_CHUNK_BYTES) {
        const decoded = this.#decoder.decode(
          line.subarray(start, start + TOKEN_CHUNK_BYTES),
          { stream: true },
        );
        // Chunks keep ordinary lines cheap. A depth overflow drops only the
        // tokens inside the chunk that overflowed; that chunk is reread one
        // code unit at a time when identity is not already known.
        for (let index = 0; index < decoded.length;) {
          const end = Math.min(decoded.length, index + 4096);
          const slice = decoded.slice(index, end);
          this.#recordSlices.push(slice);
          try {
            this.#feed(slice);
          } catch (cause: unknown) {
            if (isHostLimitFailure(cause)) throw cause;
            if (!isTokenizerDepth(cause)) {
              this.#failed = true;
              this.#done = true;
              this.#recordSlices.length = 0;
              return;
            }
            this.#rereadRecord();
            this.#failed = !this.#depthStopped;
            this.#done = true;
            this.#recordSlices.length = 0;
            return;
          }
          index = end;
        }
      }
      if (this.#done) this.#recordSlices.length = 0;
    } catch (cause: unknown) {
      if (isHostLimitFailure(cause)) throw cause;
      this.#failed = true;
      this.#done = true;
      this.#recordSlices.length = 0;
    }
  }

  /**
   * The overflowed chunk's tokens were discarded. Reread the first record from
   * its start so identity that shared that chunk is still observed.
   */
  #rereadRecord(): void {
    const failed = this.#recordSlices.pop() ?? "";
    const prior = this.#recordSlices.splice(0);
    this.#depth = 0;
    this.#hasAuditId = false;
    this.#hasStage = false;
    this.#field = undefined;
    this.#capture = undefined;
    this.#text = "";
    this.#tokens = jsonParser({
      packValues: false,
      packKeys: false,
      packStrings: false,
      packNumbers: false,
      streamValues: true,
      maxDepth: KUBERNETES_AUDIT_JSON_DEPTH,
    }) as AuditJsonTokenizer;
    for (const slice of prior) this.#feed(slice);
    for (let index = 0; index < failed.length; index += 1) {
      try {
        this.#feed(failed.charAt(index));
      } catch (cause: unknown) {
        if (isHostLimitFailure(cause)) throw cause;
        this.#depthStopped = this.#hasAuditId && this.#hasStage;
        return;
      }
    }
    this.#depthStopped = this.#hasAuditId && this.#hasStage;
  }

  /**
   * Skip blank lines and one leading U+FEFF. Return the index of the record's
   * `{`, or the end of `bytes` while the preamble continues.
   */
  #consumePreamble(bytes: Uint8Array): number {
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index]!;
      if (this.#bomMatched > 0) {
        const expected = UTF8_BOM[this.#bomMatched];
        if (expected === undefined || byte !== expected) {
          this.#done = true;
          return index;
        }
        this.#bomMatched += 1;
        if (this.#bomMatched === UTF8_BOM.length) {
          this.#bomMatched = 0;
          this.#atLineStart = false;
        }
        continue;
      }
      if (byte === 0x0a) {
        this.#atLineStart = true;
        continue;
      }
      if (byte === 0x20 || byte === 0x09 || byte === 0x0d) {
        this.#atLineStart = false;
        continue;
      }
      if (byte === UTF8_BOM[0] && this.#atLineStart) {
        this.#bomMatched = 1;
        continue;
      }
      if (byte === 0x7b) {
        this.#preamble = false;
        this.#atLineStart = false;
        return index;
      }
      this.#done = true;
      return index;
    }
    return bytes.length;
  }

  finish(fileSize: number): boolean | undefined {
    const decided =
      this.#failed ||
      this.#depthStopped ||
      this.#lineEnded ||
      this.#done ||
      this.#observed >= fileSize;
    if (decided) this.#recordSlices.length = 0;
    if (this.#decoder === undefined) return undefined;
    if (this.#failed) return false;
    if (this.#depthStopped) return this.#hasAuditId && this.#hasStage;
    if (this.#lineEnded || this.#observed >= fileSize)
      try {
        this.#feed(this.#decoder.decode());
        this.#feed(none);
      } catch {
        return false;
      }
    else if (!this.#done) return undefined;
    return this.#hasAuditId && this.#hasStage;
  }

  #feed(value: string | typeof none): void {
    const tokens = this.#tokens?.(value);
    if (isMany(tokens))
      for (const token of getManyValues(tokens)) this.#consume(token);
  }

  #consume(token: Token): void {
    if (token.name === "startObject" || token.name === "startArray") {
      if (this.#depth === 1) this.#field = undefined;
      this.#depth += 1;
      return;
    }
    if (token.name === "endObject" || token.name === "endArray") {
      this.#depth -= 1;
      return;
    }
    if (this.#depth !== 1) return;
    switch (token.name) {
      case "startKey":
        this.#capture = "key";
        this.#text = "";
        break;
      case "endKey":
        this.#field =
          this.#text === "auditID" || this.#text === "stage"
            ? this.#text
            : undefined;
        // A duplicate top-level key replaces the previous observation, just
        // as it does when the complete line is parsed by the reader.
        if (this.#field === "auditID") this.#hasAuditId = false;
        if (this.#field === "stage") this.#hasStage = false;
        this.#capture = undefined;
        break;
      case "startString":
        if (this.#field === "stage") {
          this.#capture = "stage";
          this.#text = "";
        }
        break;
      case "stringChunk":
        if (
          this.#capture !== undefined &&
          this.#text.length <= IDENTITY_TOKEN_LIMIT
        )
          this.#text += token.value.slice(
            0,
            IDENTITY_TOKEN_LIMIT + 1 - this.#text.length,
          );
        break;
      case "endString":
        if (this.#field === "auditID") this.#hasAuditId = true;
        if (this.#field === "stage")
          this.#hasStage = kubernetesAuditStageOf(this.#text) !== null;
        this.#capture = undefined;
        this.#field = undefined;
        break;
      case "startNumber":
      case "nullValue":
      case "trueValue":
      case "falseValue":
        this.#field = undefined;
        break;
      case "endNumber":
      case "numberChunk":
      case "whitespace":
      // Packed value tokens are disabled in the tokenizer configuration.
      case "keyValue":
      case "numberValue":
      case "stringValue":
        break;
    }
  }
}
