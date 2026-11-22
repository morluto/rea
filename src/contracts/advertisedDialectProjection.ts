import { isDeepStrictEqual } from "node:util";

import { isRecord } from "../kernel/isRecord.js";
import { setOwnSchemaProperty } from "./jsonSchemaKeywords.js";
import {
  ADVERTISED_BOUND_LIMIT,
  ADVERTISED_DESCRIPTION_MAX_CHARACTERS,
} from "./advertisedDialect.js";
import { projectPortablePattern } from "./portablePattern.js";

// The one projection from a self-contained (reference-free) input schema into
// the portable advertised dialect declared in `advertisedDialect.ts`. Every
// rewrite is exact or widening: a canonical-valid input always satisfies the
// projection, and the server still validates the canonical contract. A
// constraint the dialect cannot express leaves the schema; when an agent needs
// it to build a valid call, a sentence joins the tool description instead.
// Codex strips every description inside a schema above 5,000 bytes and Zed
// drops the root description, so that guidance never lives in the schema.

type Schema = Record<string, unknown>;

/** A schema in the portable dialect, plus guidance for the tool description. */
export interface AdvertisedDialectProjection {
  readonly schema: Schema;
  /** The root description, then sentences for constraints the schema omits. */
  readonly guidance: readonly string[];
}

const isStringList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const literalType = (value: unknown): string | undefined => {
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number";
  return undefined;
};

/** One type covering every literal, or undefined when none does. */
const literalsType = (values: readonly unknown[]): string | undefined => {
  const types = new Set(values.map(literalType));
  if (types.has(undefined)) return undefined;
  if (types.size === 1) return [...types][0];
  return types.size === 2 && types.has("integer") && types.has("number")
    ? "number"
    : undefined;
};

/** Sentences for `dependentRequired` and string-list `dependencies`. */
export const dependencyGuidance = (
  schema: Readonly<Record<string, unknown>>,
): readonly string[] => {
  const dependencies = isRecord(schema.dependentRequired)
    ? schema.dependentRequired
    : isRecord(schema.dependencies)
      ? schema.dependencies
      : {};
  return Object.entries(dependencies).flatMap(([property, partners]) =>
    isStringList(partners) && partners.length > 0
      ? [
          `When ${property} is provided, also provide ${partners.join(" and ")}.`,
        ]
      : [],
  );
};

const truncatedDescription = (text: string): string => {
  if (text.length <= ADVERTISED_DESCRIPTION_MAX_CHARACTERS) return text;
  let kept = text.slice(0, ADVERTISED_DESCRIPTION_MAX_CHARACTERS - 1);
  const last = kept.charCodeAt(kept.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) kept = kept.slice(0, -1);
  return `${kept}…`;
};

/**
 * Hoist `allOf` members into their parent. A keyword the parent already sets
 * differently is dropped, which only widens the advertisement; required names
 * are a conjunction, so their union is exact.
 */
const mergeAllOf = (schema: Schema): Schema => {
  if (!Array.isArray(schema.allOf)) return schema;
  const { allOf, ...merged } = schema;
  const tails = new Map<string, Schema>();
  for (const key of TUPLE_TAIL_KEYS)
    if (isTupleTail(merged, key)) tails.set(key, merged);
  for (const member of allOf) {
    if (!isRecord(member)) continue;
    const flattened = mergeAllOf(member);
    for (const [key, value] of Object.entries(flattened)) {
      if (!Object.hasOwn(merged, key)) {
        merged[key] = value;
        if (isTupleTail(flattened, key)) tails.set(key, flattened);
      } else if (key === "required" && isStringList(merged.required)) {
        if (isStringList(value))
          merged.required = [...new Set([...merged.required, ...value])];
      }
    }
  }
  // A closed object's properties and patterns are scoped to its own schema
  // object. Hoisting its closure beside another member's properties can
  // reject names accepted by the original conjunction.
  delete merged.additionalProperties;
  // A tuple tail applies past its own object's positions. Beside a different
  // number of positions it would constrain elements the original did not.
  for (const [key, owner] of tails)
    if (tuplePositions(owner)?.length !== tuplePositions(merged)?.length)
      delete merged[key];
  return merged;
};

/** Keywords that constrain only the elements past a tuple's positions. */
const TUPLE_TAIL_KEYS = ["items", "additionalItems"] as const;

/** Positional element schemas (2020-12 `prefixItems` or draft-07 `items`). */
const tuplePositions = (schema: Schema): readonly unknown[] | undefined =>
  Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : Array.isArray(schema.items)
      ? schema.items
      : undefined;

/** Whether `key` constrains only the elements past `schema`'s positions. */
const isTupleTail = (schema: Schema, key: string): boolean =>
  (key === "additionalItems" && Array.isArray(schema.items)) ||
  (key === "items" &&
    Array.isArray(schema.prefixItems) &&
    !Array.isArray(schema.items));

