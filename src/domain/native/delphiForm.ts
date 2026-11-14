import { z } from "zod";

/**
 * A Delphi/C++Builder binary form (`TPF0`) decoded from a resource payload.
 *
 * Every decoded projection keeps the bytes and the location it came from, so a
 * claim can be traced back to the resource. Values that cannot be decoded are
 * reported as explicit unknowns rather than dropped.
 */

/** A half-open byte range inside the resource payload. */
export type DelphiFormRange = {
  readonly offset: number;
  readonly bytes: number;
};

/** A short length-prefixed string: original bytes kept next to the decode. */
export type DelphiFormText = {
  readonly text: string;
  readonly bytes_hex: string;
  readonly code_page: string;
  readonly location: DelphiFormRange;
};

/**
 * A signed positional integer. The encoded width, source bytes and range stay
 * with the value so equal positions encoded as vaInt8/16/32 remain distinct.
 */
export type DelphiFormPosition = {
  readonly kind: "integer";
  readonly text: string;
  readonly bytes_hex: string;
  readonly width: 8 | 16 | 32;
  readonly signed: true;
  readonly location: DelphiFormRange;
};

/** One item of a `vaCollection` value. */
export type DelphiFormCollectionItem = {
  readonly position: DelphiFormPosition | null;
  readonly properties: DelphiFormProperty[];
  readonly location: DelphiFormRange;
};

/** A property assignment: name, declared value type and decoded value. */
export type DelphiFormProperty = {
  readonly name: DelphiFormText;
  readonly value_type: string;
  readonly value: DelphiFormValue;
  readonly location: DelphiFormRange;
};

/** A decoded property value. Structural values carry their children. */
export type DelphiFormValue =
  | { readonly kind: "null"; readonly location: DelphiFormRange }
  | { readonly kind: "nil"; readonly location: DelphiFormRange }
  | {
      readonly kind: "boolean";
      readonly value: boolean;
      readonly location: DelphiFormRange;
    }
  | {
      readonly kind: "integer";
      readonly text: string;
      readonly bytes_hex: string;
      readonly width: 8 | 16 | 32 | 64;
      readonly signed: boolean;
      readonly location: DelphiFormRange;
    }
  | {
      readonly kind: "float";
      readonly text: string | null;
      readonly bytes_hex: string;
      readonly note: string;
      readonly location: DelphiFormRange;
    }
  | {
      readonly kind: "string";
      readonly text: string;
      readonly bytes_hex: string;
      readonly code_page: string;
      readonly declared_bytes: number;
      readonly truncated: boolean;
      /** True only when decoding stopped before the declared bytes completed. */
      readonly decode_truncated: boolean;
      readonly location: DelphiFormRange;
    }
  | {
      readonly kind: "identifier";
      readonly text: string;
      readonly bytes_hex: string;
      readonly location: DelphiFormRange;
    }
  | {
      readonly kind: "binary";
      readonly bytes_hex: string;
      readonly declared_bytes: number;
      readonly truncated: boolean;
      /** True only when decoding stopped before the declared bytes completed. */
      readonly decode_truncated: boolean;
      readonly location: DelphiFormRange;
    }
  | {
      readonly kind: "list";
      readonly items: DelphiFormListEntry[];
      /** True only when the closing terminator was read. */
      readonly terminated: boolean;
      readonly location: DelphiFormRange;
    }
  | {
      readonly kind: "set";
      readonly names: DelphiFormText[];
      /** True only when the closing terminator was read. */
      readonly terminated: boolean;
      readonly location: DelphiFormRange;
    }
  | {
      readonly kind: "collection";
      readonly items: DelphiFormCollectionItem[];
      /** True only when the closing terminator was read. */
      readonly terminated: boolean;
      readonly location: DelphiFormRange;
    }
  | {
      readonly kind: "unknown";
      readonly reason: string;
      readonly bytes_hex: string;
      readonly truncated: boolean;
      readonly location: DelphiFormRange;
    };

/**
 * One `vaList` entry. A list item's type byte is the only source of its
 * declared `TValueType`; `vaWString` and `vaUString` otherwise decode alike.
 */
export type DelphiFormListEntry = {
  readonly value_type: string;
  readonly marker_location: DelphiFormRange;
  readonly value: DelphiFormValue;
};

