import { z } from "zod";
import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";

/** Little-endian int32 at offset zero of every binary content catalog. */
export const UNITY_ADDRESSABLES_BINARY_MAGIC = 0x0de38942;

/** Binary catalog versions with a layout checked against a built sample. */
export const UNITY_ADDRESSABLES_BINARY_VERSIONS = [2, 3] as const;

const count = z.number().int().nonnegative();
const rowIndex = count;

/** One explicit local catalog; detail selects delivery, never decoding coverage. */
export const inspectUnityAddressablesInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to a Unity Addressables content catalog (catalog.json or catalog.bin)",
  ),
  detail: z
    .enum(["complete", "summary"])
    .default("summary")
    .describe(
      "summary (default) retains complete Evidence and returns identity and counts; complete returns every key, location and provider inline",
    ),
  hash_path: absoluteLocalPathStringSchema
    .optional()
    .describe(
      "Absolute path to the caller-selected catalog.hash file to record next to the catalog; its text is reported, not recomputed",
    ),
});

const artifactSchema = z.strictObject({
  path: z.string(),
  sha256: digestSchema,
  bytes: count,
});

/** Serialized key encodings shared by both catalog formats. */
export const UNITY_ADDRESSABLES_KEY_KINDS = [
  "string",
  "int32",
  "uint32",
  "uint16",
  "hash128",
  "type",
  "object",
] as const;

/** A lookup key and the locations it selects, in catalog order. */
export const unityAddressablesKeySchema = z.strictObject({
  kind: z.enum(UNITY_ADDRESSABLES_KEY_KINDS),
  /**
   * Text form; decimal for integers. Null for an object key, whose type is
   * reported instead, and for a binary string key stored as no object (an
   * empty or null string).
   */
  value: z.string().nullable(),
  /**
   * Serialized class name of an object key; null for other keys and for a
   * binary object key whose type record stores no class name.
   */
  type_name: z.string().nullable(),
  locations: z.array(rowIndex),
});

/** Asset bundle request options recorded for a bundle location. */
export const unityAddressablesBundleSchema = z.strictObject({
  kind: z.literal("asset-bundle"),
  /** Hash128 as 32 lowercase hexadecimal characters. */
  hash: z.string(),
  crc: z.number().int().min(0).max(0xffffffff),
  bundle_name: z.string().nullable(),
  bundle_size: count,
});

const locationDataSchema = z.union([
  unityAddressablesBundleSchema,
  z.strictObject({
    kind: z.literal("other"),
    /** Serialized class name, null when a binary type record stores none; the payload is not decoded. */
    type_name: z.string().nullable(),
  }),
]);

/** One resource location; row position is its stable index within this report. */
export const unityAddressablesLocationSchema = z.strictObject({
  /** Null only when a binary record stores no string (the writer's empty or null value). */
  primary_key: z.string().nullable(),
  /** InternalId after prefix expansion; runtime `{...}` placeholders stay unresolved. */
  internal_id: z.string().nullable(),
  provider_id: z.string().nullable(),
  resource_type: z.string().nullable(),
  /** Locations this one depends on, in serialized order. */
  dependencies: z.array(rowIndex),
  /** JSON catalogs name dependencies by key index; binary catalogs have none. */
  dependency_key: rowIndex.nullable(),
  dependency_hash: z.number().int(),
  data: locationDataSchema.nullable(),
  /** File offset of the binary location record; null for JSON entries. */
  offset: count.nullable(),
});

/** Provider construction data recorded in the catalog header. */
export const unityAddressablesProviderSchema = z.strictObject({
  role: z.enum(["instance", "scene", "resource"]),
  id: z.string().nullable(),
  type_name: z.string().nullable(),
  assembly: z.string().nullable(),
});

export const unityAddressablesHashFileSchema = z.strictObject({
  artifact: artifactSchema,
  /** File text with trailing whitespace removed; null when it is not printable ASCII. */
  text: z.string().nullable(),
});