const branchType = (branch: unknown): string | undefined =>
  isRecord(branch) && typeof branch.type === "string" ? branch.type : undefined;

const onlyKeys = (schema: Schema, keys: readonly string[]): boolean =>
  Object.keys(schema).every((key) => keys.includes(key));

const distinct = (schemas: readonly unknown[]): unknown[] => {
  const kept: unknown[] = [];
  for (const schema of schemas)
    if (!kept.some((known) => isDeepStrictEqual(known, schema)))
      kept.push(schema);
  return kept;
};

const label = (path: string): string =>
  path === "" ? "The input" : `\`${path}\``;

/** Exclusive numeric bounds become inclusive: exact for integers. */
const inclusiveBounds = (source: Schema, out: Schema): void => {
  const { type } = source;
  const integral =
    type === "integer" ||
    (isStringList(type) &&
      type.includes("integer") &&
      !type.includes("number"));
  let { minimum, maximum } = source;
  if (typeof source.exclusiveMinimum === "number") {
    const lower = integral
      ? Math.floor(source.exclusiveMinimum) + 1
      : source.exclusiveMinimum;
    minimum = typeof minimum === "number" ? Math.max(minimum, lower) : lower;
  }
  if (typeof source.exclusiveMaximum === "number") {
    const upper = integral
      ? Math.ceil(source.exclusiveMaximum) - 1
      : source.exclusiveMaximum;
    maximum = typeof maximum === "number" ? Math.min(maximum, upper) : upper;
  }
  if (typeof minimum === "number" && minimum !== Number.MIN_SAFE_INTEGER)
    out.minimum = minimum;
  if (typeof maximum === "number" && maximum !== Number.MAX_SAFE_INTEGER)
    out.maximum = maximum;
};

/** Length and item bounds clients can compile, and the portable pattern. */
const scalarBounds = (source: Schema, out: Schema): void => {
  for (const bound of ["minLength", "maxLength", "minItems", "maxItems"])
    if (
      Number.isSafeInteger(source[bound]) &&
      (source[bound] as number) < ADVERTISED_BOUND_LIMIT
    )
      out[bound] = source[bound];
  if (typeof source.pattern === "string") {
    const projected = projectPortablePattern(source.pattern);
    if (projected.kind !== "unexpressible") out.pattern = projected.pattern;
  }
  inclusiveBounds(source, out);
};

/** Only non-empty string enums are portable; other literals keep a type. */
const literalKeywords = (source: Schema, out: Schema): void => {
  const literals = Object.hasOwn(source, "const")
    ? [source.const]
    : Array.isArray(source.enum) && source.enum.length > 0
      ? source.enum
      : undefined;
  if (literals === undefined) return;
  const literal = literalsType(literals);
  if (
    literal === "string" &&
    !literals.includes("") &&
    (out.type === undefined || out.type === "string")
  ) {
    out.type = "string";
    out.enum = [...new Set(literals)];
  } else if (literal !== undefined && out.type === undefined)
    out.type = literal;
};

const isStringEnum = (branch: unknown): branch is Schema =>
  isRecord(branch) &&
  branch.type === "string" &&
  Array.isArray(branch.enum) &&
  onlyKeys(branch, ["type", "enum", "description"]);

const isNonEmptyStringEnum = (branch: unknown): branch is Schema =>
  isStringEnum(branch) && isStringList(branch.enum) && branch.enum.length > 0;

const sameNonPropertyKeywords = (left: Schema, right: Schema): boolean => {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  for (const key of leftKeys) {
    if (key === "properties") continue;
    if (!Object.hasOwn(right, key) || !isDeepStrictEqual(left[key], right[key]))
      return false;
  }
  return true;
};

const singleDifferingStringEnumKey = (
  left: Schema,
  right: Schema,
): string | undefined => {
  if (
    left.type !== "object" ||
    right.type !== "object" ||
    !isRecord(left.properties) ||
    !isRecord(right.properties) ||
    !sameNonPropertyKeywords(left, right)
  )
    return undefined;
  const leftProps = left.properties;
  const rightProps = right.properties;
  if (Object.keys(leftProps).length !== Object.keys(rightProps).length)
    return undefined;
  let diffKey: string | undefined;
  for (const key in leftProps) {
    if (!Object.hasOwn(leftProps, key)) continue;
    if (!Object.hasOwn(rightProps, key)) return undefined;
    if (isDeepStrictEqual(leftProps[key], rightProps[key])) continue;
    if (diffKey !== undefined) return undefined;
    diffKey = key;
  }
  if (diffKey === undefined) return undefined;
  const leftProp = leftProps[diffKey];
  const rightProp = rightProps[diffKey];
  if (!isNonEmptyStringEnum(leftProp) || !isNonEmptyStringEnum(rightProp))
    return undefined;
  return leftProp.description === rightProp.description ? diffKey : undefined;
};