/** A component: class and name, filer flags, properties and nested components. */
export type DelphiFormObject = {
  readonly location: DelphiFormRange;
  readonly flags: string[];
  readonly child_position: DelphiFormPosition | null;
  readonly class_name: DelphiFormText | null;
  readonly component_name: DelphiFormText | null;
  readonly properties: DelphiFormProperty[];
  readonly children: DelphiFormObject[];
  readonly unknown: {
    readonly reason: string;
    readonly bytes_hex: string;
    readonly truncated: boolean;
    readonly location: DelphiFormRange;
  } | null;
};

/** Declared `System.Classes.TValueType` names emitted by the decoder. */
export const DELPHI_FORM_VALUE_TYPES: readonly string[] = [
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
  "vaDouble",
  "vaUString",
  "vaQWord",
];

/** The declared type vocabulary accepted at the Evidence boundary. */
export const isDelphiFormValueType = (value: string): boolean => {
  if (value === "unknown" || DELPHI_FORM_VALUE_TYPES.includes(value))
    return true;
  const match = /^unknown_value_type\((\d{1,3})\)$/u.exec(value);
  if (match === null) return false;
  const ordinal = Number(match[1]);
  return ordinal >= 24 && ordinal <= 255 && String(ordinal) === match[1];
};

/** The decoder probes a filer signature within this many prefix bytes. */
export const MAX_DELPHI_FORM_SIGNATURE_PREFIX_BYTES = 16;

/** Retained hex previews keep at most this many source bytes. */
export const MAX_DELPHI_FORM_HEX_BYTES = 128;

/** Nested form objects and values are bounded at this depth. */
export const MAX_DELPHI_FORM_DEPTH = 32;

/** The decoder retains at most this many objects per form. */
export const MAX_DELPHI_FORM_OBJECTS = 1024;

/** The decoder retains at most this many properties per form. */
export const MAX_DELPHI_FORM_PROPERTIES = 8192;

/** The decoder retains at most this many values per form. */
export const MAX_DELPHI_FORM_VALUES = 32768;

/** Bounds decoded text and structural bytes per form. */
export const MAX_DELPHI_FORM_TEXT_BYTES = 8 * 1024 * 1024;
export const MAX_DELPHI_FORM_RETAINED_BYTES = 8 * 1024 * 1024;

/**
 * The producer only emits short diagnostic constants. A provider-controlled
 * reason or note longer than this cannot be an observed decoder message.
 */
export const MAX_DELPHI_FORM_DIAGNOSTIC_CHARS = 256;

/** Per-node bytes the decoder charges before retaining a projection. */
export const DELPHI_FORM_BYTE_CHARGES = {
  object: 192,
  property: 160,
  item: 96,
  listEntry: 128,
  value: 256,
  position: 128,
} as const;

/** Projected text charge for a short or sized string body. */
export const delphiFormTextCharge = (bytes: number): number => bytes * 10 + 256;

/** Projected text and byte charge for a binary preview. */
export const delphiFormBinaryCharge = (available: number): number =>
  Math.min(available, MAX_DELPHI_FORM_HEX_BYTES) * 2 + 256;

/**
 * `TFilerFlag` values the decoder can emit. It emits each once, in bit order,
 * and stops on the reserved bit, so no other flag is an observed value.
 */
export const DELPHI_FORM_FILER_FLAGS = [
  "ffInherited",
  "ffChildPos",
  "ffInline",
] as const;

const utf16le = new TextDecoder("utf-16le", { ignoreBOM: true });

/**
 * Decode short Pascal-string bytes with the declared code page. `latin1` is
 * only a last resort for labels that cannot be decoded; it never replaces a
 * declared page.
 */
export const decodeDelphiText = (raw: Buffer, codePage: string): string => {
  if (codePage === "utf-16le") return utf16le.decode(raw);
  if (codePage === "utf-8") return raw.toString("utf8");
  // `TextDecoder` maps the "latin1" label to Windows-1252, which changes bytes
  // such as 0x80. Keep the byte-preserving projection for this sentinel.
  if (codePage === "latin1") return raw.toString("latin1");
  try {
    return new TextDecoder(codePage).decode(raw);
  } catch {
    return raw.toString("latin1");
  }
};

/** Notes emitted for each floating-point value type. */
export const DELPHI_FORM_FLOAT_NOTES: Readonly<Record<string, string>> = {
  vaSingle: "IEEE-754 binary32.",
  vaDouble: "IEEE-754 binary64.",
  vaExtended:
    "Ten-byte x87 extended value reduced to a double; extra precision is not retained.",
  vaCurrency: "Currency: signed 64-bit value scaled by 10000.",
  vaDate: "TDateTime: days since 1899-12-30, not converted to a calendar date.",
};

