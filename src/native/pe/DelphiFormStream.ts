/**
 * Static decoder for Delphi/C++Builder binary form resources (`TPF0`).
 *
 * The layout is the Object Pascal filer stream, documented here against the
 * Free Pascal runtime rather than from memory: `TBinaryObjectReader` in
 * `rtl/objpas/classes/reader.inc` (`BeginComponent`, `ReadStr`, `ReadString`,
 * `ReadIdent`, `SkipValue`, `SkipSetBody`, `EndOfList`) and the `TValueType` and
 * `TFilerFlag` declarations in `classesh.inc`.
 *
 * Decoding is bounded and side-effect free: it reads bytes that a PE resource
 * inventory has already located, never executes the owning image, never resolves
 * classes against a live process, and never infers runtime behaviour. Value
 * bytes are retained alongside every decoded projection so a reader can trace
 * any claim back to the resource payload.
 */

import type {
  DelphiFormCollectionItem,
  DelphiFormObject,
  DelphiFormProperty,
  DelphiFormRange,
  DelphiFormText,
  DelphiFormValue,
} from "../../domain/native/delphiForm.js";

/** Signature match at the start of a candidate payload. */
export interface DelphiFormSignature {
  readonly signature: "TPF0" | "TPF1";
  readonly version: "boVersion0" | "boVersion1";
  readonly location: DelphiFormRange;
  /** Bytes before the signature, kept verbatim and never interpreted. */
  readonly prefix: {
    readonly location: DelphiFormRange;
    readonly bytes_hex: string;
    readonly note: string;
  } | null;
}

/** Decoding result for one resource payload. */
export interface DelphiFormDecode {
  readonly signature: DelphiFormSignature;
  readonly code_page: string;
  readonly root: DelphiFormObject | null;
}

/** `TValueType` from `classesh.inc`, indexed by ordinal. */
const VALUE_TYPES: readonly string[] = [
  "vaNull",
  "vaList",
  "vaInt8",
  "vaInt16",
  "vaInt32",
  "vaExtended",
  "vaString",
  "vaIdent",
  "vaFalse",
  "vaTrue",
  "vaBinary",
  "vaSet",
  "vaLString",
  "vaNil",
  "vaCollection",
  "vaSingle",
  "vaCurrency",
  "vaDate",
  "vaWString",
  "vaInt64",
  "vaUTF8String",
  "vaUString",
  "vaQWord",
  "vaDouble",
];

const valueTypeName = (ordinal: number): string =>
  VALUE_TYPES[ordinal] ?? `unknown_value_type(${String(ordinal)})`;

/** `TFilerFlag` from `classesh.inc`: ffInherited, ffChildPos, ffInline. */
const FILER_FLAGS: readonly string[] = [
  "ffInherited",
  "ffChildPos",
  "ffInline",
];

/** Signatures are only searched in a small window so a match stays falsifiable. */
const SIGNATURE_WINDOW_BYTES = 16;
/** Hex projections are capped; the byte count is always reported in full. */
const HEX_LIMIT_BYTES = 128;
const MAX_OBJECTS = 1024;
const MAX_PROPERTIES = 8192;
const MAX_VALUES = 32768;
/** Bounds recursion so a deeply nested value cannot exhaust the call stack. */
const MAX_DEPTH = 32;

/** Reported once per inventory; the decoder itself stays free of policy text. */
export const DELPHI_FORM_LIMITATIONS: readonly string[] = [
  "Static TPF0 filer-stream decode over the located resource payload; class semantics, event-handler binding and runtime form state are not resolved.",
  "String bytes are decoded with the recorded code page and retained verbatim; no code page is guessed when the resource does not declare one.",
  "Undecodable value types and truncated streams are reported as explicit unknowns instead of failing the whole inventory.",
];

/** A read that leaves the payload, or exceeds a decode budget. */
class StreamEnd extends Error {}

/**
 * A `vaList` or `vaCollection` whose later entries stopped decoding. The value
 * built so far travels with the error so the enclosing property keeps it as a
 * partial value instead of a generic unknown.
 */