const mergeBranchOnEnumProperty = (
  groupBranch: Schema,
  incomingBranch: Schema,
  diffKey: string,
): Schema => {
  const leftProps = groupBranch.properties as Schema;
  const rightProps = incomingBranch.properties as Schema;
  const leftEnum = leftProps[diffKey] as Schema;
  const rightEnum = rightProps[diffKey] as Schema;
  const nextProps = { ...leftProps };
  setOwnSchemaProperty(nextProps, diffKey, {
    ...leftEnum,
    enum: [
      ...new Set([
        ...(leftEnum.enum as readonly string[]),
        ...(rightEnum.enum as readonly string[]),
      ]),
    ],
  });
  return { ...groupBranch, properties: nextProps };
};

/**
 * Exact product-union factoring: object branches that agree on every keyword
 * and property except one string-enum discriminator collapse into one branch.
 */
const factorObjectEnumUnions = (branches: readonly unknown[]): unknown[] => {
  const groups: { branch: unknown; diffKey?: string }[] = [];
  for (const branch of branches) {
    if (
      !isRecord(branch) ||
      branch.type !== "object" ||
      !isRecord(branch.properties)
    ) {
      groups.push({ branch });
      continue;
    }
    let matched = false;
    for (const group of groups) {
      if (!isRecord(group.branch)) continue;
      const diffKey = singleDifferingStringEnumKey(group.branch, branch);
      if (
        diffKey !== undefined &&
        (group.diffKey === undefined || group.diffKey === diffKey)
      ) {
        group.branch = mergeBranchOnEnumProperty(group.branch, branch, diffKey);
        group.diffKey = diffKey;
        matched = true;
        break;
      }
    }
    if (!matched) groups.push({ branch });
  }
  return groups.map((group) => group.branch);
};

/** `[T, "null"]` becomes the single nullable form: a typed branch or null. */
const nullableForm = (out: Schema): Schema => {
  if (
    !isStringList(out.type) ||
    out.type.length !== 2 ||
    !out.type.includes("null")
  )
    return out;
  const { type, description, ...constraints } = out;
  const nonNull = (type as readonly string[]).find(
    (member) => member !== "null",
  )!;
  return {
    ...(description === undefined ? {} : { description }),
    anyOf: [{ type: nonNull, ...constraints }, { type: "null" }],
  };
};

/** One projection: guidance sentences accumulate while the schema is built. */
class DialectProjection {
  readonly notes: string[] = [];
  readonly #seenNotes = new Set<string>();

