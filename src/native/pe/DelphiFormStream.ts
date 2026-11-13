/**
 * Static decoder for Delphi/C++Builder binary form resources (`TPF0`).
 *
 * The layout is the Object Pascal filer stream, documented here against the
 * Free Pascal runtime rather than from memory: `TBinaryObjectReader` in
 * `rtl/objpas/classes/reader.inc` (`BeginComponent`, `ReadStr`, `ReadString`,
 * `ReadIdent`, `SkipValue`, `SkipSetBody`, `EndOfList`) and the `TFilerFlag`
 * declaration in `classesh.inc`. Ordinal value types follow Delphi's
 * `System.Classes.TValueType`, the table used by the Delphi/C++Builder
 * producer this decoder targets; Free Pascal's table differs at ordinals
 * 21–23.
 *
 * Decoding is bounded and side-effect free: it reads bytes that a PE resource
 * inventory has already located, never executes the owning image, never resolves
 * classes against a live process, and never infers runtime behaviour. Value
 * bytes are retained alongside every decoded projection so a reader can trace
 * any claim back to the resource payload.
 */

import {
  DEFAULT_CODE_PAGE,
  DELPHI_FORM_FILER_FLAGS,
  DELPHI_FORM_FLOAT_NOTES,
  DELPHI_FORM_VALUE_TYPES,
  decodeDelphiExtended,
  decodeDelphiText,
  formatDelphiCurrency,
  MAX_DELPHI_FORM_DEPTH,
  MAX_DELPHI_FORM_HEX_BYTES,
  MAX_DELPHI_FORM_SIGNATURE_PREFIX_BYTES,
  type DelphiFormCollectionItem,
  type DelphiFormListEntry,
  type DelphiFormObject,
  type DelphiFormPosition,
  type DelphiFormProperty,
  type DelphiFormRange,
  type DelphiFormText,
  type DelphiFormValue,
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
  readonly root: DelphiFormObject;
}

const valueTypeName = (ordinal: number): string =>
  DELPHI_FORM_VALUE_TYPES[ordinal] ?? `unknown_value_type(${String(ordinal)})`;

const MAX_OBJECTS = 1024;
const MAX_PROPERTIES = 8192;
const MAX_VALUES = 32768;
/** Bounds decoded text before allocation; matches the 8 MiB result budget. */
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
/** Bounds retained structural values before allocation. */
const MAX_RETAINED_BYTES = 8 * 1024 * 1024;
const VALUE_BYTES = 256;
const OBJECT_BYTES = 192;
const PROPERTY_BYTES = 160;
const ITEM_BYTES = 96;
/** The list-entry wrapper retains its declared type and tag range. */
const LIST_ENTRY_BYTES = 128;
/** Positional integers retain width, source bytes and their own range. */
const POSITION_BYTES = 128;

/** Reported once per inventory; the decoder itself stays free of policy text. */
export const DELPHI_FORM_LIMITATIONS: readonly string[] = [
  "Static TPF0 filer-stream decode over the located resource payload; class semantics, event-handler binding and runtime form state are not resolved.",
  'String bytes are decoded with the recorded code page and retained verbatim; a resource that declares no code page is decoded as windows-1252 and reported as code_page_source: "default".',
  "Undecodable value types and truncated streams are reported as explicit unknowns instead of failing the whole inventory.",
  `A filer signature is recognized only within the first ${String(MAX_DELPHI_FORM_SIGNATURE_PREFIX_BYTES)} bytes of an RT_RCDATA payload; a longer prefix leaves the payload opaque.`,
];

/** A read that leaves the payload, or exceeds a decode budget. */
class StreamEnd extends Error {}

const STREAM_END_MESSAGE = "Payload ended before the stream was complete.";

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
    if (this.at >= this.end) throw new StreamEnd(STREAM_END_MESSAGE);
    return this.bytes[this.at] ?? 0;
  }

  take(length: number): Buffer {
    if (length < 0 || this.at + length > this.end)
      throw new StreamEnd(STREAM_END_MESSAGE);
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
  const shown = bytes.subarray(
    0,
    Math.min(bytes.length, MAX_DELPHI_FORM_HEX_BYTES),
  );
  return {
    bytes_hex: shown.toString("hex"),
    truncated: bytes.length > shown.length,
  };
};

