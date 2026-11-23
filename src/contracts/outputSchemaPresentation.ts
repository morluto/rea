import {
  JsonSchemaReferences,
  type JsonSchemaScope,
} from "./jsonSchemaReferences.js";
import { isRecord as isObject } from "../kernel/isRecord.js";
import { advertisedSchemaPatterns } from "./advertisedDialect.js";
import { projectPortablePattern } from "./portablePattern.js";
import {
  mapSchemaChildren,
  schemaArrays,
  schemaChildren,
  schemaMaps,
  schemaPointerSteps,
  schemaSubschemas,
} from "./jsonSchemaKeywords.js";

// Listed output schemas keep the canonical structure; SDK clients compile
// them, so every pattern is re-emitted in the portable grammar. A pattern
// without an exact portable form widens its site, and enclosing `not`, `if`,
// `oneOf` and references that depend on that site keep only widening. Input
// schemas take the advertised dialect projection instead, which owns their
// patterns.

type SchemaNormalization = {
  readonly schema: unknown;
  readonly changed: boolean;
};

// Draft-07 ignores the siblings of a reference, so relaxing one removes them.
const hasReference = (schema: Readonly<Record<string, unknown>>): boolean =>
  ["$ref", "$dynamicRef", "$recursiveRef"].some(
    (keyword) => typeof schema[keyword] === "string",
  );

/**
 * A pattern the portable projection cannot reproduce exactly widens its site.
 * Exact re-emission keeps the site's meaning, so its dependents stay intact.
 */
const hasWidenedPattern = (schema: Readonly<Record<string, unknown>>) =>
  typeof schema.pattern === "string" &&
  projectPortablePattern(schema.pattern).kind !== "exact";

/** One projection owns actual rewrite sites and their scoped validation dependencies. */
/**
 * Keywords normalization may remove or rename: a widened `not` or `if` is
 * dropped with its branches, a widened `oneOf` becomes `anyOf`, and lost
 * evaluation drops `unevaluatedProperties` and `unevaluatedItems`.
 */
const REMOVABLE_KEYWORDS = new Set([
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "unevaluatedProperties",
  "unevaluatedItems",
]);

/** Keywords a relaxed draft-07 reference keeps; its other siblings go. */
const DRAFT07_REDUCED_REFERENCE_KEYS = new Set([
  "$id",
  "$schema",
  "$anchor",
  "$defs",
  "definitions",
  "description",
  "title",
  "default",
  "examples",
  "$comment",
]);

const throughRemovableLocation = (
  root: unknown,
  path: readonly string[],
  draft07: boolean,
): boolean => {
  let value = root;
  for (const [index, step] of schemaPointerSteps(path).entries()) {
    // Relaxing a draft-07 reference removes its ignored siblings, including
    // literal-valued ones such as `const`.
    if (
      draft07 &&
      step.kind !== "entry" &&
      isObject(value) &&
      hasReference(value) &&
      !DRAFT07_REDUCED_REFERENCE_KEYS.has(step.keyword)
    )
      return true;
    if (step.kind === "keyword" && REMOVABLE_KEYWORDS.has(step.keyword))
      return true;
    value =
      typeof value === "object" && value !== null
        ? Reflect.get(value, path[index]!)
        : undefined;
  }
  return false;
};