/**
 * Round `significand * 2 ** scale` to the nearest binary64 value. The integer
 * significand stays intact until the final rounding step: converting it to a
 * double first can cross a subnormal midpoint that the later scaling needs.
 */
const roundExtendedToDouble = (significand: bigint, scale: number): number => {
  const exponent = scale + significand.toString(2).length - 1;
  // Below the smallest normal every value is a multiple of 2^-1074;
  // otherwise round to 53 significant bits.
  const quantum = exponent < -1022 ? -1074 : exponent - 52;
  const shift = scale - quantum;
  let rounded: bigint;
  if (shift >= 0) {
    rounded = significand << BigInt(shift);
  } else {
    const dropped = BigInt(-shift);
    rounded = significand >> dropped;
    const remainder = significand & ((1n << dropped) - 1n);
    const halfway = 1n << (dropped - 1n);
    if (remainder > halfway || (remainder === halfway && (rounded & 1n) !== 0n))
      rounded += 1n;
  }
  return Number(rounded) * 2 ** quantum;
};

/**
 * Convert the ten-byte x87 extended value used by `vaExtended` to a double.
 * Precision beyond a double is not retained and is reported to the caller.
 */
export const decodeDelphiExtended = (raw: Buffer): number | null => {
  if (raw.length !== 10) return null;
  const mantissa = raw.readBigUInt64LE(0);
  const exponentAndSign = raw.readUInt16LE(8);
  const exponent = exponentAndSign & 0x7fff;
  if (exponent === 0x7fff) return null;
  if (exponent === 0 && mantissa === 0n) return 0;
  const sign = (exponentAndSign & 0x8000) === 0 ? 1 : -1;
  const value = roundExtendedToDouble(mantissa, exponent - 16383 - 63);
  return Number.isFinite(value) ? sign * value : null;
};

/** Format a signed 64-bit currency value scaled by 10000. */
export const formatDelphiCurrency = (raw: Buffer): string => {
  const scaled = raw.readBigInt64LE(0);
  const sign = scaled < 0n ? "-" : "";
  const digits = (scaled < 0n ? -scaled : scaled).toString().padStart(5, "0");
  return `${sign}${digits.slice(0, -4)}.${digits.slice(-4)}`;
};

/** Where the code page came from: the resource, a default, or neither. */
export type DelphiFormCodePageSource = "resource" | "default" | "unsupported";

/** Delphi 7 ANSI default, used only when the resource declares no code page. */
export const DEFAULT_CODE_PAGE = "windows-1252";

/**
 * Windows code page ids that the host's `TextDecoder` can label. The decoder
 * and the Evidence boundary share this table so both agree on which
 * declarations are supported.
 */
export const RESOURCE_CODE_PAGES: Readonly<Record<number, string>> = {
  866: "ibm866",
  874: "windows-874",
  932: "shift_jis",
  936: "gbk",
  949: "euc-kr",
  950: "big5",
  1200: "utf-16le",
  1201: "utf-16be",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: DEFAULT_CODE_PAGE,
  1253: "windows-1253",
  1254: "windows-1254",
  1255: "windows-1255",
  1256: "windows-1256",
  1257: "windows-1257",
  1258: "windows-1258",
  10000: "macintosh",
  10007: "x-mac-cyrillic",
  20866: "koi8-r",
  20932: "euc-jp",
  21866: "koi8-u",
  // 28591 (ISO-8859-1), 28599 (ISO-8859-9) and 28601 (ISO-8859-11) are
  // intentionally absent: the host aliases those labels to windows-1252,
  // windows-1254 and windows-874, which changes bytes outside the declared
  // repertoire. They keep the byte-preserving unsupported path instead.
  28592: "iso-8859-2",
  28593: "iso-8859-3",
  28594: "iso-8859-4",
  28595: "iso-8859-5",
  28596: "iso-8859-6",
  28597: "iso-8859-7",
  28598: "iso-8859-8",
  28600: "iso-8859-10",
  28603: "iso-8859-13",
  28604: "iso-8859-14",
  28605: "iso-8859-15",
  28606: "iso-8859-16",
  38598: "iso-8859-8-i",
  50220: "iso-2022-jp",
  51932: "euc-jp",
  51949: "euc-kr",
  54936: "gb18030",
  65001: "utf-8",
};

