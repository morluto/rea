import { getManyValues, isMany, none, type Many } from "stream-chain/defs.js";
import { jsonParser, type Token } from "stream-json/core/parser.js";
import { MAX_KUBERNETES_AUDIT_LINE_BYTES } from "../artifactReaderLimits.js";
import { strictUtf8Decoder } from "../strictUtf8.js";

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

/** Byte allowance includes the optional newline after the first record. */
const AUDIT_PROBE_BYTES = MAX_KUBERNETES_AUDIT_LINE_BYTES + 1;
/** Each tokenizer call may emit several token fragments per input byte. */
const TOKEN_CHUNK_BYTES = 64 * 1024;
const IDENTITY_TOKEN_LIMIT = Math.max(
  "auditID".length,
  "stage".length,
  ...KUBERNETES_AUDIT_STAGES.map((stage) => stage.length),
);

const firstAuditToken = (bytes: Uint8Array): number => {
  let index = 0;
  while (
    bytes[index] === 0x20 ||
    bytes[index] === 0x09 ||
    bytes[index] === 0x0d
  )
    index += 1;
  return index;
};

export const kubernetesAuditNeedsMore = (
  prefix: Uint8Array,
  fileSize: number,
): boolean => {
  if (
    prefix.length === 0 ||
    prefix.length >= Math.min(fileSize, AUDIT_PROBE_BYTES)
  )
    return false;
  const start = firstAuditToken(prefix);
  return (
    start === prefix.length ||
    (prefix[start] === 0x7b && prefix.indexOf(0x0a, start) === -1)
  );
};

/** Query the same top-level identity from a prefix or an extended source. */
export const hasKubernetesAuditEvent = (
  prefix: Uint8Array,
  fileSize: number,
): boolean => {
  if (prefix[firstAuditToken(prefix)] !== 0x7b) return false;
  const probe = new KubernetesAuditEventProbe();
  probe.write(prefix);
  return probe.finish(fileSize) === true;
};

type AuditIdentityField = "auditID" | "stage";
/** The tokenizer is flushable with `none`, which its string-only type omits. */
type AuditJsonTokenizer = (
  value: string | typeof none,
) => Many<Token> | typeof none;

/** Inspect the first JSON line without assembling its body or its values.
 * A finished line must be valid JSON; a clipped prefix retains only complete
 * top-level audit fields. The actual reader separately admits and decodes the
 * record under the caller's line allowance.
 */
export class KubernetesAuditEventProbe {
  #decoder: TextDecoder | undefined;
  #tokens: AuditJsonTokenizer | undefined;
  #observed = 0;
  #lineEnded = false;
  #done = false;
  #failed = false;
  #depth = 0;
  #field: AuditIdentityField | undefined;
  #capture: "key" | "stage" | undefined;
  // not-an-allowance: text longer than every recognized key or stage cannot match.
  #text = "";
  #hasAuditId = false;
  #hasStage = false;

  get limit(): number {
    return this.#done ? this.#observed : AUDIT_PROBE_BYTES;
  }

  write(chunk: Uint8Array): void {
    if (this.#done || chunk.length === 0) return;
    const window = chunk.subarray(
      0,
      Math.min(chunk.length, this.limit - this.#observed),
    );
    this.#observed += window.length;
    const newline = window.indexOf(0x0a);
    this.#lineEnded = newline !== -1;
    const line = newline === -1 ? window : window.subarray(0, newline);
    this.#done = this.#lineEnded || this.#observed === AUDIT_PROBE_BYTES;
    if (this.#decoder === undefined) {
      const start = firstAuditToken(line);
      if (start === line.length) return;
      if (line[start] !== 0x7b) {
        this.#done = true;
        return;
      }
      this.#decoder = strictUtf8Decoder("preserve");
      this.#tokens = jsonParser({
        packValues: false,
        streamValues: true,
      }) as AuditJsonTokenizer;
    }
    try {
      for (let offset = 0; offset < line.length; offset += TOKEN_CHUNK_BYTES) {
        const decoded = this.#decoder.decode(
          line.subarray(offset, offset + TOKEN_CHUNK_BYTES),
          { stream: true },
        );
        this.#feed(decoded);
      }
    } catch {
      this.#failed = true;
      this.#done = true;
    }
  }

  finish(fileSize: number): boolean | undefined {
    if (this.#decoder === undefined) return undefined;
    if (this.#failed) return false;
    if (this.#lineEnded || this.#observed >= fileSize)
      try {
        this.#feed(this.#decoder.decode());
        this.#feed(none);
      } catch {
        return false;
      }
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