class StoppedValue extends StreamEnd {
  constructor(
    message: string,
    readonly partial: DelphiFormValue,
  ) {
    super(message);
  }
}

/**
 * Decoding cannot continue past this point. The object built so far travels
 * with the error so every ancestor keeps what it parsed and stops with it,
 * instead of reading the undecodable bytes as invented components.
 */
class StoppedForm extends Error {
  constructor(readonly object: DelphiFormObject) {
    super("Delphi form decoding stopped");
  }
}

/** Bounded cursor over the payload; every read is range checked. */
class Stream {
  constructor(
    readonly bytes: Buffer,
    readonly end: number,
    private at: number,
  ) {}

  get position(): number {
    return this.at;
  }

  get remaining(): number {
    return this.end - this.at;
  }

  peek(): number {
    if (this.at >= this.end)
      throw new StreamEnd("Payload ended before the stream was complete.");
    return this.bytes[this.at] ?? 0;
  }

  take(length: number): Buffer {
    if (length < 0 || this.at + length > this.end)
      throw new StreamEnd("Payload ended before the stream was complete.");
    const slice = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return slice;
  }

  byte(): number {
    return this.take(1)[0] ?? 0;
  }

  uint32(): number {
    return this.take(4).readUInt32LE(0);
  }

  raw(length: number): string {
    return this.take(length).toString("hex");
  }
}

const range = (offset: number, end: number): DelphiFormRange => ({
  offset,
  bytes: Math.max(0, end - offset),
});

const hexOf = (
  bytes: Buffer,
): { readonly bytes_hex: string; readonly truncated: boolean } => {
  const shown = bytes.subarray(0, Math.min(bytes.length, HEX_LIMIT_BYTES));
  return {
    bytes_hex: shown.toString("hex"),
    truncated: bytes.length > shown.length,
  };
};

/**
 * Decode short Pascal strings with the declared code page. `latin1` is only a
 * last resort for labels that cannot be decoded; it never replaces a declared
 * page.
 */
const decodeText = (raw: Buffer, codePage: string): string => {
  if (codePage === "utf-16le") return raw.toString("utf16le");
  if (codePage === "utf-8") return raw.toString("utf8");
  try {
    return new TextDecoder(codePage).decode(raw);
  } catch {
    return raw.toString("latin1");
  }
};

/**
 * Convert the ten-byte x87 extended value used by `vaExtended` to a double.
 * Precision beyond a double is not retained and is reported to the caller.
 */
const decodeExtended = (raw: Buffer): number | null => {
  if (raw.length !== 10) return null;
  const mantissa = raw.readBigUInt64LE(0);
  const exponentAndSign = raw.readUInt16LE(8);
  const exponent = exponentAndSign & 0x7fff;
  if (exponent === 0x7fff) return null;
  if (exponent === 0 && mantissa === 0n) return 0;
  const sign = (exponentAndSign & 0x8000) === 0 ? 1n : -1n;
  const scale = Number(BigInt(exponent) - 16383n - 63n);
  const value = Number(sign * mantissa) * 2 ** scale;
  return Number.isFinite(value) ? value : null;
};

/**
 * Locate a filer signature at the start of a payload. Bytes ahead of the
 * signature are reported verbatim: the `FF 0A 00` prefix some RCDATA payloads
 * carry is not assigned a meaning here.
 */
export const detectDelphiFormSignature = (
  bytes: Buffer,
  start: number,
  end: number,
): DelphiFormSignature | null => {
  const stop = Math.min(end, bytes.length);
  const window = Math.min(stop, start + SIGNATURE_WINDOW_BYTES + 4);
  for (let at = start; at + 4 <= window; at++) {
    const text = bytes.toString("latin1", at, at + 4);
    if (text !== "TPF0" && text !== "TPF1") continue;
    const signature: DelphiFormSignature = {
      signature: text,
      version: text === "TPF1" ? "boVersion1" : "boVersion0",
      location: range(at, at + 4),
      prefix: null,
    };
    if (at === start) return signature;
    const prefix = bytes.subarray(start, at);
    return {
      ...signature,
      prefix: {
        location: range(start, at),
        bytes_hex: hexOf(prefix).bytes_hex,
        note: "Bytes before the filer signature are retained verbatim; their meaning is unknown.",
      },
    };
  }
  return null;
};