export const unityAddressablesObjectSchema = z.strictObject({
  artifact: artifactSchema,
  format: z.enum(["json", "binary"]),
  /** Binary header version; JSON catalogs record none. */
  format_version: count.nullable(),
  locator_id: z.string().nullable(),
  build_result_hash: z.string().nullable(),
  /** key-locations: resolved through the JSON dependency key; location-records: read from binary arrays. */
  dependency_basis: z.enum(["key-locations", "location-records"]),
  providers: z.array(unityAddressablesProviderSchema),
  keys: z.array(unityAddressablesKeySchema),
  locations: z.array(unityAddressablesLocationSchema),
  hash_file: unityAddressablesHashFileSchema.nullable(),
  limitations: z.array(z.string()),
});

const validateCatalogFacts = (
  report: z.infer<typeof unityAddressablesObjectSchema>,
  context: z.RefinementCtx,
): void => {
  const json = report.format === "json";
  if (json !== (report.format_version === null))
    context.addIssue({
      code: "custom",
      path: ["format_version"],
      message: "Only binary catalogs record a format version.",
    });
  if (json !== (report.dependency_basis === "key-locations"))
    context.addIssue({
      code: "custom",
      path: ["dependency_basis"],
      message:
        "JSON dependencies resolve through keys; binary dependencies are location records.",
    });
  const locations = report.locations.length;
  report.keys.forEach((key, index) => {
    if (key.locations.some((location) => location >= locations))
      context.addIssue({
        code: "custom",
        path: ["keys", index, "locations"],
        message: "Key selects a location outside the retained locations.",
      });
    if (
      key.kind === "object"
        ? key.value !== null
        : key.value === null && (json || key.kind !== "string")
    )
      context.addIssue({
        code: "custom",
        path: ["keys", index, "value"],
        message:
          "Object keys have no text value; other keys have one, except a binary string stored as no object.",
      });
    if (key.kind !== "object" && key.type_name !== null)
      context.addIssue({
        code: "custom",
        path: ["keys", index, "type_name"],
        message: "Only object keys carry a type name.",
      });
  });
  report.locations.forEach((location, index) => {
    if (location.dependencies.some((dependency) => dependency >= locations))
      context.addIssue({
        code: "custom",
        path: ["locations", index, "dependencies"],
        message: "Dependency is outside the retained locations.",
      });
    if (json !== (location.offset === null))
      context.addIssue({
        code: "custom",
        path: ["locations", index, "offset"],
        message: "Exactly binary locations carry a record offset.",
      });
    if (
      location.dependency_key !== null &&
      (!json || location.dependency_key >= report.keys.length)
    )
      context.addIssue({
        code: "custom",
        path: ["locations", index, "dependency_key"],
        message:
          "Only JSON locations name a dependency key, and it must be a retained key.",
      });
    if (
      json &&
      location.dependency_key !== null &&
      JSON.stringify(location.dependencies) !==
        JSON.stringify(report.keys[location.dependency_key]?.locations)
    )
      context.addIssue({
        code: "custom",
        path: ["locations", index, "dependencies"],
        message:
          "JSON dependencies are exactly the dependency key's locations.",
      });
    if (
      json &&
      location.offset === null &&
      [
        location.primary_key,
        location.internal_id,
        location.provider_id,
      ].includes(null)
    )
      context.addIssue({
        code: "custom",
        path: ["locations", index],
        message:
          "JSON entries always name a primary key, internal id and provider.",
      });
    if (
      json &&
      location.dependency_key === null &&
      location.dependencies.length > 0
    )
      context.addIssue({
        code: "custom",
        path: ["locations", index, "dependencies"],
        message: "JSON dependencies require a dependency key.",
      });
  });
};

export const unityAddressablesSchema =
  unityAddressablesObjectSchema.superRefine(validateCatalogFacts);

export type InspectUnityAddressablesInput = z.infer<
  typeof inspectUnityAddressablesInputSchema
>;
export type UnityAddressablesProviderInput = Omit<
  InspectUnityAddressablesInput,
  "detail"
>;
export type UnityAddressables = z.infer<typeof unityAddressablesSchema>;
export type UnityAddressablesKey = z.infer<typeof unityAddressablesKeySchema>;
export type UnityAddressablesLocation = z.infer<
  typeof unityAddressablesLocationSchema
>;
export type UnityAddressablesProvider = z.infer<
  typeof unityAddressablesProviderSchema
>;
