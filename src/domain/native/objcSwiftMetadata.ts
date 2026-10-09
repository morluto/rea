import { z } from "zod";

/** Objective-C method type. */
export const objcMethodTypeSchema = z.enum([
  "instance",
  "class",
  "ivar_getter",
  "ivar_setter",
]);

/** Objective-C property attribute. */
export const objcPropertyAttributeSchema = z.strictObject({
  name: z.string().min(1),
  value: z.string(),
});

/** Objective-C method metadata. */
export const objcMethodSchema = z.strictObject({
  selector: z.string().min(1),
  method_type: objcMethodTypeSchema,
  address: z.number().int().nullable(),
  is_required: z.boolean().nullable(),
  is_optional: z.boolean().nullable(),
});
type ObjcMethod = z.infer<typeof objcMethodSchema>;

/** Objective-C property metadata. */
export const objcPropertySchema = z.strictObject({
  name: z.string().min(1),
  type_encoding: z.string().nullable(),
  attributes: z.array(objcPropertyAttributeSchema),
  atomicity: z.enum(["atomic", "nonatomic"]).nullable(),
  is_readonly: z.boolean().nullable(),
  getter: z.string().nullable(),
  setter: z.string().nullable(),
});

/** Objective-C protocol metadata. */
export const objcProtocolSchema = z.strictObject({
  name: z.string().min(1),
  methods: z.array(objcMethodSchema).default([]),
  optional_methods: z.array(objcMethodSchema).default([]),
  properties: z.array(objcPropertySchema).default([]),
});

/** Objective-C class metadata. */
export const objcClassSchema = z.strictObject({
  name: z.string().min(1),
  super_class: z.string().nullable(),
  is_meta_class: z.boolean().nullable(),
  is_root_class: z.boolean().nullable(),
  methods: z.array(objcMethodSchema).default([]),
  properties: z.array(objcPropertySchema).default([]),
  protocols: z.array(z.string()).default([]),
  ivar_count: z.number().int().nonnegative().nullable(),
  instance_size: z.number().int().nonnegative().nullable(),
  location: z
    .object({
      address: z.string().nullable(),
      file_offset: z.number().int().nonnegative().nullable(),
    })
    .optional(),
  superclass_address: z.string().nullable().optional(),
  metaclass_address: z.string().nullable().optional(),
  decode: z
    .object({
      status: z.enum(["decoded", "partial", "unsupported", "invalid"]),
      reason: z.string().nullable(),
    })
    .optional(),
  evidence: z
    .array(
      z.object({
        kind: z.literal("binary_metadata"),
        description: z.string(),
        location: z.object({
          address: z.string().nullable(),
          file_offset: z.number().int().nonnegative().nullable(),
        }),
        artifact_path: z.string(),
        artifact_sha256: z.string(),
      }),
    )
    .optional(),
});
type ObjcClass = z.infer<typeof objcClassSchema>;

/** Exact location of a decoded native metadata value when the provider knows it. */
export const nativeMetadataLocationSchema = z.strictObject({
  address: z.string().nullable(),
  file_offset: z.number().int().nonnegative().nullable(),
});
export type NativeMetadataLocation = z.infer<
  typeof nativeMetadataLocationSchema
>;

/** Provider-neutral decode state; absence never silently means unsupported. */
export const nativeMetadataDecodeSchema = z.strictObject({
  status: z.enum(["decoded", "partial", "unsupported", "invalid"]),
  reason: z.string().nullable(),
});

/** Evidence attached to one dispatch edge or metadata record. */
export const nativeMetadataEvidenceSchema = z.strictObject({
  kind: z.enum([
    "binary_metadata",
    "interface_builder_resource",
    "symbol",
    "reference",
    "decompiler",
  ]),
  description: z.string().min(1),
  location: nativeMetadataLocationSchema,
  artifact_path: z.string().min(1).nullable().default(null),
  artifact_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable()
    .default(null),
});
export type NativeMetadataEvidence = z.infer<
  typeof nativeMetadataEvidenceSchema
>;

