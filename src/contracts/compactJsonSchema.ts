import { Budget } from "../domain/budget.js";
import { isRecord } from "../kernel/isRecord.js";
import {
  JsonSchemaReferences,
  type JsonSchemaScope,
} from "./jsonSchemaReferences.js";
import {
  mapSchemaChildren,
  schemaArrays,
  schemaChildren,
  schemaMaps,
  schemaPointerSteps,
} from "./jsonSchemaKeywords.js";

// Shared compact JSON Schema projection primitives; canonical validation stays separate.

/** Annotation keys that carry guidance but no validation semantics. */
const annotationKeys = new Set(["description", "examples", "default", "title"]);

const definitionKeys = new Set(["$defs", "definitions"]);
// An empty schema accepts every JSON value. Kimi otherwise infers string.
const jsonValueTypes = [
  "null",
  "boolean",
  "object",
  "array",
  "number",
  "string",
];
// An empty item schema accepts every JSON value, including arbitrarily nested
// arrays, while satisfying clients that require `items` for array types. The
// portable advertised dialect has no any-value form, so a compact input that
// needs this presentation is reduced instead.
export const jsonValueSchema = () => ({ type: [...jsonValueTypes], items: {} });
const EMPTY_SCHEMA_JSON = JSON.stringify(jsonValueSchema());

const utf8ByteLength = (text: string): number => {
  const len = text.length;
  for (let i = 0; i < len; i++) {
    if (text.charCodeAt(i) >= 0x80) return Buffer.byteLength(text, "utf8");
  }
  return len;
};

const enumValueTypes = (values: readonly unknown[]): readonly string[] => [
  ...new Set(
    values.map((value) => {
      if (value === null) return "null";
      if (Array.isArray(value)) return "array";
      if (typeof value === "object") return "object";
      return typeof value;
    }),
  ),
];

export const isSchemaObject = isRecord;

export const serializedBytes = (value: unknown): number =>
  utf8ByteLength(JSON.stringify(value));

export const schemaDepth = (value: unknown, depth = 0): number => {
  if (Array.isArray(value)) {
    let max = depth;
    for (let i = 0; i < value.length; i++) {
      const childDepth = schemaDepth(value[i], depth + 1);
      if (childDepth > max) max = childDepth;
    }
    return max;
  }
  if (!isSchemaObject(value)) return depth;
  let max = depth;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    const childDepth = schemaDepth(value[key], depth + 1);
    if (childDepth > max) max = childDepth;
  }
  return max;
};

/** Strict clients commonly reject advertised schemas deeper than ten nodes. */
export const COMPACT_SCHEMA_MAX_DEPTH = 10;

/** Rewrite every schema-valued position; literal data stays opaque. */
const rebuildSchemaPositions = (
  node: unknown,
  rebuild: (child: unknown) => unknown,
): unknown => {
  if (Array.isArray(node)) {
    let out: unknown[] | undefined;
    for (let i = 0; i < node.length; i++) {
      const child = node[i];
      const mapped = rebuild(child);
      if (mapped !== child) {
        if (out === undefined) out = node.slice();
        out[i] = mapped;
      }
    }
    return out ?? node;
  }
  if (!isSchemaObject(node)) return node;
  return mapSchemaChildren(node, rebuild);
};

/**
 * Drop annotation prose from every subschema while preserving all validation
 * keywords. The root keeps its own description because the root-union
 * projection encodes accepted input groups there; the root's echoed literal
 * examples leave with the rest of the annotation prose.
 */
export const stripAnnotations = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  const rebuilt = rebuildSchemaPositions(
    schema,
    stripChildAnnotations,
  ) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key in rebuilt) {
    if (!Object.hasOwn(rebuilt, key)) continue;
    if (annotationKeys.has(key) && key !== "description") continue;
    out[key] = rebuilt[key];
  }
  return out;
};

const stripChildAnnotations = (child: unknown): unknown => {
  const rebuilt = rebuildSchemaPositions(child, stripChildAnnotations);
  if (!isSchemaObject(rebuilt)) return rebuilt;
  let kept: Record<string, unknown> | undefined;
  for (const key in rebuilt) {
    if (!Object.hasOwn(rebuilt, key) || !annotationKeys.has(key)) continue;
    if (kept === undefined) {
      kept = {};
      for (const copyKey in rebuilt) {
        if (Object.hasOwn(rebuilt, copyKey) && !annotationKeys.has(copyKey))
          kept[copyKey] = rebuilt[copyKey];
      }
    }
    break;
  }
  return kept ?? rebuilt;
};