interface Budget {
  objects: number;
  properties: number;
  values: number;
}

const spend = (budget: Budget, field: keyof Budget): void => {
  budget[field] -= 1;
  if (budget[field] < 0)
    throw new StreamEnd("Decode budget exhausted for this payload.");
};

/** `ReadStr`: one length byte followed by that many raw bytes. */
function readShortString(stream: Stream, codePage: string): DelphiFormText {
  const at = stream.position;
  const length = stream.byte();
  const raw = stream.take(length);
  return {
    text: decodeText(raw, codePage),
    bytes_hex: raw.toString("hex"),
    code_page: codePage,
    location: range(at, stream.position),
  };
}

function readInteger(stream: Stream, width: 8 | 16 | 32 | 64): string {
  if (width === 64) return stream.take(8).readBigInt64LE(0).toString();
  if (width === 32) return String(stream.take(4).readInt32LE(0));
  if (width === 16) return String(stream.take(2).readInt16LE(0));
  return String(stream.take(1).readInt8(0));
}

/** Integer and floating point value types; null when the ordinal is not one. */
function readNumericValue(
  stream: Stream,
  ordinal: number,
): DelphiFormValue | null {
  const at = stream.position;
  switch (ordinal) {
    case 2:
      return {
        kind: "integer",
        text: readInteger(stream, 8),
        width: 8,
        signed: true,
        location: range(at, stream.position),
      };
    case 3:
      return {
        kind: "integer",
        text: readInteger(stream, 16),
        width: 16,
        signed: true,
        location: range(at, stream.position),
      };
    case 4:
      return {
        kind: "integer",
        text: readInteger(stream, 32),
        width: 32,
        signed: true,
        location: range(at, stream.position),
      };
    case 19:
      return {
        kind: "integer",
        text: readInteger(stream, 64),
        width: 64,
        signed: true,
        location: range(at, stream.position),
      };
    case 22:
      return {
        kind: "integer",
        text: stream.take(8).readBigUInt64LE(0).toString(),
        width: 64,
        signed: false,
        location: range(at, stream.position),
      };
    case 15: {
      const raw = stream.take(4);
      const value = raw.readFloatLE(0);
      return {
        kind: "float",
        text: Number.isFinite(value) ? String(value) : null,
        bytes_hex: raw.toString("hex"),
        note: "IEEE-754 binary32.",
        location: range(at, stream.position),
      };
    }
    case 23: {
      const raw = stream.take(8);
      const value = raw.readDoubleLE(0);
      return {
        kind: "float",
        text: Number.isFinite(value) ? String(value) : null,
        bytes_hex: raw.toString("hex"),
        note: "IEEE-754 binary64.",
        location: range(at, stream.position),
      };
    }
    case 5: {
      const raw = stream.take(10);
      const value = decodeExtended(raw);
      return {
        kind: "float",
        text: value === null ? null : String(value),
        bytes_hex: raw.toString("hex"),
        note: "Ten-byte x87 extended value reduced to a double; extra precision is not retained.",
        location: range(at, stream.position),
      };
    }
    case 16: {
      const raw = stream.take(8);
      // Currency is a signed 64-bit value scaled by 10000. Format it straight
      // from the integer: converting to a number first rounds the quotient.
      const scaled = raw.readBigInt64LE(0);
      const sign = scaled < 0n ? "-" : "";
      const digits = (scaled < 0n ? -scaled : scaled)
        .toString()
        .padStart(5, "0");
      return {
        kind: "float",
        text: `${sign}${digits.slice(0, -4)}.${digits.slice(-4)}`,
        bytes_hex: raw.toString("hex"),
        note: "Currency: signed 64-bit value scaled by 10000.",
        location: range(at, stream.position),
      };
    }
    case 17: {
      const raw = stream.take(8);
      const value = raw.readDoubleLE(0);
      return {
        kind: "float",
        text: Number.isFinite(value) ? String(value) : null,
        bytes_hex: raw.toString("hex"),
        note: "TDateTime: days since 1899-12-30, not converted to a calendar date.",
        location: range(at, stream.position),
      };
    }
    default:
      return null;
  }
}