/** Object unknowns keep the same capped bytes, range and cap flag as values. */
const formUnknown = (
  reason: string,
  bytes: Buffer,
  location: DelphiFormRange,
): NonNullable<DelphiFormObject["unknown"]> => ({
  reason,
  ...hexOf(bytes),
  location,
});

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
  const window = Math.min(
    stop,
    start + MAX_DELPHI_FORM_SIGNATURE_PREFIX_BYTES + 4,
  );
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
  text: number;
  bytes: number;
}

/** Charge a retained value or container before allocating it. */
const spendBytes = (budget: Budget, projectedBytes: number): void => {
  budget.bytes -= projectedBytes;
  if (budget.bytes < 0)
    throw new StreamEnd("Decoded value budget exhausted for this payload.");
};

/** Charge retained text and its hex/JSON projection before decoding it. */
const spendText = (budget: Budget, projectedBytes: number): void => {
  budget.text -= projectedBytes;
  budget.bytes -= projectedBytes;
  if (budget.text < 0 || budget.bytes < 0)
    throw new StreamEnd("Decoded string budget exhausted for this payload.");
};

const spend = (budget: Budget, field: keyof Budget): void => {
  budget[field] -= 1;
  if (budget[field] < 0)
    throw new StreamEnd("Decode budget exhausted for this payload.");
};

/** `ReadStr`: one length byte followed by that many raw bytes. */
function readShortString(
  stream: Stream,
  codePage: string,
  budget: Budget,
): DelphiFormText {
  const at = stream.position;
  const length = stream.peek();
  // Short strings are capped at 255 bytes, but a form can retain thousands of
  // them; charge each one before decoding.
  spendText(budget, length * 10 + 256);
  // Take the declaration and payload atomically: when the body is truncated,
  // the length byte stays unread for the owner's unknown suffix instead of
  // being claimed by no projection.
  const bytes = stream.take(1 + length);
  const raw = bytes.subarray(1);
  return {
    text: decodeDelphiText(raw, codePage),
    bytes_hex: raw.toString("hex"),
    code_page: codePage,
    location: range(at, stream.position),
  };
}

/** A `vaString` keeps its completed length when the value cannot be decoded. */
function readShortStringValue(
  stream: Stream,
  codePage: string,
  budget: Budget,
  at: number,
): DelphiFormValue {
  const declared = stream.byte();
  const available = Math.min(declared, stream.remaining);
  try {
    spendText(budget, declared * 10 + 256);
  } catch (error) {
    if (!(error instanceof StreamEnd)) throw error;
    throw new StoppedValue(error.message, {
      kind: "string",
      text: "",
      bytes_hex: "",
      code_page: codePage,
      declared_bytes: declared,
      truncated: true,
      decode_truncated: true,
      location: range(at, stream.position),
    });
  }
  const raw = stream.take(available);
  const value: DelphiFormValue = {
    kind: "string",
    text: decodeDelphiText(raw, codePage),
    bytes_hex: raw.toString("hex"),
    code_page: codePage,
    declared_bytes: declared,
    truncated: available < declared,
    decode_truncated: available < declared,
    location: range(at, stream.position),
  };
  if (available < declared) throw new StoppedValue(STREAM_END_MESSAGE, value);
  return value;
}

/**
 * Read a positional integer tag and its fixed-width payload atomically. When
 * the payload is truncated or the budget stops the read, the tag stays unread
 * for the owner's unknown suffix instead of being claimed only by a generic
 * item or object range.
 */