type SchemaPosition = "schema" | "map" | "data";
type ObjectEmitMode = "normal" | "root" | "siblings" | "root-siblings";

export interface InlineWithinBudgetOptions {
  readonly stripAnnotations?: boolean;
  readonly references?: JsonSchemaReferences;
}

const childSchemaPosition = (
  key: string,
  position: SchemaPosition,
): SchemaPosition => {
  if (position === "map") return "schema";
  if (position !== "schema") return "data";
  if (schemaMaps.has(key)) return "map";
  return schemaArrays.has(key) || schemaChildren.has(key) ? "schema" : "data";
};

class BudgetedSchemaSerializer {
  readonly chunks: string[] = [];
  resolved = true;
  private readonly active = new Map<JsonSchemaScope, Set<string>>();

  constructor(
    private readonly budget: Budget,
    private readonly references: JsonSchemaReferences,
    private readonly strip: boolean,
  ) {}

  private emitAscii(text: string): boolean {
    if (!this.budget.tryCharge(text.length)) return false;
    this.chunks.push(text);
    return true;
  }

  private emitText(text: string): boolean {
    if (!this.budget.tryCharge(utf8ByteLength(text))) return false;
    this.chunks.push(text);
    return true;
  }

  private isSkippedKey(
    key: string,
    position: SchemaPosition,
    mode: ObjectEmitMode,
  ): boolean {
    if (position !== "schema") return false;
    if ((mode === "siblings" || mode === "root-siblings") && key === "$ref")
      return true;
    if (
      definitionKeys.has(key) ||
      key === "$id" ||
      key === "$anchor" ||
      key === "$schema"
    )
      return true;
    const isRoot = mode === "root" || mode === "root-siblings";
    return (
      this.strip &&
      annotationKeys.has(key) &&
      !(isRoot && key === "description")
    );
  }

