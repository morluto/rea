import { z } from "zod";

/** Component-model sorts, types, declarations and canonical definitions. */
const offset = z.number().int().nonnegative();
/** Position in one index space. */
export const indexSchema = z.number().int().nonnegative();
/** Index into a sort's index space; null when an undecoded definition precedes it. */
export const definedIndexSchema = indexSchema.nullable();
/** Absolute file offsets; `end` is exclusive. */
export const byteRangeSchema = z.strictObject({ start: offset, end: offset });

export const componentSortSchema = z.enum([
  "core func",
  "core table",
  "core memory",
  "core global",
  "core tag",
  "core type",
  "core module",
  "core instance",
  "func",
  "value",
  "type",
  "component",
  "instance",
]);
export type ComponentSort = z.infer<typeof componentSortSchema>;

const primitiveSchema = z.enum([
  "bool",
  "s8",
  "u8",
  "s16",
  "u16",
  "s32",
  "u32",
  "s64",
  "u64",
  "f32",
  "f64",
  "char",
  "string",
  "error-context",
]);
/** A primitive name, or a reference into the enclosing type index space. */
export const valTypeSchema = z.union([
  primitiveSchema,
  z.strictObject({ type: indexSchema }),
]);
export type ComponentValType = z.infer<typeof valTypeSchema>;

/** Core value and reference types use WebAssembly text-format spellings. */
const coreValTypeSchema = z.string().min(1);
const limitsSchema = z.strictObject({
  min: z.number().int().nonnegative(),
  max: z.number().int().nonnegative().nullable(),
  shared: z.boolean(),
  index64: z.boolean(),
  page_size_log2: z.number().int().nonnegative().nullable(),
});
export const coreExternTypeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("func"), type: indexSchema }),
  z.strictObject({
    kind: z.literal("table"),
    element: coreValTypeSchema,
    limits: limitsSchema,
  }),
  z.strictObject({ kind: z.literal("memory"), limits: limitsSchema }),
  z.strictObject({
    kind: z.literal("global"),
    type: coreValTypeSchema,
    mutable: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("tag"), type: indexSchema }),
]);
export type CoreExternType = z.infer<typeof coreExternTypeSchema>;

export const coreTypeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("func"),
    params: z.array(coreValTypeSchema),
    results: z.array(coreValTypeSchema),
  }),
  /** Declarations live in `type_scopes[scope]`. */
  z.strictObject({ kind: z.literal("module"), scope: indexSchema }),
]);
export type CoreType = z.infer<typeof coreTypeSchema>;

const labeledSchema = z.strictObject({ name: z.string(), type: valTypeSchema });
export const componentTypeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("primitive"), primitive: primitiveSchema }),
  z.strictObject({ kind: z.literal("record"), fields: z.array(labeledSchema) }),
  z.strictObject({
    kind: z.literal("variant"),
    cases: z.array(
      z.strictObject({ name: z.string(), type: valTypeSchema.nullable() }),
    ),
  }),
  z.strictObject({
    kind: z.literal("list"),
    element: valTypeSchema,
    length: indexSchema.nullable(),
  }),
  z.strictObject({ kind: z.literal("tuple"), types: z.array(valTypeSchema) }),
  z.strictObject({ kind: z.literal("flags"), names: z.array(z.string()) }),
  z.strictObject({ kind: z.literal("enum"), names: z.array(z.string()) }),
  z.strictObject({ kind: z.literal("option"), type: valTypeSchema }),
  z.strictObject({
    kind: z.literal("result"),
    ok: valTypeSchema.nullable(),
    error: valTypeSchema.nullable(),
  }),
  z.strictObject({ kind: z.literal("own"), resource: indexSchema }),
  z.strictObject({ kind: z.literal("borrow"), resource: indexSchema }),
  z.strictObject({
    kind: z.literal("stream"),
    element: valTypeSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("future"),
    element: valTypeSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("map"),
    key: valTypeSchema,
    value: valTypeSchema,
  }),
  z.strictObject({
    kind: z.literal("func"),
    async: z.boolean(),
    params: z.array(labeledSchema),
    result: valTypeSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("resource"),
    representation: coreValTypeSchema,
    destructor: indexSchema.nullable(),
  }),
  /** Declarations live in `type_scopes[scope]`. */
  z.strictObject({ kind: z.literal("component"), scope: indexSchema }),
  z.strictObject({ kind: z.literal("instance"), scope: indexSchema }),
]);
export type ComponentType = z.infer<typeof componentTypeSchema>;

export const externTypeSchema = z.discriminatedUnion("sort", [
  z.strictObject({ sort: z.literal("core module"), type: indexSchema }),
  z.strictObject({ sort: z.literal("func"), type: indexSchema }),
  z.strictObject({
    sort: z.literal("value"),
    bound: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("eq"), value: indexSchema }),
      z.strictObject({ kind: z.literal("type"), type: valTypeSchema }),
    ]),
  }),
  z.strictObject({
    sort: z.literal("type"),
    bound: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("eq"), type: indexSchema }),
      z.strictObject({ kind: z.literal("sub-resource") }),
    ]),
  }),
  z.strictObject({ sort: z.literal("component"), type: indexSchema }),
  z.strictObject({ sort: z.literal("instance"), type: indexSchema }),
]);
export type ExternType = z.infer<typeof externTypeSchema>;