function readValue(
  stream: Stream,
  ordinal: number,
  budget: Budget,
  codePage: string,
  depth: number,
): DelphiFormValue {
  spend(budget, "values");
  const at = stream.position;
  // Nested lists and collections recurse; bound the depth before the call
  // stack does, so a crafted payload reports an unknown instead of failing.
  if (depth > MAX_DEPTH)
    throw new StreamEnd(
      `Delphi form value nesting exceeds ${String(MAX_DEPTH)} levels.`,
    );
  const numeric = readNumericValue(stream, ordinal);
  if (numeric !== null) return numeric;
  switch (ordinal) {
    case 0:
      return { kind: "null", location: range(at, at) };
    case 13:
      return { kind: "nil", location: range(at, at) };
    case 8:
      return { kind: "boolean", value: false, location: range(at, at) };
    case 9:
      return { kind: "boolean", value: true, location: range(at, at) };
    case 6:
    case 7: {
      const text = readShortString(stream, codePage);
      return ordinal === 6
        ? {
            kind: "string",
            text: text.text,
            bytes_hex: text.bytes_hex,
            code_page: codePage,
            truncated: false,
            location: text.location,
          }
        : {
            kind: "identifier",
            text: text.text,
            bytes_hex: text.bytes_hex,
            location: text.location,
          };
    }
    case 12:
    case 20: {
      const declared = stream.uint32();
      const raw = stream.take(declared);
      const page = ordinal === 20 ? "utf-8" : codePage;
      return {
        kind: "string",
        text: decodeText(raw, page),
        ...hexOf(raw),
        code_page: page,
        location: range(at, stream.position),
      };
    }
    case 18:
    case 21: {
      const characters = stream.uint32();
      const raw = stream.take(characters * 2);
      return {
        kind: "string",
        text: raw.toString("utf16le"),
        ...hexOf(raw),
        code_page: "utf-16le",
        location: range(at, stream.position),
      };
    }
    case 10: {
      const declared = stream.uint32();
      const raw = stream.take(declared);
      return {
        kind: "binary",
        ...hexOf(raw),
        declared_bytes: declared,
        location: range(at, stream.position),
      };
    }
    case 1: {
      const items: DelphiFormValue[] = [];
      const partialLocation = () => range(at, stream.position);
      for (;;) {
        const next = stream.peek();
        if (next === 0) break;
        stream.byte();
        try {
          items.push(readValue(stream, next, budget, codePage, depth + 1));
        } catch (error) {
          if (error instanceof StoppedForm) throw error;
          if (!(error instanceof StreamEnd)) throw error;
          // Entries decoded before the stop stay evidence. A stopped nested
          // list keeps its own partial items as the last entry of this one.
          if (error instanceof StoppedValue) items.push(error.partial);
          throw new StoppedValue(error.message, {
            kind: "list",
            items,
            location: partialLocation(),
          });
        }
      }
      stream.byte();
      return { kind: "list", items, location: range(at, stream.position) };
    }
    case 11: {
      const names: DelphiFormText[] = [];
      for (;;) {
        // A set name is a retained object even though it costs one input byte,
        // so charge it against the shared budget before allocating it.
        spend(budget, "values");
        const name = readShortString(stream, codePage);
        if (name.location.bytes <= 1) break;
        names.push(name);
      }
      return { kind: "set", names, location: range(at, stream.position) };
    }
    case 14: {
      const items: DelphiFormCollectionItem[] = [];
      for (;;) {
        if (stream.peek() === 0) break;
        // An empty collection item costs two input bytes, so charge every item
        // before it is retained rather than measuring the whole form afterwards.
        spend(budget, "values");
        const itemAt = stream.position;
        let position: string | null = null;
        const next = stream.peek();
        if (next === 2 || next === 3 || next === 4) {
          stream.byte();
          position = readInteger(stream, next === 2 ? 8 : next === 3 ? 16 : 32);
        }
        // `ReadListBegin` consumes the vaList marker that opens each item.
        const marker = stream.byte();
        if (marker !== 1)
          throw new StreamEnd(
            `Collection item does not start with vaList (found ${valueTypeName(marker)}).`,
          );
        const properties: DelphiFormProperty[] = [];
        for (;;) {
          if (stream.peek() === 0) break;
          const propertyAt = stream.position;
          spend(budget, "properties");
          const name = readShortString(stream, codePage);
          let ordinal: number | null = null;
          try {
            ordinal = stream.byte();
            const value = readValue(
              stream,
              ordinal,
              budget,
              codePage,
              depth + 1,
            );
            properties.push({
              name,
              value_type: valueTypeName(ordinal),
              value,
              location: range(propertyAt, stream.position),
            });
          } catch (error) {
            if (error instanceof StoppedForm) throw error;
            if (!(error instanceof StreamEnd)) throw error;
            // Keep the nested partial (for example a stopped vaList) on the
            // property that declared it, then stop the collection with the
            // items decoded so far instead of collapsing them to one value.
            properties.push({
              name,
              value_type: ordinal === null ? "unknown" : valueTypeName(ordinal),
              value:
                error instanceof StoppedValue
                  ? error.partial
                  : {
                      kind: "unknown",
                      reason: error.message,
                      ...hexOf(
                        stream.bytes.subarray(stream.position, stream.end),
                      ),
                      location: range(stream.position, stream.end),
                    },
              location: range(propertyAt, stream.end),
            });
            items.push({
              position,
              properties,
              location: range(itemAt, stream.position),
            });
            throw new StoppedValue(error.message, {
              kind: "collection",
              items,
              location: range(at, stream.position),
            });
          }
        }
        stream.byte();
        items.push({
          position,
          properties,
          location: range(itemAt, stream.position),
        });
      }
      stream.byte();
      return {
        kind: "collection",
        items,
        location: range(at, stream.position),
      };
    }
    default:
      // The length of an unknown value cannot be derived, so the rest of the
      // stream cannot be positioned. Stop rather than resynchronise on a guess.
      throw new StreamEnd(
        `Unsupported value type ${valueTypeName(ordinal)} (${String(ordinal)}).`,
      );
  }
}