/** Keeps every byte as one code unit when the declared page cannot be labelled. */
export const BYTE_PRESERVING_CODE_PAGE = "latin1";

/** One RT_RCDATA payload decoded as a binary form. */
export type DelphiFormResource = {
  readonly resource_index: number;
  readonly signature: "TPF0" | "TPF1";
  readonly version: "boVersion0" | "boVersion1";
  readonly signature_location: DelphiFormRange;
  readonly prefix: {
    readonly location: DelphiFormRange;
    readonly bytes_hex: string;
    readonly note: string;
  } | null;
  /** The resource's declared code page id; zero means none was declared. */
  readonly declared_code_page: number;
  readonly code_page: string;
  readonly code_page_source: DelphiFormCodePageSource;
  readonly root: DelphiFormObject;
};

const uint = z.number().int().min(0).max(0xffffffff);
// A wide string's declared byte count doubles a uint32 character count.
const declaredStringBytes = z.number().int().min(0).max(0x1fffffffe);
const hexSchema = z.string().regex(/^(?:[0-9a-f]{2})*$/u);
const rangeSchema = z.strictObject({ offset: uint, bytes: uint });
// The producer emits each declared filer flag once, in `TFilerFlag` bit order;
// an invented, duplicated or reordered flag is not a value it can observe.
const filerFlagsSchema = z
  .array(z.enum(DELPHI_FORM_FILER_FLAGS))
  .refine(
    (flags) =>
      flags.every(
        (flag, index) =>
          index === 0 ||
          DELPHI_FORM_FILER_FLAGS.indexOf(flags[index - 1]!) <
            DELPHI_FORM_FILER_FLAGS.indexOf(flag),
      ),
    { message: "Filer flags must follow the producer's bit order." },
  );
const textSchema = z.strictObject({
  text: z.string(),
  bytes_hex: hexSchema,
  code_page: z.string(),
  location: rangeSchema,
});
const integerValueSchema = z.strictObject({
  kind: z.literal("integer"),
  text: z.string(),
  bytes_hex: hexSchema,
  width: z.union([z.literal(8), z.literal(16), z.literal(32), z.literal(64)]),
  signed: z.boolean(),
  location: rangeSchema,
});
const positionSchema: z.ZodType<DelphiFormPosition> = z.strictObject({
  kind: z.literal("integer"),
  text: z.string(),
  bytes_hex: hexSchema,
  width: z.union([z.literal(8), z.literal(16), z.literal(32)]),
  signed: z.literal(true),
  location: rangeSchema,
});

/**
 * Every recursive position is built twice from the same field builders: the
 * runtime schema nests the real recursive schemas, while the advertised shape
 * nests a bounded stand-in. Known fields and discriminators such as `kind`,
 * `class_name` and `location` stay machine-readable in the advertised
 * contract, and only the recursive child/item edges are relaxed to opaque
 * objects whose members follow the same shape — the way the shared JSON value
 * boundary projects.
 */
const boundedChild = z
  .looseObject({})
  .describe(
    "A nested form object, property, collection item or value; its members follow the same shape.",
  );

const propertySchemaOf = <V extends z.ZodType>(value: V) =>
  z.strictObject({
    name: textSchema,
    value_type: z.string(),
    value,
    location: rangeSchema,
  });

const collectionItemSchemaOf = <P extends z.ZodType>(property: P) =>
  z.strictObject({
    position: positionSchema.nullable(),
    properties: z.array(property),
    location: rangeSchema,
  });

const listEntrySchemaOf = <V extends z.ZodType>(value: V) =>
  z.strictObject({
    value_type: z.string(),
    marker_location: rangeSchema,
    value,
  });

