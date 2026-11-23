import { escapeJsonPointerToken } from "../../domain/jsonPointer.js";
import { isSafeNumber, type LosslessNumber } from "lossless-json";
import type { WebNetworkCaptureRecord } from "../../domain/webNetworkCapture.js";
import { parseRecordedTransportUrl } from "../../domain/recordedTransportUrl.js";
import {
  explicitUtf8Spellings,
  explicitValuesOccurIn,
  isTransportCredentialHeader,
  TRANSPORT_CREDENTIAL_HEADERS,
} from "../../domain/explicitSensitiveValues.js";

type Redaction = WebNetworkCaptureRecord["redactions"][number];
type TransportUrlContext = { readonly credentialBaseUrl?: string };
/** Match an ASCII header name without allocating a potentially enormous line. */
export const isCaptureCredentialHeaderBytes = (
  bytes: Uint8Array,
  start: number,
  end: number,
): boolean => {
  for (const name of TRANSPORT_CREDENTIAL_HEADERS) {
    if (end - start !== name.length) continue;
    let matches = true;
    for (let index = 0; index < name.length; index++) {
      const byte = bytes[start + index]!;
      const lower = byte >= 65 && byte <= 90 ? byte + 32 : byte;
      if (lower !== name.charCodeAt(index)) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
};

/** Literal redaction and structural authentication exclusions preserve unrelated local evidence. */
export class CaptureRedaction {
  readonly redactions: Redaction[] = [];
  readonly #sensitiveByteValues: readonly Buffer[];
  readonly #requestUrl: string | undefined;
  constructor(
    readonly sensitiveValues: readonly string[],
    source?: unknown,
  ) {
    const request =
      captureObject(source) && captureObject(source.request)
        ? source.request
        : undefined;
    this.#requestUrl =
      typeof request?.url === "string" ? request.url : undefined;
    this.#sensitiveByteValues = explicitUtf8Spellings(sensitiveValues);
  }

  /** Preserve exact text unless explicitly sensitive or known transport URL userinfo. */
  text(
    value: string,
    pointer: string,
    transportUrl?: TransportUrlContext,
  ): string | null {
    let result = value;
    if (transportUrl !== undefined) {
      const { credentials } = parseRecordedTransportUrl(value, transportUrl);
      if (credentials === "ambiguous") return this.credential(pointer);
      if (credentials !== null) {
        result = `${value.slice(0, credentials.start)}${value.slice(credentials.end)}`;
        this.redactions.push({ pointer, reason: "transport-credential" });
      }
    }
    if (
      this.sensitiveValues.length > 0 &&
      (explicitValuesOccurIn(value, this.sensitiveValues) ||
        (result !== value &&
          explicitValuesOccurIn(result, this.sensitiveValues)))
    ) {
      this.redactions.push({ pointer, reason: "explicit-sensitive-value" });
      return null;
    }
    return result;
  }

  /** Remove a credential field's value without retaining its digest or encoded form. */
  credential(pointer: string): null {
    this.redactions.push({ pointer, reason: "transport-credential" });
    return null;
  }

  /** Check both retained spellings before projecting a producer JSON number. */
  number(
    value: LosslessNumber,
    pointer: string,
  ): { reported: number | null; literal: string } | null {
    const reported = isSafeNumber(value.value) ? Number(value.value) : null;
    if (
      this.text(value.value, pointer) === null ||
      (reported !== null && this.text(String(reported), pointer) === null)
    )
      return null;
    return { reported, literal: value.value };
  }

  /** Known HAR credential surfaces; unknown extensions are ordinary caller-selected evidence. */
  harCredential(
    pointer: string,
    parent: Readonly<Record<string, unknown>>,
  ): boolean {
    return (
      (/^\/(request|response)\/headers\/\d+\/value$/.test(pointer) &&
        typeof parent.name === "string" &&
        isTransportCredentialHeader(parent.name)) ||
      /^\/(request|response)\/cookies\/\d+\/value$/.test(pointer)
    );
  }

  /** Only actual request/redirect fields and known transport header URLs declare URL semantics. */
  harTransportUrl(
    pointer: string,
    parent?: Readonly<Record<string, unknown>>,
  ): TransportUrlContext | undefined {
    const header = /^\/(request|response)\/headers\/\d+\/value$/.test(pointer)
      ? typeof parent?.name === "string"
        ? parent.name.toLowerCase()
        : undefined
      : undefined;
    if (pointer === "/response/redirectURL" || header === "location")
      return this.#requestUrl === undefined
        ? {}
        : { credentialBaseUrl: this.#requestUrl };
    return pointer === "/request/url" ||
      header === "referer" ||
      header === "origin"
      ? {}
      : undefined;
  }

  /** Preserve bytes unless an explicitly declared UTF-8 literal occurs in them. */
  sensitiveBytes(bytes: Buffer): boolean {
    return this.#sensitiveByteValues.some((value) => bytes.includes(value));
  }
}

import { isRecord } from "../../kernel/isRecord.js";

/** Escape a producer property for an RFC 6901 location. */
export const capturePointer = (parent: string, key: string): string =>
  `${parent}/${escapeJsonPointerToken(key)}`;

/** Structural record guard does not duck-type number/byte sidecar markers. */
export const captureObject = isRecord;