function positionValue(
  stream: Stream,
  tag: 2 | 3 | 4,
  budget: Budget,
): DelphiFormPosition {
  spendBytes(budget, POSITION_BYTES);
  const at = stream.position;
  const width = tag === 2 ? 8 : tag === 3 ? 16 : 32;
  const raw = stream.take(1 + width / 8);
  const payload = raw.subarray(1);
  const text =
    width === 32
      ? String(payload.readInt32LE(0))
      : width === 16
        ? String(payload.readInt16LE(0))
        : String(payload.readInt8(0));
  return {
    kind: "integer",
    text,
    bytes_hex: payload.toString("hex"),
    width,
    signed: true,
    // The tag is structural and represented by the call site; the position
    // range covers the encoded payload only.
    location: range(at + 1, stream.position),
  };
}

function integerValue(
  stream: Stream,
  width: 8 | 16 | 32 | 64,
  signed: boolean,
): DelphiFormValue {
  const at = stream.position;
  const raw = stream.take(width / 8);
  const text =
    width === 64
      ? (signed ? raw.readBigInt64LE(0) : raw.readBigUInt64LE(0)).toString()
      : width === 32
        ? String(signed ? raw.readInt32LE(0) : raw.readUInt32LE(0))
        : width === 16
          ? String(signed ? raw.readInt16LE(0) : raw.readUInt16LE(0))
          : String(signed ? raw.readInt8(0) : raw.readUInt8(0));
  return {
    kind: "integer",
    text,
    bytes_hex: raw.toString("hex"),
    width,
    signed,
    location: range(at, stream.position),
  };
}