/** `BeginComponent`: optional filer flags, then class name and component name. */
function readObject(
  stream: Stream,
  budget: Budget,
  codePage: string,
  depth: number,
): DelphiFormObject {
  spend(budget, "objects");
  const at = stream.position;
  const flags: string[] = [];
  let childPosition: string | null = null;
  const prefix = stream.peek();
  if ((prefix & 0xf0) === 0xf0) {
    stream.byte();
    for (const [bit, name] of FILER_FLAGS.entries())
      if ((prefix & (1 << bit)) !== 0) flags.push(name);
    if ((prefix & 0x02) !== 0) {
      const width = stream.byte();
      if (width !== 2 && width !== 3 && width !== 4)
        throw new StreamEnd("Child position is not encoded as vaInt8/16/32.");
      childPosition = readInteger(
        stream,
        width === 2 ? 8 : width === 3 ? 16 : 32,
      );
    }
  }
  const className = readShortString(stream, codePage);
  const componentName = readShortString(stream, codePage);
  const properties: DelphiFormProperty[] = [];
  const children: DelphiFormObject[] = [];
  const partial = (reason: string): DelphiFormObject => ({
    location: range(at, stream.position),
    flags,
    child_position: childPosition,
    class_name: className,
    component_name: componentName,
    properties,
    children,
    unknown: {
      reason,
      bytes_hex: hexOf(stream.bytes.subarray(at, stream.position)).bytes_hex,
    },
  });
  try {
    for (;;) {
      if (stream.peek() === 0) break;
      const propertyAt = stream.position;
      spend(budget, "properties");
      const name = readShortString(stream, codePage);
      // The type marker can itself be truncated after a complete name; the
      // partial-property path below must still retain the observed name.
      let ordinal: number | null = null;
      try {
        ordinal = stream.byte();
        const value = readValue(stream, ordinal, budget, codePage, depth);
        properties.push({
          name,
          value_type: valueTypeName(ordinal),
          value,
          location: range(propertyAt, stream.position),
        });
      } catch (error) {
        if (error instanceof StoppedForm) throw error;
        if (!(error instanceof StreamEnd)) throw error;
        // Record the property that could not be decoded with the name and type
        // that were already parsed, then stop: anything read after it would be a
        // guess rather than evidence. A stopped list keeps the entries decoded
        // before the stop instead of collapsing into a generic unknown.
        properties.push({
          name,
          value_type: ordinal === null ? "unknown" : valueTypeName(ordinal),
          value:
            error instanceof StoppedValue
              ? error.partial
              : {
                  kind: "unknown",
                  reason: error.message,
                  ...hexOf(stream.bytes.subarray(stream.position, stream.end)),
                  location: range(stream.position, stream.end),
                },
          location: range(propertyAt, stream.end),
        });
        throw new StoppedForm(partial(error.message));
      }
    }
    stream.byte();
    for (;;) {
      if (stream.peek() === 0) break;
      const childAt = stream.position;
      try {
        children.push(readObject(stream, budget, codePage, depth + 1));
      } catch (error) {
        // A stopped child keeps its place next to its siblings, and every
        // ancestor stops with it: continuing would read the undecodable bytes as
        // invented components.
        if (error instanceof StoppedForm) {
          children.push(error.object);
          throw new StoppedForm(
            partial(
              error.object.unknown?.reason ?? "Delphi form decoding stopped",
            ),
          );
        }
        if (!(error instanceof StreamEnd)) throw error;
        children.push({
          location: range(childAt, stream.position),
          flags: [],
          child_position: null,
          class_name: null,
          component_name: null,
          properties: [],
          children: [],
          unknown: {
            reason: error.message,
            bytes_hex: hexOf(stream.bytes.subarray(childAt, stream.position))
              .bytes_hex,
          },
        });
        throw new StoppedForm(partial(error.message));
      }
    }
    stream.byte();
  } catch (error) {
    if (error instanceof StoppedForm) throw error;
    if (!(error instanceof StreamEnd)) throw error;
    return partial(error.message);
  }
  return {
    location: range(at, stream.position),
    flags,
    child_position: childPosition,
    class_name: className,
    component_name: componentName,
    properties,
    children,
    unknown: null,
  };
}