  private isEffectivelyEmpty(
    value: Record<string, unknown>,
    isRoot: boolean,
  ): boolean {
    for (const key in value) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) continue;
      if (
        this.strip &&
        annotationKeys.has(key) &&
        !(isRoot && key === "description")
      )
        continue;
      return false;
    }
    return true;
  }

  private hasSiblings(
    value: Record<string, unknown>,
    isRoot: boolean,
  ): boolean {
    for (const key in value) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) continue;
      if (
        key === "$ref" ||
        key === "$id" ||
        key === "$anchor" ||
        key === "$schema"
      )
        continue;
      if (
        this.strip &&
        annotationKeys.has(key) &&
        !(isRoot && key === "description")
      )
        continue;
      return true;
    }
    return false;
  }

  private isStrippedTarget(
    scope: JsonSchemaScope,
    path: readonly string[],
  ): boolean {
    const steps = schemaPointerSteps(path);
    const last = steps[steps.length - 1];
    return (
      last?.kind === "value" &&
      annotationKeys.has(last.keyword) &&
      !(
        last.keyword === "description" &&
        steps.length === 1 &&
        scope === this.references.rootScope
      )
    );
  }

  visit(
    value: unknown,
    position: SchemaPosition,
    scope: JsonSchemaScope | undefined,
    isRoot: boolean,
  ): boolean {
    if (Array.isArray(value)) {
      if (!this.emitAscii("[")) return false;
      for (let i = 0; i < value.length; i++) {
        if (i > 0 && !this.emitAscii(",")) return false;
        if (!this.visit(value[i], position, scope, false)) return false;
      }
      return this.emitAscii("]");
    }
    if (isSchemaObject(value)) {
      return position === "schema"
        ? this.visitSchemaObject(value, scope, isRoot)
        : this.visitObject(value, position, scope, "normal");
    }
    const serialized = JSON.stringify(value);
    return this.emitText(serialized === undefined ? "null" : serialized);
  }

  private visitSchemaObject(
    value: Record<string, unknown>,
    scope: JsonSchemaScope | undefined,
    isRoot: boolean,
  ): boolean {
    const currentScope = this.references.enter(value, scope);
    if (
      currentScope === undefined ||
      currentScope.dialect !== this.references.rootScope.dialect ||
      Object.hasOwn(value, "$dynamicRef") ||
      Object.hasOwn(value, "$recursiveRef") ||
      Object.hasOwn(value, "$dynamicAnchor") ||
      Object.hasOwn(value, "$recursiveAnchor")
    ) {
      this.resolved = false;
      return false;
    }
    if (this.isEffectivelyEmpty(value, isRoot))
      return this.emitAscii(EMPTY_SCHEMA_JSON);
    if (Object.hasOwn(value, "$ref") && typeof value.$ref === "string")
      return this.visitReference(value, value.$ref, currentScope, isRoot);
    return this.visitObject(
      value,
      "schema",
      currentScope,
      isRoot ? "root" : "normal",
    );
  }

  private visitReference(
    value: Record<string, unknown>,
    ref: string,
    currentScope: JsonSchemaScope,
    isRoot: boolean,
  ): boolean {
    let scopeRefs = this.active.get(currentScope);
    if (scopeRefs?.has(ref)) {
      this.resolved = false;
      return false;
    }
    const target = this.references.resolve(currentScope, ref);
    if (
      target.kind !== "target" ||
      (this.strip && this.isStrippedTarget(currentScope, target.path))
    ) {
      this.resolved = false;
      return false;
    }
    const siblings = this.hasSiblings(value, isRoot);
    // Draft 7 ignores siblings, while clients such as Ajv also apply them.
    // Do not label either interpretation an equivalent inline advertisement.
    if (currentScope.dialect === "draft-07" && siblings) {
      this.resolved = false;
      return false;
    }
    if (scopeRefs === undefined) {
      scopeRefs = new Set();
      this.active.set(currentScope, scopeRefs);
    }
    scopeRefs.add(ref);
    const ok = !siblings
      ? this.visit(target.value, "schema", currentScope, false)
      : this.emitAscii('{"allOf":[') &&
        this.visit(target.value, "schema", currentScope, false) &&
        this.emitAscii(",") &&
        this.visitObject(
          value,
          "schema",
          currentScope,
          isRoot ? "root-siblings" : "siblings",
        ) &&
        this.emitAscii("]}");
    scopeRefs.delete(ref);
    return ok;
  }

  private visitObject(
    value: Record<string, unknown>,
    position: SchemaPosition,
    scope: JsonSchemaScope | undefined,
    mode: ObjectEmitMode,
  ): boolean {
    if (!this.emitAscii("{")) return false;
    let first = true;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const child = value[key];
      if (child === undefined) continue;
      if (this.isSkippedKey(key, position, mode)) continue;
      if (!first && !this.emitAscii(",")) return false;
      first = false;
      if (!this.emitText(JSON.stringify(key)) || !this.emitAscii(":"))
        return false;
      // `not: {}` forbids a value; no client infers a type for a value it
      // must omit, and the any-value list would place `items` beside a
      // non-array type, which Gemini function declarations reject.
      if (
        position === "schema" &&
        key === "not" &&
        isSchemaObject(child) &&
        this.isEffectivelyEmpty(child, false)
      ) {
        if (!this.emitAscii("{}")) return false;
        continue;
      }
      const childPosition = childSchemaPosition(key, position);
      if (!this.visit(child, childPosition, scope, false)) return false;
    }
    return this.emitAscii("}");
  }
}

/** Stop serialization at the budget before allocating an expanded schema. */
export const inlineWithinBudget = (
  root: Record<string, unknown>,
  budgetBytes: number,
  options?: InlineWithinBudgetOptions,
): Record<string, unknown> | undefined => {
  const limit = Number.isSafeInteger(budgetBytes)
    ? budgetBytes
    : budgetBytes > 0
      ? Number.MAX_SAFE_INTEGER
      : -1;
  if (limit < 0) return undefined;
  const references = options?.references ?? new JsonSchemaReferences(root);
  const identity: Record<string, unknown> = {};
  let hasIdentity = false;
  for (const key of ["$id", "$anchor", "$schema"] as const) {
    if (Object.hasOwn(root, key) && root[key] !== undefined) {
      identity[key] = root[key];
      hasIdentity = true;
    }
  }
  const identityBytes = hasIdentity ? serializedBytes(identity) - 2 : 0;
  const budget = new Budget(limit);
  if (!budget.tryCharge(identityBytes)) return undefined;
  const serializer = new BudgetedSchemaSerializer(
    budget,
    references,
    options?.stripAnnotations === true,
  );
  if (
    !serializer.visit(root, "schema", references.rootScope, true) ||
    !serializer.resolved
  )
    return undefined;
  const expanded: unknown = JSON.parse(serializer.chunks.join(""));
  if (!isSchemaObject(expanded)) return undefined;
  // Every emitted dependency is now static and reference-free. Nested resource
  // identifiers/anchors can leave without duplicating identities at call sites.
  if (!hasIdentity) return expanded;
  const schema = { ...identity, ...expanded };
  return serializedBytes(schema) <= budgetBytes ? schema : undefined;
};