const normalizationContext = (root: Readonly<Record<string, unknown>>) => {
  const references = new JsonSchemaReferences(root);
  type Fact = {
    changed: boolean;
    lostEvaluation: boolean;
    dependents: Set<Fact>;
    evaluationDependents: Set<Fact>;
    opaqueReference?: Fact;
  };
  const sites = new Map<JsonSchemaScope | undefined, WeakSet<object>>();
  const pending: { schema: unknown; scope: JsonSchemaScope | undefined }[] = [
    { schema: root, scope: references.rootScope },
  ];
  const entries: {
    schema: Readonly<Record<string, unknown>>;
    scope: JsonSchemaScope | undefined;
  }[] = [];
  // Literal payloads are not rewritten, even when a reference evaluates them.
  while (pending.length > 0) {
    const entry = pending.pop()!;
    if (!isObject(entry.schema)) continue;
    const scope = references.enter(entry.schema, entry.scope);
    let seen = sites.get(scope);
    if (seen === undefined) sites.set(scope, (seen = new WeakSet()));
    if (seen.has(entry.schema)) continue;
    seen.add(entry.schema);
    entries.push({ schema: entry.schema, scope });
    for (const schema of schemaSubschemas(entry.schema, {
      includeDefinitions: true,
    }))
      pending.push({ schema, scope });
  }
  const indexed = new Map<JsonSchemaScope | undefined, WeakMap<object, Fact>>();
  const work: {
    schema: Readonly<Record<string, unknown>>;
    scope: JsonSchemaScope | undefined;
    fact: Fact;
  }[] = [];
  const changed: Fact[] = [];
  const untracked: Fact[] = [];
  const factAt = (
    schema: unknown,
    inherited: JsonSchemaScope | undefined,
  ): Fact | undefined => {
    if (!isObject(schema)) return undefined;
    const scope = references.enter(schema, inherited);
    let facts = indexed.get(scope);
    if (facts === undefined) indexed.set(scope, (facts = new WeakMap()));
    const existing = facts.get(schema);
    if (existing !== undefined) return existing;
    const fact: Fact = {
      changed: false,
      lostEvaluation: false,
      dependents: new Set(),
      evaluationDependents: new Set(),
    };
    facts.set(schema, fact);
    work.push({ schema, scope, fact });
    return fact;
  };
  for (const { schema, scope } of entries) factAt(schema, scope);
  for (let index = 0; index < work.length; index++) {
    const { schema, scope, fact } = work[index]!;
    const ignoresSiblings =
      scope?.dialect === "draft-07" && typeof schema.$ref === "string";
    const projection =
      typeof schema.pattern === "string"
        ? projectPortablePattern(schema.pattern)
        : undefined;
    const opaquePatternChanged =
      !sites.get(scope)?.has(schema) &&
      projection !== undefined &&
      (projection.kind !== "exact" || projection.pattern !== schema.pattern);
    if (
      !ignoresSiblings &&
      (opaquePatternChanged ||
        (sites.get(scope)?.has(schema) && hasWidenedPattern(schema)))
    ) {
      fact.changed = true;
      changed.push(fact);
    }
    if (typeof schema.$ref === "string") {
      const target = references.resolve(scope, schema.$ref);
      if (
        target.kind === "target" &&
        !throughRemovableLocation(
          scope?.root,
          target.path,
          scope?.dialect === "draft-07",
        )
      ) {
        const dependency = factAt(target.value, scope);
        dependency?.dependents.add(fact);
        dependency?.evaluationDependents.add(fact);
        if (
          dependency !== undefined &&
          isObject(target.value) &&
          !sites.get(references.enter(target.value, scope))?.has(target.value)
        )
          fact.opaqueReference = dependency;
      } else if (target.kind !== "unresolved") {
        // Named anchors and pointers into removable locations are not
        // followed by this owner. Relax them when normalizing so a widened or
        // moved target cannot make a negation stricter or leave a dangling
        // reference.
        fact.opaqueReference = fact;
        if (!fact.changed) {
          fact.changed = true;
          changed.push(fact);
        }
      } else untracked.push(fact);
    }
    if (
      scope?.dialect !== "draft-07" &&
      (typeof schema.$dynamicRef === "string" ||
        typeof schema.$recursiveRef === "string")
    )
      untracked.push(fact);
    if (!ignoresSiblings)
      for (const child of schemaSubschemas(schema, {
        includeDefinitions: false,
      }))
        factAt(child, scope)?.dependents.add(fact);
    if (!ignoresSiblings)
      for (const key of [
        "allOf",
        "anyOf",
        "oneOf",
        "if",
        "then",
        "else",
        "dependentSchemas",
        "dependencies",
      ]) {
        const value = schema[key];
        const children = Array.isArray(value)
          ? value
          : schemaMaps.has(key) && isObject(value)
            ? Object.values(value)
            : [value];
        for (const child of children)
          factAt(child, scope)?.evaluationDependents.add(fact);
      }
  }
  // Dynamic targets depend on the evaluation path, and an unresolved target
  // may be an embedded resource this owner rewrote. Neither is followed, so
  // once anything widens, relax them like named anchors.
  if (changed.length > 0)
    for (const fact of untracked) {
      fact.opaqueReference = fact;
      if (!fact.changed) {
        fact.changed = true;
        changed.push(fact);
      }
    }
  for (let index = 0; index < changed.length; index++)
    for (const dependent of changed[index]!.dependents)
      if (!dependent.changed) {
        dependent.changed = true;
        changed.push(dependent);
      }
  const lost: Fact[] = [];
  for (const { schema, scope, fact } of work)
    if (
      sites.get(scope)?.has(schema) &&
      (fact.opaqueReference?.changed ||
        (!(scope?.dialect === "draft-07" && typeof schema.$ref === "string") &&
          factAt(schema.if, scope)?.changed))
    ) {
      fact.lostEvaluation = true;
      lost.push(fact);
    }
  for (let index = 0; index < lost.length; index++)
    for (const dependent of lost[index]!.evaluationDependents)
      if (!dependent.lostEvaluation) {
        dependent.lostEvaluation = true;
        lost.push(dependent);
      }
  return {
    references,
    changed: (schema: object, scope: JsonSchemaScope | undefined) =>
      indexed.get(scope)?.get(schema)?.changed === true,
    lostEvaluation: (schema: object, scope: JsonSchemaScope | undefined) =>
      indexed.get(scope)?.get(schema)?.lostEvaluation === true,
    reduceReference: (schema: object, scope: JsonSchemaScope | undefined) =>
      indexed.get(scope)?.get(schema)?.opaqueReference?.changed === true,
  };
};