  note(sentence: string): void {
    if (this.#seenNotes.has(sentence)) return;
    this.#seenNotes.add(sentence);
    this.notes.push(sentence);
  }

  project(value: unknown, path: string): unknown {
    if (!isRecord(value)) return value;
    const source = mergeAllOf(value);
    const out: Schema = {};
    if (typeof source.type === "string" || isStringList(source.type))
      out.type = source.type;
    if (typeof source.description === "string")
      out.description = truncatedDescription(source.description);
    this.objectKeywords(source, out, path);
    this.arrayKeywords(source, out, path);
    scalarBounds(source, out);
    literalKeywords(source, out);
    if (isRecord(source.not) && isStringList(source.not.enum))
      this.note(
        `${label(path)} must not be ${source.not.enum.map((item) => JSON.stringify(item)).join(" or ")}.`,
      );
    this.unionKeywords(source, out, path);
    return nullableForm(out);
  }

  /** Name and count constraints are dropped; an object's own cross-field
   * rules precede those of its properties. */
  private objectKeywords(source: Schema, out: Schema, path: string): void {
    for (const sentence of dependencyGuidance(source))
      this.note(path === "" ? sentence : `In ${label(path)}: ${sentence}`);
    if (isRecord(source.properties)) {
      // `fromEntries` defines each name as an own property, so a property
      // named `__proto__` stays a property rather than setting the prototype.
      const properties: Schema = Object.fromEntries(
        Object.entries(source.properties)
          // A never-valid property is omitted; closed objects still refuse it.
          .filter(([, child]) => child !== false)
          .map(([name, child]) => [
            name,
            this.project(child, path === "" ? name : `${path}.${name}`),
          ]),
      );
      out.properties = properties;
      if (isStringList(source.required)) {
        const required = source.required.filter((name) =>
          Object.hasOwn(properties, name),
        );
        if (required.length > 0) out.required = required;
      }
    }
    if (
      source.additionalProperties === false &&
      (!isRecord(source.patternProperties) ||
        Object.keys(source.patternProperties).length === 0)
    )
      out.additionalProperties = false;
  }

  /** A tuple advertises the union of its positions. */
  private arrayKeywords(source: Schema, out: Schema, path: string): void {
    const tuple = Array.isArray(source.prefixItems)
      ? source.prefixItems
      : Array.isArray(source.items)
        ? source.items
        : undefined;
    if (tuple !== undefined) {
      // Elements past the positions follow `items` (2020-12) or
      // `additionalItems` (draft-07), and are unconstrained without either
      // unless `maxItems` admits none.
      const restSchema = Array.isArray(source.prefixItems)
        ? source.items
        : source.additionalItems;
      const bounded =
        typeof source.maxItems === "number" && source.maxItems <= tuple.length;
      const rest =
        restSchema === false || bounded
          ? []
          : [restSchema === undefined ? true : restSchema];
      out.items = this.elementUnion([...tuple, ...rest], `${path}[]`);
    } else if (isRecord(source.items))
      out.items = this.project(source.items, `${path}[]`);
    if (source.uniqueItems === true)
      this.note(`${label(path)} entries must be distinct.`);
  }

  /** One element schema accepting every member; any-value members stay open. */
  private elementUnion(members: readonly unknown[], path: string): unknown {
    return members.some(
      (member) =>
        member === true ||
        (isRecord(member) && Object.keys(member).length === 0),
    )
      ? {}
      : this.project({ anyOf: members.filter(isRecord) }, path);
  }

  /** `oneOf` widens to `anyOf`; string-literal unions merge into one enum. */
  private unionKeywords(source: Schema, out: Schema, path: string): void {
    const alternatives = Array.isArray(source.anyOf)
      ? source.anyOf
      : Array.isArray(source.oneOf)
        ? source.oneOf
        : undefined;
    if (alternatives === undefined) return;
    const branches = factorObjectEnumUnions(
      this.unionBranches(alternatives, path, out.type),
    );
    if (
      branches.length > 0 &&
      out.enum === undefined &&
      (out.type === undefined || out.type === "string") &&
      branches.every(isStringEnum)
    ) {
      out.type = "string";
      out.enum = [
        ...new Set(branches.flatMap((branch) => (branch as Schema).enum)),
      ];
      return;
    }
    if (branches.length === 1 && isRecord(branches[0])) {
      const branch = branches[0];
      // As with `allOf`, a closure is scoped to its own properties: once the
      // parent's properties win, neither closure may reject the branch's.
      const scoped =
        Object.hasOwn(out, "properties") && Object.hasOwn(branch, "properties");
      for (const [key, keyword] of Object.entries(branch))
        if (!Object.hasOwn(out, key)) out[key] = keyword;
      if (scoped) delete out.additionalProperties;
      return;
    }
    if (branches.length < 2) return;
    out.anyOf = branches;
    const types = new Set(branches.map(branchType));
    if (out.type === undefined && types.size === 1 && !types.has(undefined))
      out.type = [...types][0];
    // Clients require `items` on every array. The union of the branch
    // element schemas restates what the branches already enforce.
    if (
      out.type === "array" &&
      out.items === undefined &&
      branches.every((branch) => isRecord(branch) && isRecord(branch.items))
    )
      out.items = this.elementUnion(
        branches.map((branch) => (branch as Schema).items),
        `${path}[]`,
      );
  }

  /** Flattened, typed from their parent and deduplicated. */
  private unionBranches(
    branches: readonly unknown[],
    path: string,
    parentType: unknown,
  ): unknown[] {
    const branchNotes: string[][] = [];
    const projectedBranches = distinct(
      branches.flatMap((branch) => {
        const typed =
          typeof parentType === "string" &&
          isRecord(branch) &&
          branch.type === undefined &&
          branch.anyOf === undefined &&
          branch.oneOf === undefined
            ? { ...branch, type: parentType }
            : branch;
        const projection = new DialectProjection();
        const projected = projection.project(typed, path);
        branchNotes.push(projection.notes);
        return isRecord(projected) &&
          Array.isArray(projected.anyOf) &&
          onlyKeys(projected, ["anyOf"])
          ? projected.anyOf
          : [projected];
      }),
    );
    for (const note of branchNotes[0] ?? [])
      if (branchNotes.every((notes) => notes.includes(note))) this.note(note);
    return projectedBranches;
  }
}

/** Project one root input schema into the portable advertised dialect. */
export const projectToAdvertisedDialect = (
  root: Readonly<Record<string, unknown>>,
): AdvertisedDialectProjection => {
  const projection = new DialectProjection();
  // The root description joins the tool description whole, not truncated.
  const { description, ...rest } = root;
  const projected = projection.project(rest, "");
  return {
    schema: { type: "object", ...(isRecord(projected) ? projected : {}) },
    guidance: [
      ...(typeof description === "string" && description !== ""
        ? [description]
        : []),
      ...projection.notes,
    ],
  };
};
