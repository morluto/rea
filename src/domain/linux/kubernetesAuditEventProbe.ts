import { isRecord } from "../../kernel/isRecord.js";
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

/** Parse a complete object, with the same auditID and stage checks as the reader. */
const isAuditEventObject = (line: string): boolean => {
  try {
    const event: unknown = JSON.parse(line);
    return (
      isRecord(event) &&
      typeof event.auditID === "string" &&
      kubernetesAuditStageOf(event.stage) !== null
    );
  } catch {
    return false;
  }
};

/** Find the last complete top-level property before a clipped JSON object. */
const lastAuditProperty = (line: string): number => {
  let depth = 0;
  let inString = false;
  let separator = -1;
  for (let offset = 0; offset < line.length; offset += 1) {
    const character = line[offset];
    if (inString) {
      if (character === "\\") offset += 1;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) return -1;
    } else if (character === "," && depth === 1) separator = offset;
  }
  return separator;
};

/** Recognize only top-level audit facts on the first line. When the probe
 * ends inside that line, validate the completed properties before the cut. */
export const hasKubernetesAuditEvent = (
  prefix: Uint8Array,
  fileSize: number,
): boolean => {
  const start = firstAuditToken(prefix);
  if (prefix[start] !== 0x7b) return false;
  const newline = prefix.indexOf(0x0a, start);
  const complete = newline !== -1 || prefix.byteLength >= fileSize;
  let line: string;
  try {
    line = strictUtf8Decoder("preserve").decode(
      prefix.subarray(start, newline === -1 ? prefix.length : newline),
      { stream: !complete },
    );
  } catch {
    return false;
  }
  if (isAuditEventObject(line)) return true;
  if (complete) return false;
  const end = lastAuditProperty(line);
  return end !== -1 && isAuditEventObject(`${line.slice(0, end)}}`);
};

/** Byte allowance includes the optional newline following a maximum-sized line. */
const AUDIT_PROBE_BYTES = MAX_KUBERNETES_AUDIT_LINE_BYTES + 1;

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

/** Keep only a candidate first JSON line. The finished fact outlives these bytes. */
export class KubernetesAuditEventProbe {
  readonly #chunks: Buffer[] = [];
  #observed = 0;
  #recordStart: number | undefined;
  #done = false;

  get limit(): number {
    return this.#done ? this.#observed : AUDIT_PROBE_BYTES;
  }

  write(chunk: Uint8Array): void {
    if (this.#done || chunk.length === 0) return;
    const window = chunk.subarray(
      0,
      Math.min(chunk.length, this.limit - this.#observed),
    );
    const start = this.#recordStart === undefined ? firstAuditToken(window) : 0;
    const offset = this.#observed;
    this.#observed += window.length;
    if (start === window.length) return;
    if (this.#recordStart === undefined) {
      if (window[start] !== 0x7b) {
        this.#done = true;
        return;
      }
      this.#recordStart = offset + start;
    }
    const newline = window.indexOf(0x0a, start);
    this.#chunks.push(
      Buffer.from(
        window.subarray(start, newline === -1 ? window.length : newline + 1),
      ),
    );
    this.#done = newline !== -1 || this.#observed === AUDIT_PROBE_BYTES;
  }

  finish(fileSize: number): boolean | undefined {
    if (this.#recordStart === undefined) return undefined;
    return hasKubernetesAuditEvent(
      Buffer.concat(this.#chunks),
      fileSize - this.#recordStart,
    );
  }
}