/** Objective-C ivar layout, retaining encoded type and exact storage offset. */
export const objcIvarSchema = z.strictObject({
  class_name: z.string().min(1),
  name: z.string().min(1),
  type_encoding: z.string().nullable(),
  offset: z.number().int().nonnegative().nullable(),
  size: z.number().int().nonnegative().nullable().default(null),
  alignment: z.number().int().positive().nullable().default(null),
  location: nativeMetadataLocationSchema,
  decode: nativeMetadataDecodeSchema,
  evidence: z.array(nativeMetadataEvidenceSchema).min(1),
});

/** Encoded Objective-C protocol declaration with required and optional method facts. */
export const objcProtocolRecordSchema = z.strictObject({
  name: z.string(),
  adopted_protocols: z.array(z.string()),
  methods: z.array(objcMethodSchema),
  optional_methods: z.array(objcMethodSchema),
  location: nativeMetadataLocationSchema,
  decode: nativeMetadataDecodeSchema,
  evidence: z.array(nativeMetadataEvidenceSchema).min(1),
});

/** Selector implementation resolved from a class or metaclass method list. */
export const objcDispatchImplementationSchema = z.strictObject({
  class_name: z.string().min(1),
  selector: z.string().min(1),
  method_type: z.enum(["instance", "class"]),
  implementation_address: z.string().nullable(),
  /** Category that adds this method, when it is not defined by the class itself. */
  category: z.string().nullable().optional(),
  location: nativeMetadataLocationSchema,
  decode: nativeMetadataDecodeSchema,
  evidence: z.array(nativeMetadataEvidenceSchema).min(1),
});
type ObjcDispatchImplementation = z.infer<
  typeof objcDispatchImplementationSchema
>;

/** Objective-C category: methods, protocols and properties added to a class. */
export const objcCategorySchema = z.strictObject({
  name: z.string().min(1),
  /** Extended class; external classes come from the category's bind symbol. */
  class_name: z.string().min(1).nullable(),
  class_source: z.enum(["local", "external", "unresolved"]),
  instance_methods: z.array(z.string()),
  class_methods: z.array(z.string()),
  protocols: z.array(z.string()),
  properties: z.array(objcPropertySchema),
  location: nativeMetadataLocationSchema,
  decode: nativeMetadataDecodeSchema,
  evidence: z.array(nativeMetadataEvidenceSchema).min(1),
});

/** Swift protocol conformance and its associated witness-table location. */
export const swiftConformanceSchema = z.strictObject({
  type_name: z.string().min(1),
  protocol_name: z.string().min(1),
  module: z.string().nullable(),
  witness_table: nativeMetadataLocationSchema,
  location: nativeMetadataLocationSchema,
  decode: nativeMetadataDecodeSchema,
  evidence: z.array(nativeMetadataEvidenceSchema).min(1),
});

/** A typed slot in a Swift protocol witness table or class vtable. */
export const swiftDispatchSlotSchema = z.strictObject({
  owner: z.string().min(1),
  table_kind: z.enum(["witness_table", "class_vtable"]),
  slot_index: z.number().int().nonnegative(),
  requirement: z.string().nullable(),
  implementation: z.string().nullable(),
  implementation_address: z.string().nullable(),
  thunk_address: z.string().nullable(),
  location: nativeMetadataLocationSchema,
  decode: nativeMetadataDecodeSchema,
  evidence: z.array(nativeMetadataEvidenceSchema).min(1),
});

/** Signed-relative pointer as stored in an Apple binary metadata structure. */
export const relativePointerSchema = z.strictObject({
  field: nativeMetadataLocationSchema,
  target: nativeMetadataLocationSchema,
  displacement: z.number().int(),
  indirectable: z.boolean(),
  indirect: z.boolean().nullable(),
  decode: nativeMetadataDecodeSchema,
  evidence: z.array(nativeMetadataEvidenceSchema).min(1),
});

/** A raw Swift-mangled symbol when a provider has not decoded its metadata. */
export const swiftSymbolSchema = z.strictObject({
  mangled_name: z.string().min(1),
  address: z.string().min(1),
  decode: nativeMetadataDecodeSchema,
  evidence: z.array(nativeMetadataEvidenceSchema).min(1),
});
type SwiftSymbol = z.infer<typeof swiftSymbolSchema>;