const normalizeAdvertisedSchema = (
  value: unknown,
  context?: ReturnType<typeof normalizationContext>,
  inherited?: JsonSchemaScope,
): SchemaNormalization => {
  if (!isObject(value)) return { schema: value, changed: false };
  const owner = context ?? normalizationContext(value);
  const scope = owner.references.enter(
    value,
    context === undefined ? owner.references.rootScope : inherited,
  );
  const normalize = (child: unknown) =>
    normalizeAdvertisedSchema(child, owner, scope);
  const node: Record<string, unknown> = { ...value };
  const changed = owner.changed(value, scope);
  const normalizeMap = (map: Readonly<Record<string, unknown>>) =>
    Object.fromEntries(
      Object.entries(map).map(([name, child]) => [
        name,
        normalize(child).schema,
      ]),
    );

  for (const [key, child] of Object.entries(value)) {
    if (schemaMaps.has(key) && isObject(child)) {
      node[key] = normalizeMap(child);
    } else if (
      schemaArrays.has(key) &&
      key !== "anyOf" &&
      key !== "oneOf" &&
      Array.isArray(child)
    ) {
      node[key] = child.map(normalize).map((result) => result.schema);
    } else if (
      schemaChildren.has(key) &&
      key !== "not" &&
      key !== "if" &&
      key !== "then" &&
      key !== "else"
    ) {
      const results = Array.isArray(child)
        ? child.map(normalize)
        : [normalize(child)];
      const nestedChanged = results.some((result) => result.changed);
      if (
        key === "contains" &&
        nestedChanged &&
        value.maxContains !== undefined
      ) {
        delete node.maxContains;
        node.contains = results[0]?.schema;
      } else {
        node[key] = Array.isArray(child)
          ? results.map((result) => result.schema)
          : results[0]?.schema;
      }
    }
  }

  if (typeof node.pattern === "string") {
    // Clients refuse the complete tools request over one pattern their regex
    // engine cannot compile. A widened or omitted pattern marks this site
    // changed, so enclosing `not`, `if` and `oneOf` keep only widening.
    const projected = projectPortablePattern(node.pattern);
    if (projected.kind === "unexpressible") delete node.pattern;
    else node.pattern = projected.pattern;
  }

  const negated = Object.hasOwn(value, "not")
    ? normalize(value.not)
    : undefined;
  if (negated?.changed) {
    // Widening a predicate under `not` narrows the containing schema.
    delete node.not;
  } else if (negated !== undefined) {
    node.not = negated.schema;
  }

  const conditional = Object.hasOwn(value, "if")
    ? normalize(value.if)
    : undefined;
  const thenBranch = Object.hasOwn(value, "then")
    ? normalize(value.then)
    : undefined;
  const elseBranch = Object.hasOwn(value, "else")
    ? normalize(value.else)
    : undefined;
  if (conditional?.changed) {
    // Changing the predicate can route canonical-valid inputs into a rejecting branch.
    delete node.if;
    delete node.then;
    delete node.else;
  } else {
    if (conditional !== undefined) node.if = conditional.schema;
    if (thenBranch !== undefined) {
      node.then = thenBranch.schema;
    }
    if (elseBranch !== undefined) {
      node.else = elseBranch.schema;
    }
  }

  for (const combinator of ["anyOf", "oneOf"] as const) {
    const branches = value[combinator];
    if (!Array.isArray(branches)) continue;
    const normalized = branches.map(normalize);
    const schemas = normalized.map((result) => result.schema);
    const branchesChanged = normalized.some((result) => result.changed);
    if (combinator === "oneOf" && branchesChanged) {
      // `anyOf` retains branch guidance without allowing widened branches to
      // reject inputs that were accepted by exactly one canonical branch.
      delete node.oneOf;
      if (Array.isArray(node.anyOf)) {
        const existingAllOf = Array.isArray(node.allOf) ? node.allOf : [];
        node.allOf = [...existingAllOf, { anyOf: schemas }];
      } else {
        node.anyOf = schemas;
      }
      continue;
    }
    node[combinator] = schemas;
  }

  if (owner.lostEvaluation(value, scope)) {
    delete node.unevaluatedProperties;
    delete node.unevaluatedItems;
  }
  if (owner.reduceReference(value, scope)) {
    // The target is also caller literal data. Keep that data intact and relax
    // this affected reference rather than copy or mutate its executable view.
    if (scope?.dialect === "draft-07") {
      for (const key of Object.keys(node))
        if (!DRAFT07_REDUCED_REFERENCE_KEYS.has(key)) delete node[key];
    } else {
      delete node.$ref;
      delete node.$dynamicRef;
      delete node.$recursiveRef;
    }
    node.description = [
      node.description,
      "This referenced schema is advertised in reduced form; the server validates the complete canonical value.",
    ]
      .filter((text) => typeof text === "string")
      .join(" ");
  }
  return { schema: node, changed };
};