/**
 * Decode one resource payload as a Delphi binary form.
 *
 * Undecodable values and truncated streams become explicit unknowns inside the
 * tree rather than failing the payload; a missing signature means the payload is
 * not a form at all, which `detectDelphiFormSignature` reports.
 */
export const decodeDelphiFormStream = (
  bytes: Buffer,
  start: number,
  end: number,
  options: { readonly code_page?: string } = {},
): DelphiFormDecode | null => {
  if (start < 0 || end > bytes.length || end <= start) return null;
  const signature = detectDelphiFormSignature(bytes, start, end);
  if (signature === null) return null;
  const codePage = options.code_page ?? "windows-1252";
  const budget: Budget = {
    objects: MAX_OBJECTS,
    properties: MAX_PROPERTIES,
    values: MAX_VALUES,
  };
  const stream = new Stream(
    bytes,
    end,
    signature.location.offset + signature.location.bytes,
  );
  let root: DelphiFormObject | null = null;
  try {
    if (stream.remaining > 0) root = readObject(stream, budget, codePage, 0);
    // A suffix after the root terminator is part of the payload but nothing
    // decoded claims it; report it instead of presenting a complete decode.
    if (root !== null && root.unknown === null && stream.remaining > 0)
      root = {
        ...root,
        unknown: {
          reason: `${String(stream.remaining)} bytes follow the root component terminator.`,
          bytes_hex: hexOf(stream.bytes.subarray(stream.position, end))
            .bytes_hex,
        },
      };
  } catch (error) {
    // A stopped form still carries everything decoded before the stop.
    if (error instanceof StoppedForm) root = error.object;
    else if (error instanceof StreamEnd)
      root = {
        location: range(stream.position, end),
        flags: [],
        child_position: null,
        class_name: null,
        component_name: null,
        properties: [],
        children: [],
        unknown: { reason: error.message, bytes_hex: "" },
      };
    else throw error;
  }
  return { signature, code_page: codePage, root };
};