/** Preserve every possible type, including referenced and nullable unions. */
const detectedTypes = (
  schema: unknown,
  references: JsonSchemaReferences,
  inherited: JsonSchemaScope | undefined,
  active: ReadonlySet<object> = new Set(),
): readonly string[] | undefined => {
  if (!isSchemaObject(schema)) return undefined;
  const scope = references.enter(schema, inherited);
  if (scope === undefined) return undefined;
  if (typeof schema.$ref === "string") {
    if (active.has(schema)) return undefined;
    const target = references.resolve(scope, schema.$ref);
    return target.kind === "target"
      ? detectedTypes(
          target.value,
          references,
          scope,
          new Set([...active, schema]),
        )
      : undefined;
  }
  if (typeof schema.type === "string") return [schema.type];
  if (
    Array.isArray(schema.type) &&
    schema.type.every((type) => typeof type === "string")
  )
    return schema.type;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const enumTypes = enumValueTypes(schema.enum);
    if (enumTypes.every((type) => jsonValueTypes.includes(type)))
      return enumTypes;
  }
  const alternatives = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : [];
  if (alternatives.length === 0) return undefined;
  const types = alternatives.map((branch) =>
    detectedTypes(branch, references, scope, active),
  );
  if (types.some((type) => type === undefined)) return undefined;
  return [...new Set(types.flatMap((type) => type ?? []))];
};

interface ScopedSchema {
  readonly schema: Record<string, unknown>;
  readonly scope: JsonSchemaScope;
}

/**
 * Collect the item schema of every array alternative. Tuples, boolean item
 * schemas and unresolved references are unknown because one item type would
 * not describe every accepted element.
 */
const arrayItemAlternatives = (
  schema: unknown,
  references: JsonSchemaReferences,
  inherited: JsonSchemaScope | undefined,
  active: ReadonlySet<object> = new Set(),
): readonly ScopedSchema[] | undefined => {
  if (!isSchemaObject(schema)) return undefined;
  const scope = references.enter(schema, inherited);
  if (scope === undefined) return undefined;
  if (typeof schema.$ref === "string") {
    if (active.has(schema)) return undefined;
    const target = references.resolve(scope, schema.$ref);
    return target.kind === "target"
      ? arrayItemAlternatives(
          target.value,
          references,
          scope,
          new Set([...active, schema]),
        )
      : undefined;
  }
  const types =
    typeof schema.type === "string"
      ? [schema.type]
      : Array.isArray(schema.type)
        ? schema.type
        : undefined;
  if (types !== undefined) {
    if (!types.includes("array")) return [];
    return isSchemaObject(schema.items) && schema.prefixItems === undefined
      ? [{ schema: schema.items, scope }]
      : undefined;
  }
  const alternatives = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : [];
  if (alternatives.length === 0) return undefined;
  const nested = alternatives.map((branch) =>
    arrayItemAlternatives(branch, references, scope, active),
  );
  return nested.some((items) => items === undefined)
    ? undefined
    : nested.flatMap((items) => items ?? []);
};

/** Nested arrays beyond this level advertise an unconstrained item schema. */
const REDUCED_ITEM_MAX_DEPTH = 3;

/**
 * Advertise the element types the canonical item schemas accept. Gemini
 * function declarations permit `items` only beside the single `array` type,
 * so an element that may be an array alongside other types, or whose type is
 * unknown, uses the empty schema: it accepts every element and still gives
 * clients that require `items` an item schema.
 */