/**
 * Present an output schema with portable patterns. SDK clients compile every
 * listed output schema; literals stay, since no model reads them.
 */
export const presentOutputJsonSchema = (
  root: Record<string, unknown>,
): Record<string, unknown> => {
  const patterns = advertisedSchemaPatterns(root).map(({ pattern }) => ({
    pattern,
    projection: projectPortablePattern(pattern),
  }));
  if (hasLiteralReference(root))
    return normalizeAdvertisedSchema(root).schema as Record<string, unknown>;
  // Output schemas reach several megabytes. Exact re-emission changes no
  // dependent, so only a widened pattern needs the dependency analysis.
  if (patterns.some(({ projection }) => projection.kind !== "exact"))
    return normalizeAdvertisedSchema(root).schema as Record<string, unknown>;
  if (
    patterns.every(
      ({ pattern, projection }) =>
        projection.kind === "exact" && projection.pattern === pattern,
    )
  )
    return root;
  return replaceExactPatterns(root) as Record<string, unknown>;
};

/** A reference into literal data needs dependency analysis, not in-place rewriting. */
const hasLiteralReference = (root: Record<string, unknown>): boolean => {
  const pending: unknown[] = [root];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (!isObject(value) || visited.has(value)) continue;
    visited.add(value);
    if (typeof value.$ref === "string") {
      try {
        const reference = decodeURIComponent(value.$ref);
        if (
          /(?:^#\/|\/)(?:default|const|enum|examples)(?:\/|$)/u.test(reference)
        )
          return true;
      } catch {
        // An invalid fragment cannot name one of these locations.
      }
    }
    pending.push(...schemaSubschemas(value, { includeDefinitions: true }));
  }
  return false;
};

/** Copy schema positions, replacing each pattern with its exact portable form. */
const replaceExactPatterns = (schema: unknown): unknown => {
  if (!isObject(schema)) return schema;
  const rebuilt = mapSchemaChildren(
    schema as Record<string, unknown>,
    replaceExactPatterns,
  );
  if (typeof rebuilt.pattern !== "string") return rebuilt;
  const projection = projectPortablePattern(rebuilt.pattern);
  if (projection.kind !== "exact" || projection.pattern === rebuilt.pattern)
    return rebuilt;
  return { ...rebuilt, pattern: projection.pattern };
};