export const nameAttributeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("implements"), interface: z.string() }),
  z.strictObject({ kind: z.literal("version-suffix"), suffix: z.string() }),
  z.strictObject({ kind: z.literal("external-id"), id: z.string() }),
]);
export type NameAttribute = z.infer<typeof nameAttributeSchema>;

export const sortIndexSchema = z.strictObject({
  sort: componentSortSchema,
  index: indexSchema,
});
export const aliasTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("export"),
    instance: indexSchema,
    name: z.string(),
  }),
  z.strictObject({
    kind: z.literal("core-export"),
    instance: indexSchema,
    name: z.string(),
  }),
  z.strictObject({
    kind: z.literal("outer"),
    count: indexSchema,
    index: indexSchema,
  }),
]);

/** One declarator of a component, instance or core module type. */
export const typeDeclarationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("import"),
    range: byteRangeSchema,
    name: z.string(),
    attributes: z.array(nameAttributeSchema),
    type: externTypeSchema,
  }),
  z.strictObject({
    kind: z.literal("export"),
    range: byteRangeSchema,
    name: z.string(),
    attributes: z.array(nameAttributeSchema),
    type: externTypeSchema,
  }),
  z.strictObject({
    kind: z.literal("type"),
    range: byteRangeSchema,
    type: componentTypeSchema,
  }),
  z.strictObject({
    kind: z.literal("core-type"),
    range: byteRangeSchema,
    type: coreTypeSchema,
  }),
  z.strictObject({
    kind: z.literal("alias"),
    range: byteRangeSchema,
    sort: componentSortSchema,
    target: aliasTargetSchema,
  }),
  z.strictObject({
    kind: z.literal("core-import"),
    range: byteRangeSchema,
    module: z.string(),
    name: z.string(),
    type: coreExternTypeSchema,
  }),
  z.strictObject({
    kind: z.literal("core-export"),
    range: byteRangeSchema,
    name: z.string(),
    type: coreExternTypeSchema,
  }),
]);
export type TypeDeclaration = z.infer<typeof typeDeclarationSchema>;

export const typeScopeSchema = z.strictObject({
  scope: indexSchema,
  kind: z.enum(["component", "instance", "core module"]),
  range: byteRangeSchema,
  declarations: z.array(typeDeclarationSchema),
});
export type TypeScope = z.infer<typeof typeScopeSchema>;

const canonOptionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("string-encoding"),
    encoding: z.enum(["utf8", "utf16", "latin1+utf16"]),
  }),
  z.strictObject({ kind: z.literal("memory"), core_memory: indexSchema }),
  z.strictObject({ kind: z.literal("realloc"), core_func: indexSchema }),
  z.strictObject({ kind: z.literal("post-return"), core_func: indexSchema }),
  z.strictObject({ kind: z.literal("async") }),
  z.strictObject({ kind: z.literal("callback"), core_func: indexSchema }),
]);

export const canonKindSchema = z.enum([
  "lift",
  "lower",
  "resource.new",
  "resource.drop",
  "resource.rep",
  "backpressure.inc",
  "backpressure.dec",
  "task.return",
  "task.cancel",
  "context.get",
  "context.set",
  "subtask.cancel",
  "subtask.drop",
  "stream.new",
  "stream.read",
  "stream.write",
  "stream.cancel-read",
  "stream.cancel-write",
  "stream.drop-readable",
  "stream.drop-writable",
  "stream.forward",
  "future.new",
  "future.read",
  "future.write",
  "future.cancel-read",
  "future.cancel-write",
  "future.drop-readable",
  "future.drop-writable",
  "future.forward",
  "error-context.new",
  "error-context.debug-message",
  "error-context.drop",
  "waitable-set.new",
  "waitable-set.wait",
  "waitable-set.poll",
  "waitable-set.drop",
  "waitable.join",
  "thread.index",
  "thread.new-indirect",
  "thread.resume-later",
  "thread.suspend",
  "thread.yield",
  "thread.suspend-then-resume",
  "thread.yield-then-resume",
  "thread.suspend-then-promote",
  "thread.yield-then-promote",
  "thread.spawn-ref",
  "thread.spawn-indirect",
  "thread.available-parallelism",
]);
export type CanonKind = z.infer<typeof canonKindSchema>;

/** Operands are present only where the canonical definition encodes them. */
export const canonSchema = z.strictObject({
  range: byteRangeSchema,
  kind: canonKindSchema,
  func: indexSchema.optional(),
  core_func: indexSchema.optional(),
  type: indexSchema.optional(),
  core_type: indexSchema.optional(),
  core_table: indexSchema.optional(),
  core_memory: indexSchema.optional(),
  value_type: coreValTypeSchema.optional(),
  slot: indexSchema.optional(),
  result: valTypeSchema.nullable().optional(),
  async: z.boolean().optional(),
  shared: z.boolean().optional(),
  options: z.array(canonOptionSchema).optional(),
  defines: sortIndexSchema.extend({ index: definedIndexSchema }),
});
export type ComponentCanon = z.infer<typeof canonSchema>;