/**
 * One `type`, or `anyOf` typed branches for several. Gemini, Moonshot and Ark
 * reject type lists (#7103, #3800); `[T, "null"]` becomes the dialect's
 * nullable union, and other unions keep the typed branches every surveyed
 * target accepts below the root.
 */
const typedAlternatives = (
  types: readonly string[],
): Record<string, unknown> =>
  types.length === 1
    ? { type: types[0] }
    : { anyOf: types.map((type) => ({ type })) };

const reducedItemSchema = (
  alternatives: readonly ScopedSchema[] | undefined,
  references: JsonSchemaReferences,
  depth = 1,
): Record<string, unknown> => {
  if (
    alternatives === undefined ||
    alternatives.length === 0 ||
    depth > REDUCED_ITEM_MAX_DEPTH
  )
    return {};
  const types: string[] = [];
  for (const { schema, scope } of alternatives) {
    const detected = detectedTypes(schema, references, scope);
    if (detected === undefined || detected.length === 0) return {};
    types.push(...detected);
  }
  const unique = [...new Set(types)];
  if (!unique.includes("array")) return typedAlternatives(unique);
  if (unique.length > 1) return {};
  const nested: ScopedSchema[] = [];
  for (const { schema, scope } of alternatives) {
    const items = arrayItemAlternatives(schema, references, scope);
    if (items === undefined) return { type: "array", items: {} };
    nested.push(...items);
  }
  return {
    type: "array",
    items: reducedItemSchema(nested, references, depth + 1),
  };
};

/**
 * Present a reduced property's reference-resolved types. Reduced inputs omit
 * nested validation, but clients still require an item schema for an array
 * declaration, and Gemini accepts `items` only beside the single `array` type,
 * so a property that may be an array or another type lists typed branches.
 */
const reducedPropertyTypes = (
  value: unknown,
  references: JsonSchemaReferences,
): Record<string, unknown> => {
  const types = detectedTypes(value, references, references.rootScope);
  if (types === undefined || types.length === 0) return {};
  if (!types.includes("array")) return typedAlternatives(types);
  const array = {
    type: "array",
    items: reducedItemSchema(
      arrayItemAlternatives(value, references, references.rootScope),
      references,
    ),
  };
  return types.length === 1
    ? array
    : {
        anyOf: types.map((type) => (type === "array" ? array : { type })),
      };
};

/**
 * Present only the root property shape with per-property guidance. Used for
 * schemas whose validation structure alone exceeds the compact budget; the
 * canonical schema still rejects malformed calls server-side.
 */
export const reduceToShallowProperties = (
  schema: Record<string, unknown>,
  reducedAnnotation: string,
  references: JsonSchemaReferences = new JsonSchemaReferences(schema),
): Record<string, unknown> => {
  const properties = isSchemaObject(schema.properties) ? schema.properties : {};
  const description = [
    typeof schema.description === "string" ? schema.description : undefined,
    reducedAnnotation,
  ]
    .filter((text) => text !== undefined)
    .join(" ");
  const shallow = Object.fromEntries(
    Object.entries(properties).map(([name, value]) => {
      const description =
        isSchemaObject(value) && typeof value.description === "string"
          ? { description: value.description }
          : {};
      return [
        name,
        { ...reducedPropertyTypes(value, references), ...description },
      ];
    }),
  );
  return {
    ...(typeof schema.$schema === "string" ? { $schema: schema.$schema } : {}),
    type: "object",
    description,
    properties: shallow,
    ...(Array.isArray(schema.required)
      ? { required: [...schema.required] }
      : {}),
    ...(typeof schema.minProperties === "number"
      ? { minProperties: schema.minProperties }
      : {}),
    // The reduced form drops `patternProperties`; closing it would then reject
    // names those patterns admitted.
    ...(schema.additionalProperties === false &&
    !(
      isSchemaObject(schema.patternProperties) &&
      Object.keys(schema.patternProperties).length > 0
    )
      ? { additionalProperties: false }
      : {}),
    // Root property dependencies still apply to the shallow properties; a
    // dialect projection states them as tool guidance.
    ...Object.fromEntries(
      ["dependentRequired", "dependencies"].flatMap((key) =>
        isSchemaObject(schema[key]) ? [[key, schema[key]]] : [],
      ),
    ),
  };
};
