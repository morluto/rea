import { Budget } from "../../domain/budget.js";
import { escapeJsonPointerToken } from "../../domain/jsonPointer.js";
import { captureBudgets } from "./CaptureBudgets.js";
import { LosslessNumber } from "lossless-json";
import { CaptureFormatError } from "./CaptureFormatError.js";
import { decodeStrictUtf8 } from "../../domain/strictUtf8.js";
import { WEB_NETWORK_CAPTURE_LIMITS } from "../../domain/webNetworkCapture.js";

export type CaptureJsonFormat = "HAR" | "qlog" | "Playwright trace";

export type SelectiveCaptureJsonResult =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "skipped"; readonly type: string };

export interface SelectiveCaptureJsonOptions {
  readonly maximumNodes?: number;
  readonly beforeMaterialize?: () => void;
}

const HEX_DIGITS = 4;

const hexValue = (code: number): number => {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x37;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  return -1;
};

const detachSlice = (
  text: string,
  start: number,
  end: number,
  latin1: boolean,
): string => {
  const length = end - start;
  if (length === 0) return "";
  if (length < 13) return text.slice(start, end);
  const encoding = latin1 ? "latin1" : "utf16le";
  return Buffer.from(text.slice(start, end), encoding).toString(encoding);
};

const detachAsciiSlice = (text: string, start: number, end: number): string => {
  const length = end - start;
  if (length === 0) return "";
  if (length < 13) return text.slice(start, end);
  return Buffer.from(text.slice(start, end), "latin1").toString("latin1");
};

const setOwnProperty = (
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void => {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    target[key] = value;
  }
};

class StrictCaptureJsonParser {
  readonly #length: number;
  readonly #fixedDepth: boolean;
  readonly #maximumDepth: number;
  readonly #nodeBudget: Budget | undefined;
  readonly #path: (string | number)[];
  #pos = 0;

  constructor(
    readonly text: string,
    readonly format: CaptureJsonFormat,
    readonly maximumNodes?: number,
  ) {
    this.#length = text.length;
    this.#fixedDepth = format === "Playwright trace";
    this.#maximumDepth = this.#fixedDepth
      ? WEB_NETWORK_CAPTURE_LIMITS.depth
      : captureBudgets().depth;
    this.#nodeBudget =
      maximumNodes === undefined ? undefined : new Budget(maximumNodes);
    this.#path = new Array<string | number>(this.#maximumDepth);
  }

  malformed(): never {
    throw new CaptureFormatError(
      "malformed",
      `${this.format} is malformed JSON.`,
    );
  }

  duplicateMember(): never {
    throw new CaptureFormatError(
      "malformed",
      `${this.format} JSON contains duplicate object members.`,
    );
  }

  admitNode(): void {
    this.#nodeBudget?.charge(
      1,
      () =>
        new CaptureFormatError(
          { name: "parser-nodes", maximum: this.#nodeBudget!.maximum },
          "JSON exceeds its parser node representation allowance.",
        ),
    );
  }