const valueSchemaOf = <V extends z.ZodType, C extends z.ZodType>(
  value: V,
  collectionItem: C,
) =>
  z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("null"), location: rangeSchema }),
    z.strictObject({ kind: z.literal("nil"), location: rangeSchema }),
    z.strictObject({
      kind: z.literal("boolean"),
      value: z.boolean(),
      location: rangeSchema,
    }),
    integerValueSchema,
    z.strictObject({
      kind: z.literal("float"),
      text: z.string().nullable(),
      bytes_hex: hexSchema,
      note: z.string().max(MAX_DELPHI_FORM_DIAGNOSTIC_CHARS),
      location: rangeSchema,
    }),
    z.strictObject({
      kind: z.literal("string"),
      text: z.string(),
      bytes_hex: hexSchema,
      code_page: z.string(),
      declared_bytes: declaredStringBytes,
      truncated: z.boolean(),
      decode_truncated: z.boolean(),
      location: rangeSchema,
    }),
    z.strictObject({
      kind: z.literal("identifier"),
      text: z.string(),
      bytes_hex: hexSchema,
      location: rangeSchema,
    }),
    z.strictObject({
      kind: z.literal("binary"),
      bytes_hex: hexSchema,
      declared_bytes: uint,
      truncated: z.boolean(),
      decode_truncated: z.boolean(),
      location: rangeSchema,
    }),
    z.strictObject({
      kind: z.literal("list"),
      items: z.array(listEntrySchemaOf(value)),
      terminated: z.boolean(),
      location: rangeSchema,
    }),
    z.strictObject({
      kind: z.literal("set"),
      names: z.array(textSchema),
      terminated: z.boolean(),
      location: rangeSchema,
    }),
    z.strictObject({
      kind: z.literal("collection"),
      items: z.array(collectionItem),
      terminated: z.boolean(),
      location: rangeSchema,
    }),
    z.strictObject({
      kind: z.literal("unknown"),
      reason: z.string().max(MAX_DELPHI_FORM_DIAGNOSTIC_CHARS),
      bytes_hex: hexSchema,
      truncated: z.boolean(),
      location: rangeSchema,
    }),
  ]);

const objectSchemaOf = <P extends z.ZodType, O extends z.ZodType>(
  property: P,
  object: O,
) =>
  z.strictObject({
    location: rangeSchema,
    flags: filerFlagsSchema,
    child_position: positionSchema.nullable(),
    class_name: textSchema.nullable(),
    component_name: textSchema.nullable(),
    properties: z.array(property),
    children: z.array(object),
    unknown: z
      .strictObject({
        reason: z.string().max(MAX_DELPHI_FORM_DIAGNOSTIC_CHARS),
        bytes_hex: hexSchema,
        truncated: z.boolean(),
        location: rangeSchema,
      })
      .nullable(),
  });

const propertySchema: z.ZodType<DelphiFormProperty> = z.lazy(() =>
  propertySchemaOf(valueSchema),
);

const collectionItemSchema: z.ZodType<DelphiFormCollectionItem> = z.lazy(() =>
  collectionItemSchemaOf(propertySchema),
);

const valueSchema: z.ZodType<DelphiFormValue> = z.lazy(() =>
  valueSchemaOf(valueSchema, collectionItemSchema),
);

const objectSchema: z.ZodType<DelphiFormObject> = z.lazy(() =>
  objectSchemaOf(propertySchema, objectSchema),
);

// Values and collection items are mutually recursive (value -> collection ->
// item -> property -> value), so the advertised shape fully expands one level
// — keeping every field and discriminator present — and bounds the deeper
// recursive edges.
const advertisedNestedValue = valueSchemaOf(boundedChild, boundedChild);
const advertisedCollectionItem = collectionItemSchemaOf(
  propertySchemaOf(advertisedNestedValue),
);
const advertisedValue = valueSchemaOf(
  advertisedNestedValue,
  advertisedCollectionItem,
);
const advertisedProperty = propertySchemaOf(advertisedValue);
const advertisedObject = objectSchemaOf(advertisedProperty, boundedChild);

propertySchema._zod.toJSONSchema = () => z.toJSONSchema(advertisedProperty);
collectionItemSchema._zod.toJSONSchema = () =>
  z.toJSONSchema(advertisedCollectionItem);
valueSchema._zod.toJSONSchema = () => z.toJSONSchema(advertisedValue);
objectSchema._zod.toJSONSchema = () => z.toJSONSchema(advertisedObject);

export const delphiFormResourceSchema: z.ZodType<DelphiFormResource> =
  z.strictObject({
    resource_index: uint,
    signature: z.enum(["TPF0", "TPF1"]),
    version: z.enum(["boVersion0", "boVersion1"]),
    signature_location: rangeSchema,
    prefix: z
      .strictObject({
        location: rangeSchema,
        bytes_hex: hexSchema,
        note: z.string().max(MAX_DELPHI_FORM_DIAGNOSTIC_CHARS),
      })
      .nullable(),
    declared_code_page: uint,
    code_page: z.string(),
    code_page_source: z.enum(["resource", "default", "unsupported"]),
    root: objectSchema,
  });