/** Integer and floating point value types; null when the ordinal is not one. */
function readNumericValue(
  stream: Stream,
  ordinal: number,
): DelphiFormValue | null {
  const at = stream.position;
  switch (ordinal) {
    case 2:
      return integerValue(stream, 8, true);
    case 3:
      return integerValue(stream, 16, true);
    case 4:
      return integerValue(stream, 32, true);
    case 19:
      return integerValue(stream, 64, true);
    case 15: {
      const raw = stream.take(4);
      const value = raw.readFloatLE(0);
      return {
        kind: "float",
        text: Number.isFinite(value) ? String(value) : null,
        bytes_hex: raw.toString("hex"),
        note: DELPHI_FORM_FLOAT_NOTES.vaSingle ?? "",
        location: range(at, stream.position),
      };
    }
    case 21: {
      const raw = stream.take(8);
      const value = raw.readDoubleLE(0);
      return {
        kind: "float",
        text: Number.isFinite(value) ? String(value) : null,
        bytes_hex: raw.toString("hex"),
        note: DELPHI_FORM_FLOAT_NOTES.vaDouble ?? "",
        location: range(at, stream.position),
      };
    }
    case 23:
      return integerValue(stream, 64, false);
    case 5: {
      const raw = stream.take(10);
      const value = decodeDelphiExtended(raw);
      return {
        kind: "float",
        text: value === null ? null : String(value),
        bytes_hex: raw.toString("hex"),
        note: DELPHI_FORM_FLOAT_NOTES.vaExtended ?? "",
        location: range(at, stream.position),
      };
    }
    case 16: {
      const raw = stream.take(8);
      return {
        kind: "float",
        text: formatDelphiCurrency(raw),
        bytes_hex: raw.toString("hex"),
        note: DELPHI_FORM_FLOAT_NOTES.vaCurrency ?? "",
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
        note: DELPHI_FORM_FLOAT_NOTES.vaDate ?? "",
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
  spendBytes(budget, VALUE_BYTES);
  const at = stream.position;
  // Nested lists and collections recurse; bound the depth before the call
  // stack does, so a crafted payload reports an unknown instead of failing.
  if (depth > MAX_DELPHI_FORM_DEPTH)
    throw new StreamEnd(
      `Delphi form value nesting exceeds ${String(MAX_DELPHI_FORM_DEPTH)} levels.`,
    );
  const numeric = readNumericValue(stream, ordinal);
  if (numeric !== null) return numeric;
  // Every caller consumes the value type byte before this call. Marker-only
  // values have no payload, so their range covers that byte; otherwise a list
  // item would point at a zero-byte range after its only source byte.
  const marker = range(Math.max(0, at - 1), at);
  switch (ordinal) {
    case 0:
      return { kind: "null", location: marker };
    case 13:
      return { kind: "nil", location: marker };
    case 8:
      return { kind: "boolean", value: false, location: marker };
    case 9:
      return { kind: "boolean", value: true, location: marker };
    case 6:
      return readShortStringValue(stream, codePage, budget, at);
    case 7: {
      const text = readShortString(stream, codePage, budget);
      return {
        kind: "identifier",
        text: text.text,
        bytes_hex: text.bytes_hex,
        location: text.location,
      };
    }
    case 12:
    case 20: {
      const declared = stream.uint32();
      const page = ordinal === 20 ? "utf-8" : codePage;
      // Reject a large retained projection before decoding it. A truncated
      // value keeps its declaration and the bytes the payload holds.
      const available = Math.min(declared, stream.remaining);
      try {
        spendText(budget, available * 10 + 256);
      } catch (error) {
        if (!(error instanceof StreamEnd)) throw error;
        // The length prefix is already observed; keep it on the stopped value
        // even when the representation budget prevents decoding the payload.
        throw new StoppedValue(error.message, {
          kind: "string",
          text: "",
          bytes_hex: "",
          code_page: page,
          declared_bytes: declared,
          truncated: true,
          decode_truncated: true,
          location: range(at, stream.position),
        });
      }
      const raw = stream.take(available);
      const hex = hexOf(raw);
      const value: DelphiFormValue = {
        kind: "string",
        text: decodeDelphiText(raw, page),
        ...hex,
        code_page: page,
        declared_bytes: declared,
        truncated: hex.truncated || available < declared,
        decode_truncated: available < declared,
        location: range(at, stream.position),
      };
      if (available < declared)
        throw new StoppedValue(STREAM_END_MESSAGE, value);
      return value;
    }
    case 18:
    case 22: {
      const characters = stream.uint32();
      const declared = characters * 2;
      const available = Math.min(declared, stream.remaining) & ~1;
      try {
        spendText(budget, available * 10 + 256);
      } catch (error) {
        if (!(error instanceof StreamEnd)) throw error;
        throw new StoppedValue(error.message, {
          kind: "string",
          text: "",
          bytes_hex: "",
          code_page: "utf-16le",
          declared_bytes: declared,
          truncated: true,
          decode_truncated: true,
          location: range(at, stream.position),
        });
      }
      const raw = stream.take(available);
      const hex = hexOf(raw);
      const value: DelphiFormValue = {
        kind: "string",
        text: decodeDelphiText(raw, "utf-16le"),
        ...hex,
        code_page: "utf-16le",
        declared_bytes: declared,
        truncated: hex.truncated || available < declared,
        decode_truncated: available < declared,
        location: range(at, stream.position),
      };
      if (available < declared)
        throw new StoppedValue(STREAM_END_MESSAGE, value);
      return value;
    }
    case 10: {
      const declared = stream.uint32();
      // The hex projection is capped, but every value still retains one.
      // Charge it before allocation so a list of binaries cannot bypass the
      // retained-text bound and only fail the post-decode metadata account.
      // A truncated value keeps the declared count with the bytes it holds.
      const available = Math.min(declared, stream.remaining);
      try {
        spendText(
          budget,
          Math.min(available, MAX_DELPHI_FORM_HEX_BYTES) * 2 + 256,
        );
      } catch (error) {
        if (!(error instanceof StreamEnd)) throw error;
        throw new StoppedValue(error.message, {
          kind: "binary",
          bytes_hex: "",
          declared_bytes: declared,
          truncated: true,
          decode_truncated: true,
          location: range(at, stream.position),
        });
      }
      const raw = stream.take(available);
      const hex = hexOf(raw);
      const value: DelphiFormValue = {
        kind: "binary",
        ...hex,
        declared_bytes: declared,
        truncated: hex.truncated || available < declared,
        decode_truncated: available < declared,
        location: range(at, stream.position),
      };
      if (available < declared)
        throw new StoppedValue(STREAM_END_MESSAGE, value);
      return value;
    }
    case 1: {
      const items: DelphiFormListEntry[] = [];
      const partialLocation = () => range(at, stream.position);
      for (;;) {
        let next: number;
        try {
          next = stream.peek();
        } catch (error) {
          if (!(error instanceof StreamEnd)) throw error;
          // The payload can end exactly after a complete item; keep every
          // entry decoded before the missing terminator.
          throw new StoppedValue(error.message, {
            kind: "list",
            items,
            terminated: false,
            location: partialLocation(),
          });
        }
        if (next === 0) break;
        const markerAt = stream.position;
        stream.byte();
        const markerLocation = range(markerAt, markerAt + 1);
        try {
          // The wrapper retains the declared type and tag byte; charge it
          // before allocating alongside the value it describes.
          spendBytes(budget, LIST_ENTRY_BYTES);
          const value = readValue(stream, next, budget, codePage, depth + 1);
          items.push({
            value_type: valueTypeName(next),
            marker_location: markerLocation,
            value,
          });
        } catch (error) {
          if (error instanceof StoppedForm) throw error;
          if (!(error instanceof StreamEnd)) throw error;
          // Entries decoded before the stop stay evidence. A stopped nested
          // list keeps its own partial items as the last entry of this one.
          if (error instanceof StoppedValue)
            items.push({
              value_type: valueTypeName(next),
              marker_location: markerLocation,
              value: error.partial,
            });
          else
            // The type marker was already consumed, so dropping this entry
            // would leave those bytes outside both the list and its unknown.
            // Retain the declared type, the marker and the bytes the failed
            // read consumed as one explicit unknown value.
            items.push({
              value_type: valueTypeName(next),
              marker_location: markerLocation,
              value: {
                kind: "unknown",
                reason: error.message,
                ...hexOf(stream.bytes.subarray(markerAt + 1, stream.position)),
                location: range(markerAt + 1, stream.position),
              },
            });
          throw new StoppedValue(error.message, {
            kind: "list",
            items,
            terminated: false,
            location: partialLocation(),
          });
        }
      }
      stream.byte();
      return {
        kind: "list",
        items,
        terminated: true,
        location: range(at, stream.position),
      };
    }
    case 11: {
      const names: DelphiFormText[] = [];
      for (;;) {
        try {
          // A set name is a retained object even though it costs one input byte,
          // so charge it against the shared budget before allocating it.
          spend(budget, "values");
          const name = readShortString(stream, codePage, budget);
          if (name.location.bytes <= 1) break;
          names.push(name);
        } catch (error) {
          if (!(error instanceof StreamEnd)) throw error;
          // Keep the names decoded before the set was truncated.
          throw new StoppedValue(error.message, {
            kind: "set",
            names,
            terminated: false,
            location: range(at, stream.position),
          });
        }
      }
      return {
        kind: "set",
        names,
        terminated: true,
        location: range(at, stream.position),
      };
    }
    case 14: {
      const items: DelphiFormCollectionItem[] = [];
      function stop(reason: string): never {
        throw new StoppedValue(reason, {
          kind: "collection",
          items,
          terminated: false,
          location: range(at, stream.position),
        });
      }
      for (;;) {
        let nextItem: number;
        try {
          nextItem = stream.peek();
        } catch (error) {
          if (!(error instanceof StreamEnd)) throw error;
          // The payload can end exactly after a complete item; keep it.
          stop(error.message);
        }
        if (nextItem === 0) break;
        // An empty collection item costs two input bytes, so charge every item
        // before it is retained rather than measuring the whole form afterwards.
        // A budget failure is still a partial collection: keep the items decoded
        // before it instead of collapsing the property to one unknown.
        try {
          spend(budget, "values");
          spendBytes(budget, ITEM_BYTES);
        } catch (error) {
          if (!(error instanceof StreamEnd)) throw error;
          stop(error.message);
        }
        const itemAt = stream.position;
        let position: DelphiFormPosition | null = null;
        try {
          const next = stream.peek();
          if (next === 2 || next === 3 || next === 4)
            position = positionValue(stream, next, budget);
          // `ReadListBegin` consumes the vaList marker that opens each item.
          const marker = stream.byte();
          if (marker !== 1)
            throw new StreamEnd(
              `Collection item does not start with vaList (found ${valueTypeName(marker)}).`,
            );
        } catch (error) {
          if (!(error instanceof StreamEnd)) throw error;
          // Keep a completed position (and any bytes already read for this
          // item) as a partial item instead of leaving them only in the
          // collection range, then keep every earlier item.
          if (position !== null || stream.position > itemAt)
            items.push({
              position,
              properties: [],
              location: range(itemAt, stream.position),
            });
          stop(error.message);
        }
        const properties: DelphiFormProperty[] = [];
        for (;;) {
          let nextProperty: number;
          try {
            nextProperty = stream.peek();
          } catch (error) {
            if (!(error instanceof StreamEnd)) throw error;
            // Keep the item and its properties decoded so far.
            items.push({
              position,
              properties,
              location: range(itemAt, stream.position),
            });
            stop(error.message);
          }
          if (nextProperty === 0) break;
          const propertyAt = stream.position;
          try {
            spend(budget, "properties");
            spendBytes(budget, PROPERTY_BYTES);
          } catch (error) {
            if (!(error instanceof StreamEnd)) throw error;
            // The item was opened; keep it with the properties decoded so far
            // before the property budget ends the collection.
            items.push({
              position,
              properties,
              location: range(itemAt, stream.position),
            });
            stop(error.message);
          }
          let name: DelphiFormText;
          try {
            name = readShortString(stream, codePage, budget);
          } catch (error) {
            if (!(error instanceof StreamEnd)) throw error;
            // The item itself was observed; keep it and every earlier item on
            // the partial collection instead of collapsing to one unknown.
            items.push({
              position,
              properties,
              location: range(itemAt, stream.position),
            });
            stop(error.message);
          }
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
                      bytes_hex: "",
                      truncated: stream.remaining > 0,
                      location: range(stream.position, stream.position),
                    },
              location: range(propertyAt, stream.position),
            });
            items.push({
              position,
              properties,
              location: range(itemAt, stream.position),
            });
            throw new StoppedValue(error.message, {
              kind: "collection",
              items,
              terminated: false,
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
        terminated: true,
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
  spendBytes(budget, OBJECT_BYTES);
  // Nested components recurse like values, so bound them before the call stack.
  if (depth > MAX_DELPHI_FORM_DEPTH)
    throw new StreamEnd(
      `Delphi form object nesting exceeds ${String(MAX_DELPHI_FORM_DEPTH)} levels.`,
    );
  const at = stream.position;
  const flags: string[] = [];
  let childPosition: DelphiFormPosition | null = null;
  let className: DelphiFormText | null = null;
  let componentName: DelphiFormText | null = null;
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
    unknown: formUnknown(
      reason,
      // Keep the bytes that could not be decoded, not the header bytes the
      // object fields and their locations already describe.
      stream.bytes.subarray(stream.position, stream.end),
      range(stream.position, stream.end),
    ),
  });
  try {
    const prefix = stream.peek();
    if ((prefix & 0xf0) === 0xf0) {
      stream.byte();
      for (const [bit, name] of DELPHI_FORM_FILER_FLAGS.entries())
        if ((prefix & (1 << bit)) !== 0) flags.push(name);
      // Only bits 0-2 are defined by TFilerFlag. Dropping a reserved low bit
      // would present a malformed or newer stream as fully decoded.
      if ((prefix & 0x08) !== 0)
        throw new StreamEnd(
          "Unsupported filer flag bit 0x08 in the component prefix.",
        );
      if ((prefix & 0x02) !== 0) {
        const tag = stream.peek();
        if (tag !== 2 && tag !== 3 && tag !== 4)
          throw new StreamEnd("Child position is not encoded as vaInt8/16/32.");
        childPosition = positionValue(stream, tag, budget);
      }
    }
    // Keep a complete class name when the component name is truncated, and stop
    // every ancestor: resuming at the unread name bytes would invent siblings.
    className = readShortString(stream, codePage, budget);
    componentName = readShortString(stream, codePage, budget);
  } catch (error) {
    if (error instanceof StoppedForm) throw error;
    if (!(error instanceof StreamEnd)) throw error;
    throw new StoppedForm(partial(error.message));
  }
  try {
    for (;;) {
      if (stream.peek() === 0) break;
      const propertyAt = stream.position;
      spend(budget, "properties");
      spendBytes(budget, PROPERTY_BYTES);
      const name = readShortString(stream, codePage, budget);
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
                  bytes_hex: "",
                  truncated: stream.remaining > 0,
                  location: range(stream.position, stream.position),
                },
          location: range(propertyAt, stream.position),
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
          unknown: formUnknown(
            error.message,
            stream.bytes.subarray(childAt, stream.position),
            range(childAt, stream.position),
          ),
        });
        throw new StoppedForm(partial(error.message));
      }
    }
    stream.byte();
  } catch (error) {
    if (error instanceof StoppedForm) throw error;
    if (!(error instanceof StreamEnd)) throw error;
    throw new StoppedForm(partial(error.message));
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
  options: {
    readonly code_page?: string;
    readonly max_text_bytes?: number;
    readonly max_bytes?: number;
  } = {},
): DelphiFormDecode | null => {
  if (start < 0 || end > bytes.length || end <= start) return null;
  const signature = detectDelphiFormSignature(bytes, start, end);
  if (signature === null) return null;
  const codePage = options.code_page ?? DEFAULT_CODE_PAGE;
  const budget: Budget = {
    objects: MAX_OBJECTS,
    properties: MAX_PROPERTIES,
    values: MAX_VALUES,
    text: Math.min(
      MAX_TEXT_BYTES,
      Math.max(0, options.max_text_bytes ?? MAX_TEXT_BYTES),
    ),
    bytes: Math.min(
      MAX_RETAINED_BYTES,
      Math.max(0, options.max_bytes ?? MAX_RETAINED_BYTES),
    ),
  };
  const stream = new Stream(
    bytes,
    end,
    signature.location.offset + signature.location.bytes,
  );
  let root: DelphiFormObject;
  try {
    if (stream.remaining > 0) root = readObject(stream, budget, codePage, 0);
    else
      // A filer stream must contain a root component; report the payload as
      // truncated instead of presenting an intentionally empty form.
      root = {
        location: range(stream.position, stream.position),
        flags: [],
        child_position: null,
        class_name: null,
        component_name: null,
        properties: [],
        children: [],
        unknown: formUnknown(
          "Payload ends after the filer signature without a root component.",
          stream.bytes.subarray(stream.position, end),
          range(stream.position, end),
        ),
      };
    // A suffix after the root terminator is part of the payload but nothing
    // decoded claims it; report it instead of presenting a complete decode.
    if (root.unknown === null && stream.remaining > 0)
      root = {
        ...root,
        unknown: formUnknown(
          `${String(stream.remaining)} bytes follow the root component terminator.`,
          stream.bytes.subarray(stream.position, end),
          range(stream.position, end),
        ),
      };
  } catch (error) {
    // A stopped form still carries everything decoded before the stop.
    if (error instanceof StoppedForm) root = error.object;
    else if (error instanceof StreamEnd)
      root = {
        location: range(stream.position, stream.position),
        flags: [],
        child_position: null,
        class_name: null,
        component_name: null,
        properties: [],
        children: [],
        unknown: formUnknown(
          error.message,
          stream.bytes.subarray(stream.position, end),
          range(stream.position, end),
        ),
      };
    else throw error;
  }
  return { signature, code_page: codePage, root };
};