/** Per-facet coverage; empty arrays are meaningful only with this record. */
export const nativeMetadataCoverageSchema = z.strictObject({
  facet: z.string().min(1),
  status: z.enum(["complete", "partial", "unsupported", "not_requested"]),
  reason: z.string().nullable(),
  examined: z.number().int().nonnegative(),
  decoded: z.number().int().nonnegative(),
});

/** Swift declaration kind. */
export const swiftDeclKindSchema = z.enum([
  "class",
  "struct",
  "enum",
  "protocol",
  "extension",
  "actor",
  "global_var",
  "global_func",
]);

/** Swift access level. */
export const swiftAccessLevelSchema = z.enum([
  "private",
  "fileprivate",
  "internal",
  "public",
  "open",
]);
/** Swift declaration metadata. */
export const swiftDeclSchema = z.strictObject({
  kind: swiftDeclKindSchema,
  name: z.string().min(1),
  module: z.string().nullable(),
  access_level: swiftAccessLevelSchema.default("internal"),
  super_class: z.string().nullable(),
  protocols: z.array(z.string()).default([]),
  is_final: z.boolean().default(false),
  is_required: z.boolean().default(false),
  is_convenience_init: z.boolean().default(false),
  is_override: z.boolean().default(false),
});

/** Database save/read operation type. */
export const dbOperationSchema = z.enum([
  "save",
  "readback",
  "open_database",
  "close_database",
  "export",
  "import",
]);
/** Database save operation result. */
export const dbSaveResultSchema = z.strictObject({
  operation: dbOperationSchema,
  succeeded: z.boolean(),
  preserved_names: z.number().int().nonnegative().default(0),
  preserved_comments: z.number().int().nonnegative().default(0),
  preserved_bookmarks: z.number().int().nonnegative().default(0),
  database_path: z.string().nullable(),
  error: z.string().nullable(),
});

/** Result of deeper ObjC/Swift metadata extraction. */
export const objcSwiftMetadataSchema = z.strictObject({
  objc_classes: z.array(objcClassSchema).default([]),
  objc_protocols: z.array(objcProtocolSchema).default([]),
  objc_categories: z.array(objcCategorySchema).default([]),
  swift_decls: z.array(swiftDeclSchema).default([]),
  objc_ivars: z.array(objcIvarSchema).default([]),
  objc_protocol_records: z.array(objcProtocolRecordSchema).default([]),
  objc_dispatch_implementations: z
    .array(objcDispatchImplementationSchema)
    .default([]),
  swift_conformances: z.array(swiftConformanceSchema).default([]),
  swift_dispatch_slots: z.array(swiftDispatchSlotSchema).default([]),
  swift_symbols: z.array(swiftSymbolSchema).default([]),
  relative_pointers: z.array(relativePointerSchema).default([]),
  coverage: z.array(nativeMetadataCoverageSchema).default([]),
  db_save_result: dbSaveResultSchema.nullable(),
});
export type ObjcSwiftMetadata = z.infer<typeof objcSwiftMetadataSchema>;

/** Provider and target identity for one normalized dispatch-metadata result. */
export const nativeDispatchMetadataResultSchema = z.strictObject({
  target_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  provider: z.strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().nullable(),
  }),
  analysis_profile_digest: z.string().min(1).nullable(),
  result: objcSwiftMetadataSchema,
});