  admitContainer(depth: number): void {
    this.admitNode();
    if (depth >= this.#maximumDepth) {
      let pointer = "";
      for (let i = 0; i < depth; i++) {
        const segment = this.#path[i]!;
        pointer +=
          typeof segment === "number"
            ? `/${String(segment)}`
            : `/${escapeJsonPointerToken(segment)}`;
      }
      throw new CaptureFormatError(
        { name: "nesting-depth", maximum: this.#maximumDepth },
        `${this.format} exceeds ${this.#fixedDepth ? "its fixed JSON nesting allowance" : "max_nesting_depth"} (${String(this.#maximumDepth)} levels).`,
        pointer,
      );
    }
  }

  skipWhitespace(): void {
    const text = this.text;
    const len = this.#length;
    let pos = this.#pos;
    while (pos < len) {
      const code = text.charCodeAt(pos);
      if (code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09)
        pos++;
      else break;
    }
    this.#pos = pos;
  }

  peek(): number {
    return this.#pos < this.#length ? this.text.charCodeAt(this.#pos) : -1;
  }

  expectEnd(): void {
    this.skipWhitespace();
    if (this.#pos !== this.#length) this.malformed();
  }

  readString(skip: true): void;
  readString(skip: false): string;
  readString(skip: boolean): string | void {
    const text = this.text;
    const len = this.#length;
    if (this.#pos >= len || text.charCodeAt(this.#pos) !== 0x22)
      this.malformed();
    this.#pos++;
    let chunkStart = this.#pos;
    let chunks: string[] | undefined;
    let isLatin1 = true;
    while (this.#pos < len) {
      const code = text.charCodeAt(this.#pos);
      if (code === 0x22) {
        const end = this.#pos;
        this.#pos++;
        if (skip) return;
        if (chunks === undefined)
          return detachSlice(text, chunkStart, end, isLatin1);
        if (chunkStart < end) chunks.push(text.slice(chunkStart, end));
        return chunks.join("");
      }
      if (code === 0x5c) {
        if (!skip) {
          chunks ??= [];
          if (chunkStart < this.#pos)
            chunks.push(text.slice(chunkStart, this.#pos));
        }
        this.#pos++;
        if (this.#pos >= len) this.malformed();
        const escaped = text.charCodeAt(this.#pos);
        this.#pos++;
        let decoded: string | undefined;
        switch (escaped) {
          case 0x22:
            decoded = '"';
            break;
          case 0x5c:
            decoded = "\\";
            break;
          case 0x2f:
            decoded = "/";
            break;
          case 0x62:
            decoded = "\b";
            break;
          case 0x66:
            decoded = "\f";
            break;
          case 0x6e:
            decoded = "\n";
            break;
          case 0x72:
            decoded = "\r";
            break;
          case 0x74:
            decoded = "\t";
            break;
          case 0x75: {
            if (this.#pos + HEX_DIGITS > len) this.malformed();
            let unit = 0;
            for (let i = 0; i < HEX_DIGITS; i++) {
              const digit = hexValue(text.charCodeAt(this.#pos + i));
              if (digit < 0) this.malformed();
              unit = (unit << 4) | digit;
            }
            this.#pos += HEX_DIGITS;
            decoded = String.fromCharCode(unit);
            break;
          }
          default:
            this.malformed();
        }
        if (!skip) chunks!.push(decoded);
        chunkStart = this.#pos;
        continue;
      }
      if (code < 0x20) this.malformed();
      if (code > 0xff) isLatin1 = false;
      this.#pos++;
    }
    this.malformed();
  }

  readNumber(skip: true): void;
  readNumber(skip: false): LosslessNumber;
  readNumber(skip: boolean): LosslessNumber | void {
    const text = this.text;
    const len = this.#length;
    const start = this.#pos;
    if (this.#pos < len && text.charCodeAt(this.#pos) === 0x2d) this.#pos++;
    if (this.#pos >= len) this.malformed();
    const first = text.charCodeAt(this.#pos);
    if (first === 0x30) {
      this.#pos++;
      if (
        this.#pos < len &&
        text.charCodeAt(this.#pos) >= 0x30 &&
        text.charCodeAt(this.#pos) <= 0x39
      )
        this.malformed();
    } else if (first >= 0x31 && first <= 0x39) {
      this.#pos++;
      while (
        this.#pos < len &&
        text.charCodeAt(this.#pos) >= 0x30 &&
        text.charCodeAt(this.#pos) <= 0x39
      )
        this.#pos++;
    } else {
      this.malformed();
    }
    if (this.#pos < len && text.charCodeAt(this.#pos) === 0x2e) {
      this.#pos++;
      if (
        this.#pos >= len ||
        text.charCodeAt(this.#pos) < 0x30 ||
        text.charCodeAt(this.#pos) > 0x39
      )
        this.malformed();
      while (
        this.#pos < len &&
        text.charCodeAt(this.#pos) >= 0x30 &&
        text.charCodeAt(this.#pos) <= 0x39
      )
        this.#pos++;
    }
    if (
      this.#pos < len &&
      (text.charCodeAt(this.#pos) === 0x65 ||
        text.charCodeAt(this.#pos) === 0x45)
    ) {
      this.#pos++;
      if (
        this.#pos < len &&
        (text.charCodeAt(this.#pos) === 0x2b ||
          text.charCodeAt(this.#pos) === 0x2d)
      )
        this.#pos++;
      if (
        this.#pos >= len ||
        text.charCodeAt(this.#pos) < 0x30 ||
        text.charCodeAt(this.#pos) > 0x39
      )
        this.malformed();
      while (
        this.#pos < len &&
        text.charCodeAt(this.#pos) >= 0x30 &&
        text.charCodeAt(this.#pos) <= 0x39
      )
        this.#pos++;
    }
    if (skip) return;
    return new LosslessNumber(detachAsciiSlice(text, start, this.#pos));
  }

  expectKeyword(word: "true" | "false" | "null"): void {
    const end = this.#pos + word.length;
    if (end > this.#length) this.malformed();
    for (let i = 0; i < word.length; i++) {
      if (this.text.charCodeAt(this.#pos + i) !== word.charCodeAt(i))
        this.malformed();
    }
    this.#pos = end;
  }

  readValue(depth: number): unknown {
    this.skipWhitespace();
    const code = this.peek();
    switch (code) {
      case 0x7b:
        return this.readObject(depth);
      case 0x5b:
        return this.readArray(depth);
      case 0x22:
        this.admitNode();
        return this.readString(false);
      case 0x74:
        this.admitNode();
        this.expectKeyword("true");
        return true;
      case 0x66:
        this.admitNode();
        this.expectKeyword("false");
        return false;
      case 0x6e:
        this.admitNode();
        this.expectKeyword("null");
        return null;
      default:
        if (code !== 0x2d && (code < 0x30 || code > 0x39)) this.malformed();
        this.admitNode();
        return this.readNumber(false);
    }
  }

  readObject(depth: number): Record<string, unknown> {
    this.admitContainer(depth);
    this.#pos++;
    const result: Record<string, unknown> = {};
    this.skipWhitespace();
    if (this.peek() === 0x7d) {
      this.#pos++;
      return result;
    }
    const childDepth = depth + 1;
    while (true) {
      this.skipWhitespace();
      if (this.peek() !== 0x22) this.malformed();
      const key = this.readString(false);
      this.admitNode();
      if (Object.hasOwn(result, key)) this.duplicateMember();
      this.skipWhitespace();
      if (this.peek() !== 0x3a) this.malformed();
      this.#pos++;
      this.#path[depth] = key;
      const value = this.readValue(childDepth);
      setOwnProperty(result, key, value);
      this.skipWhitespace();
      const separator = this.peek();
      if (separator === 0x2c) {
        this.#pos++;
        continue;
      }
      if (separator === 0x7d) {
        this.#pos++;
        return result;
      }
      this.malformed();
    }
  }

  readArray(depth: number): unknown[] {
    this.admitContainer(depth);
    this.#pos++;
    const result: unknown[] = [];
    this.skipWhitespace();
    if (this.peek() === 0x5d) {
      this.#pos++;
      return result;
    }
    const childDepth = depth + 1;
    let index = 0;
    while (true) {
      this.#path[depth] = index++;
      result.push(this.readValue(childDepth));
      this.skipWhitespace();
      const separator = this.peek();
      if (separator === 0x2c) {
        this.#pos++;
        continue;
      }
      if (separator === 0x5d) {
        this.#pos++;
        return result;
      }
      this.malformed();
    }
  }

  skipValue(depth: number): void {
    this.skipWhitespace();
    const code = this.peek();
    switch (code) {
      case 0x7b:
        this.skipObject(depth);
        return;
      case 0x5b:
        this.skipArray(depth);
        return;
      case 0x22:
        this.admitNode();
        this.readString(true);
        return;
      case 0x74:
        this.admitNode();
        this.expectKeyword("true");
        return;
      case 0x66:
        this.admitNode();
        this.expectKeyword("false");
        return;
      case 0x6e:
        this.admitNode();
        this.expectKeyword("null");
        return;
      default:
        if (code !== 0x2d && (code < 0x30 || code > 0x39)) this.malformed();
        this.admitNode();
        this.readNumber(true);
        return;
    }
  }

  skipObject(depth: number): void {
    this.admitContainer(depth);
    this.#pos++;
    this.skipWhitespace();
    if (this.peek() === 0x7d) {
      this.#pos++;
      return;
    }
    const childDepth = depth + 1;
    let firstKey: string | undefined;
    let keys: Set<string> | undefined;
    while (true) {
      this.skipWhitespace();
      if (this.peek() !== 0x22) this.malformed();
      const key = this.readString(false);
      this.admitNode();
      if (keys !== undefined) {
        if (keys.has(key)) this.duplicateMember();
        keys.add(key);
      } else if (firstKey === undefined) {
        firstKey = key;
      } else {
        if (firstKey === key) this.duplicateMember();
        keys = new Set([firstKey, key]);
      }
      this.skipWhitespace();
      if (this.peek() !== 0x3a) this.malformed();
      this.#pos++;
      this.#path[depth] = key;
      this.skipValue(childDepth);
      this.skipWhitespace();
      const separator = this.peek();
      if (separator === 0x2c) {
        this.#pos++;
        continue;
      }
      if (separator === 0x7d) {
        this.#pos++;
        return;
      }
      this.malformed();
    }
  }

  skipArray(depth: number): void {
    this.admitContainer(depth);
    this.#pos++;
    this.skipWhitespace();
    if (this.peek() === 0x5d) {
      this.#pos++;
      return;
    }
    const childDepth = depth + 1;
    let index = 0;
    while (true) {
      this.#path[depth] = index++;
      this.skipValue(childDepth);
      this.skipWhitespace();
      const separator = this.peek();
      if (separator === 0x2c) {
        this.#pos++;
        continue;
      }
      if (separator === 0x5d) {
        this.#pos++;
        return;
      }
      this.malformed();
    }
  }

  parseRoot(): unknown {
    const value = this.readValue(0);
    this.expectEnd();
    return value;
  }

  parseRootSelective(
    retainedTypes: ReadonlySet<string>,
    beforeMaterialize?: () => void,
  ): SelectiveCaptureJsonResult {
    this.skipWhitespace();
    if (this.peek() !== 0x7b) {
      beforeMaterialize?.();
      return { kind: "value", value: this.parseRoot() };
    }
    this.admitContainer(0);
    this.#pos++;
    let retainedRoot: Record<string, unknown> | undefined = {};
    let seenKeys: Set<string> | undefined;
    let skippedType: string | undefined;
    let materializedAdmitted = false;
    const admitMaterialization = (): void => {
      if (!materializedAdmitted) {
        materializedAdmitted = true;
        beforeMaterialize?.();
      }
    };
    this.skipWhitespace();
    if (this.peek() === 0x7d) {
      this.#pos++;
      this.expectEnd();
      return { kind: "value", value: retainedRoot };
    }
    while (true) {
      this.skipWhitespace();
      if (this.peek() !== 0x22) this.malformed();
      const key = this.readString(false);
      this.admitNode();
      if (seenKeys !== undefined) {
        if (seenKeys.has(key)) this.duplicateMember();
        seenKeys.add(key);
      } else {
        if (Object.hasOwn(retainedRoot!, key)) this.duplicateMember();
      }
      this.skipWhitespace();
      if (this.peek() !== 0x3a) this.malformed();
      this.#pos++;
      this.#path[0] = key;
      if (seenKeys !== undefined) {
        this.skipValue(1);
      } else if (key === "type") {
        this.skipWhitespace();
        if (this.peek() === 0x22) {
          this.admitNode();
          const typeValue = this.readString(false);
          if (retainedTypes.has(typeValue)) {
            admitMaterialization();
            setOwnProperty(retainedRoot!, key, typeValue);
          } else {
            seenKeys = new Set(Object.keys(retainedRoot!));
            seenKeys.add(key);
            retainedRoot = undefined;
            skippedType = typeValue;
          }
        } else {
          admitMaterialization();
          setOwnProperty(retainedRoot!, key, this.readValue(1));
        }
      } else {
        admitMaterialization();
        setOwnProperty(retainedRoot!, key, this.readValue(1));
      }
      this.skipWhitespace();
      const separator = this.peek();
      if (separator === 0x2c) {
        this.#pos++;
        continue;
      }
      if (separator === 0x7d) {
        this.#pos++;
        this.expectEnd();
        return skippedType !== undefined
          ? { kind: "skipped", type: skippedType }
          : { kind: "value", value: retainedRoot };
      }
      this.malformed();
    }
  }
}

/** Materialize upstream JSON events without duplicate folding, prototype setters or numeric rounding. */
export const parseCaptureJson = (
  text: string,
  format: CaptureJsonFormat,
  maximumNodes?: number,
): unknown =>
  new StrictCaptureJsonParser(text, format, maximumNodes).parseRoot();

/**
 * Validate a root JSON object while materializing full values only for selected
 * `type` strings. Omitted objects still enforce strict JSON syntax, duplicate
 * member rejection, nesting depth, and parser node limits without retaining DOM
 * or snapshot allocations.
 */
export const parseCaptureJsonForRetainedTypes = (
  text: string,
  format: CaptureJsonFormat,
  retainedTypes: ReadonlySet<string>,
  options?: SelectiveCaptureJsonOptions,
): SelectiveCaptureJsonResult =>
  new StrictCaptureJsonParser(
    text,
    format,
    options?.maximumNodes,
  ).parseRootSelective(retainedTypes, options?.beforeMaterialize);

/** UTF-8 JSON decoding skips one permitted BOM and rejects malformed bytes. */
export const decodeCaptureText = (
  bytes: Uint8Array,
  format: "HAR" | "qlog",
): string => {
  try {
    // Exported HAR and qlog files may carry a BOM signature (RFC 8259 8.1).
    return decodeStrictUtf8(bytes, "strip-signature");
  } catch {
    throw new CaptureFormatError(
      "malformed",
      `${format} is not valid UTF-8 JSON.`,
    );
  }
};
