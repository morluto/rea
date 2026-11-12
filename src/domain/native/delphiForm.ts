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

/** One item of a `vaCollection` value. */
export type DelphiFormCollectionItem = {
  readonly position: string | null;
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
      readonly location: DelphiFormRange;
    }
  | {
      readonly kind: "list";
      readonly items: DelphiFormValue[];
      readonly location: DelphiFormRange;
    }
  | {
      readonly kind: "set";
      readonly names: DelphiFormText[];
      readonly location: DelphiFormRange;
    }
  | {
      readonly kind: "collection";
      readonly items: DelphiFormCollectionItem[];
      readonly location: DelphiFormRange;
    }
  | {
      readonly kind: "unknown";
      readonly reason: string;
      readonly bytes_hex: string;
      readonly truncated: boolean;
      readonly location: DelphiFormRange;
    };

/** A component: class and name, filer flags, properties and nested components. */
export type DelphiFormObject = {
  readonly location: DelphiFormRange;
  readonly flags: string[];
  readonly child_position: string | null;
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
  // 28591 (ISO-8859-1) and 28601 (ISO-8859-11) are intentionally absent:
  // the host aliases those labels to windows-1252 and windows-874, which
  // changes bytes outside the declared repertoire. They keep the
  // byte-preserving unsupported path instead.
  28592: "iso-8859-2",
  28593: "iso-8859-3",
  28594: "iso-8859-4",
  28595: "iso-8859-5",
  28596: "iso-8859-6",
  28597: "iso-8859-7",
  28598: "iso-8859-8",
  28599: "iso-8859-9",
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
const textSchema = z.strictObject({
  text: z.string(),
  bytes_hex: hexSchema,
  code_page: z.string(),
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
    position: z.string().nullable(),
    properties: z.array(property),
    location: rangeSchema,
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
    z.strictObject({
      kind: z.literal("integer"),
      text: z.string(),
      width: z.union([
        z.literal(8),
        z.literal(16),
        z.literal(32),
        z.literal(64),
      ]),
      signed: z.boolean(),
      location: rangeSchema,
    }),
    z.strictObject({
      kind: z.literal("float"),
      text: z.string().nullable(),
      bytes_hex: hexSchema,
      note: z.string(),
      location: rangeSchema,
    }),
    z.strictObject({
      kind: z.literal("string"),
      text: z.string(),
      bytes_hex: hexSchema,
      code_page: z.string(),
      declared_bytes: declaredStringBytes,
      truncated: z.boolean(),
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
      location: rangeSchema,
    }),
    z.strictObject({
      kind: z.literal("list"),
      items: z.array(value),
      location: rangeSchema,
    }),
    z.strictObject({
      kind: z.literal("set"),
      names: z.array(textSchema),
      location: rangeSchema,
    }),
    z.strictObject({
      kind: z.literal("collection"),
      items: z.array(collectionItem),
      location: rangeSchema,
    }),
    z.strictObject({
      kind: z.literal("unknown"),
      reason: z.string(),
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
    flags: z.array(z.string()),
    child_position: z.string().nullable(),
    class_name: textSchema.nullable(),
    component_name: textSchema.nullable(),
    properties: z.array(property),
    children: z.array(object),
    unknown: z
      .strictObject({
        reason: z.string(),
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
        note: z.string(),
      })
      .nullable(),
    declared_code_page: uint,
    code_page: z.string(),
    code_page_source: z.enum(["resource", "default", "unsupported"]),
    root: objectSchema,
  });