/** Decode only facts visible in a provider's existing name inventory. */
export const inspectNativeDispatchMetadata = (
  names: readonly { readonly address: string; readonly name: string }[],
  maxRecords = 5_000,
): ObjcSwiftMetadata => {
  const symbolEvidence = (name: string, address: string) => [
    {
      kind: "symbol" as const,
      description: `Provider symbol ${name}`,
      location: { address, file_offset: null },
      artifact_path: null,
      artifact_sha256: null,
    },
  ];
  const classNames = new Set<string>();
  const implementations = new Map<string, ObjcDispatchImplementation>();
  const swiftSymbols: SwiftSymbol[] = [];

  const examinedNames = names.slice(0, maxRecords);
  for (const entry of examinedNames) {
    const classMatch = /(?:OBJC_CLASS_|OBJC_METACLASS_)\$_([^\s]+)/u.exec(
      entry.name,
    );
    if (classMatch?.[1] !== undefined) classNames.add(classMatch[1]);

    const methodMatch = /^([+-])\[([^\s\]]+)\s+([^\]]+)\]$/u.exec(entry.name);
    if (methodMatch?.[1] !== undefined && methodMatch[2] && methodMatch[3]) {
      const methodType = methodMatch[1] === "+" ? "class" : "instance";
      const selector = methodMatch[3];
      implementations.set(`${methodMatch[2]}:${selector}:${methodType}`, {
        class_name: methodMatch[2],
        selector,
        method_type: methodType,
        implementation_address: entry.address,
        location: { address: entry.address, file_offset: null },
        decode: { status: "partial", reason: "symbol_name_only" },
        evidence: symbolEvidence(entry.name, entry.address),
      });
      classNames.add(methodMatch[2]);
    }

    if (/^(?:_?\$s|_Tt)/u.test(entry.name))
      swiftSymbols.push({
        mangled_name: entry.name,
        address: entry.address,
        decode: { status: "partial", reason: "mangled_symbol_not_demangled" },
        evidence: symbolEvidence(entry.name, entry.address),
      });
  }

  const methodsByClass = new Map<string, ObjcMethod[]>();
  for (const implementation of implementations.values()) {
    const methods = methodsByClass.get(implementation.class_name) ?? [];
    methods.push({
      selector: implementation.selector,
      method_type: implementation.method_type,
      address: parseMetadataAddress(implementation.implementation_address),
      is_required: null,
      is_optional: null,
    });
    methodsByClass.set(implementation.class_name, methods);
  }
  const classes: ObjcClass[] = [...classNames].sort().map((name) => ({
    name,
    super_class: null,
    is_meta_class: null,
    is_root_class: null,
    methods: methodsByClass.get(name) ?? [],
    properties: [],
    protocols: [],
    ivar_count: null,
    instance_size: null,
  }));
  const decodedImplementations = [...implementations.values()].sort(
    (left, right) =>
      `${left.class_name}:${left.selector}`.localeCompare(
        `${right.class_name}:${right.selector}`,
      ),
  );
  const swift = swiftSymbols.length > 0;

  return objcSwiftMetadataSchema.parse({
    objc_classes: classes,
    objc_dispatch_implementations: decodedImplementations,
    swift_symbols: swiftSymbols,
    coverage: [
      {
        facet: "objc_class_symbols",
        status: "partial",
        reason:
          names.length > examinedNames.length
            ? "record_limit_reached_and_symbol_names_are_not_runtime_class_metadata"
            : "symbol_names_do_not_recover_all_runtime_class_metadata",
        examined: examinedNames.length,
        decoded: classes.length,
      },
      {
        facet: "objc_dispatch_implementations",
        status: decodedImplementations.length > 0 ? "partial" : "unsupported",
        reason:
          names.length > examinedNames.length
            ? "record_limit_reached_and_only_symbolized_methods_are_resolved"
            : decodedImplementations.length > 0
              ? "only_symbolized_methods_are_resolved"
              : "provider_name_inventory_has_no_objc_method_symbols",
        examined: examinedNames.length,
        decoded: decodedImplementations.length,
      },
      {
        facet: "objc_ivar_layouts",
        status: "unsupported",
        reason: "symbol_inventory_does_not_expose_runtime_ivar_layouts",
        examined: 0,
        decoded: 0,
      },
      {
        facet: "swift_declarations",
        status: swift ? "partial" : "unsupported",
        reason: swift
          ? "symbols_are_not_demangled_declarations"
          : "no_swift_symbols_observed",
        examined: swiftSymbols.length,
        decoded: 0,
      },
      {
        facet: "swift_dispatch_tables",
        status: "unsupported",
        reason:
          "provider_name_inventory_does_not_decode_witness_or_class_vtables",
        examined: 0,
        decoded: 0,
      },
      {
        facet: "relative_pointers",
        status: "unsupported",
        reason:
          "provider_name_inventory_does_not_decode_binary_relative_pointers",
        examined: 0,
        decoded: 0,
      },
    ],
    db_save_result: null,
  });
};

const parseMetadataAddress = (address: string | null): number | null => {
  if (address === null) return null;
  const match = /(?:^|:)0x([0-9a-f]+)$/iu.exec(address);
  if (match?.[1] === undefined) return null;
  const value = Number.parseInt(match[1], 16);
  return Number.isSafeInteger(value) ? value : null;
};
