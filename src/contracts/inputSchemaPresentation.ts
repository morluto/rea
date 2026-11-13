import {
  JsonSchemaReferences,
  type JsonSchemaScope,
} from "./jsonSchemaReferences.js";
import { isDeepStrictEqual } from "node:util";

import {
  schemaArrays,
  schemaChildren,
  schemaMaps,
} from "./jsonSchemaKeywords.js";

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const referencedDescription = (
  references: JsonSchemaReferences,
  schema: Readonly<Record<string, unknown>>,
  inherited: JsonSchemaScope | undefined,
): string | undefined => {
  let value: unknown = schema;
  let scope = inherited;
  const active = new Set<object>();
  while (isObject(value)) {
    scope = references.enter(value, scope);
    if (
      typeof value.description === "string" &&
      (typeof value.$ref !== "string" || scope?.dialect !== "draft-07")
    )
      return value.description;
    if (typeof value.$ref !== "string" || active.has(value)) return undefined;
    active.add(value);
    const target = references.resolve(scope, value.$ref);
    if (target.kind !== "target") return undefined;
    value = target.value;
  }
  return undefined;
};

const describeSchema = (
  schema: unknown,
  references: JsonSchemaReferences,
  inherited: JsonSchemaScope | undefined,
  describeProperty: (property: string) => string | undefined,
  propertyDescription?: string,
): unknown => {
  if (!isObject(schema)) return schema;
  // These operands are complete producer results, not fields an agent builds.
  // Their owner keeps full canonical validation; only their wire declaration
  // omits the repeated result schema. Analyst-authored controls stay explicit.
  if (schema.type === "object" && schema["x-rea-complete-observation"] === true)
    return {
      type: "object",
      description: [
        propertyDescription ??
          (typeof schema.description === "string"
            ? schema.description
            : undefined),
        "Pass the complete returned normalized_result unchanged. Its fields are omitted from this declaration; the server still validates the complete canonical observation.",
      ]
        .filter((text) => text !== undefined)
        .join(" "),
    };
  const scope = references.enter(schema, inherited);
  const described = Object.fromEntries(
    Object.entries(schema).map(([key, value]) => {
      if (schemaMaps.has(key) && isObject(value))
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([name, child]) => {
              const description =
                key === "properties" && isObject(child)
                  ? (referencedDescription(references, child, scope) ??
                    describeProperty(name))
                  : undefined;
              return [
                name,
                describeSchema(
                  child,
                  references,
                  scope,
                  describeProperty,
                  description,
                ),
              ];
            }),
          ),
        ];
      if (schemaArrays.has(key) && Array.isArray(value))
        return [
          key,
          value.map((child) =>
            describeSchema(child, references, scope, describeProperty),
          ),
        ];
      if (schemaChildren.has(key))
        return [
          key,
          Array.isArray(value)
            ? value.map((child) =>
                describeSchema(child, references, scope, describeProperty),
              )
            : describeSchema(value, references, scope, describeProperty),
        ];
      // Annotation values and literal const/enum data are not schemas.
      return [key, value];
    }),
  );
  return propertyDescription === undefined
    ? described
    : { ...described, description: propertyDescription };
};

const objectBranch = (
  references: JsonSchemaReferences,
  branch: unknown,
): Readonly<Record<string, unknown>> | undefined => {
  // Reference siblings evaluate separately from the target in 2020-12, so a
  // merged object could accept inputs the branch rejects.
  let resolved = branch;
  if (isObject(branch) && typeof branch.$ref === "string") {
    if (Object.keys(branch).length !== 1) return undefined;
    const target = references.resolve(references.rootScope, branch.$ref);
    if (target.kind !== "target") return undefined;
    resolved = target.value;
  }
  return isObject(resolved) &&
    references.enter(resolved, references.rootScope) === references.rootScope &&
    ![
      "$id",
      "$schema",
      "$anchor",
      "$dynamicAnchor",
      "$recursiveAnchor",
      "$dynamicRef",
      "$recursiveRef",
    ].some((key) => Object.hasOwn(resolved, key)) &&
    resolved.type === "object" &&
    isObject(resolved.properties)
    ? resolved
    : undefined;
};

const requiredProperties = (
  branch: Readonly<Record<string, unknown>>,
): readonly string[] =>
  Array.isArray(branch.required)
    ? branch.required.filter((name) => typeof name === "string")
    : [];

const sharedRequiredProperties = (
  branches: readonly Readonly<Record<string, unknown>>[],
): readonly string[] => {
  const [first = [], ...others] = branches.map(requiredProperties);
  return first.filter((name) => others.every((names) => names.includes(name)));
};

const inputGroup = (branch: Readonly<Record<string, unknown>>): string => {
  const required = requiredProperties(branch);
  const optional = Object.keys(branch.properties ?? {})
    .filter((name) => !required.includes(name))
    .map((name) => `[${name}]`);
  return [...required, ...optional].join(" + ");
};

type SchemaNormalization = {
  readonly schema: unknown;
  readonly changed: boolean;
};

const isBooleanLiteralSchema = (schema: unknown): boolean =>
  isObject(schema) &&
  (typeof schema.const === "boolean" ||
    (Array.isArray(schema.enum) &&
      schema.enum.length > 0 &&
      schema.enum.every((value) => typeof value === "boolean")));

const isBooleanSchema = (schema: unknown): boolean =>
  isObject(schema) &&
  (schema.type === "boolean" || isBooleanLiteralSchema(schema));

const isObjectKeyword = (key: string) => schemaMaps.has(key);
const isArrayKeyword = (key: string) => schemaArrays.has(key);
const isChildKeyword = (key: string) => schemaChildren.has(key);

/**
 * Remove every instance default below a schema, not only the one this keyword
 * carries, keeping the entries at `kept`. A nested default belongs to the group
 * that declares it: outside that group a client that fills it would send an
 * object a strict sibling refuses. A default a reference still targets stays
 * caller data; dropping it would leave that reference dangling.
 */
const omitNestedDefaults = (
  schema: unknown,
  kept: ReadonlySet<string> = new Set(),
  path: readonly string[] = [],
): unknown => {
  if (Array.isArray(schema))
    return schema.map((child, index) =>
      omitNestedDefaults(child, kept, [...path, String(index)]),
    );
  if (!isObject(schema)) return schema;
  return Object.fromEntries(
    Object.entries(schema).flatMap(([key, value]) => {
      const childPath = [...path, key];
      if (kept.has(JSON.stringify(childPath))) return [[key, value]];
      if (key === "default") return [];
      return [
        [
          key,
          isObjectKeyword(key) && isObject(value)
            ? Object.fromEntries(
                Object.entries(value).map(([name, child]) => [
                  name,
                  omitNestedDefaults(child, kept, [...childPath, name]),
                ]),
              )
            : isArrayKeyword(key) && Array.isArray(value)
              ? value.map((child, index) =>
                  omitNestedDefaults(child, kept, [
                    ...childPath,
                    String(index),
                  ]),
                )
              : isChildKeyword(key)
                ? Array.isArray(value)
                  ? value.map((child, index) =>
                      omitNestedDefaults(child, kept, [
                        ...childPath,
                        String(index),
                      ]),
                    )
                  : omitNestedDefaults(value, kept, childPath)
                : value,
        ],
      ];
    }),
  );
};

/** Every path into a `default` that a reference inside `schema` targets. */
const referencedDefaultPaths = (
  schema: Readonly<Record<string, unknown>>,
): ReadonlySet<string> => {
  const kept = new Set<string>();
  for (const { target } of new JsonSchemaReferences(schema).references()) {
    if (target.kind !== "target") continue;
    const defaultAt = target.path.indexOf("default");
    if (defaultAt < 0) continue;
    kept.add(JSON.stringify(target.path.slice(0, defaultAt + 1)));
  }
  return kept;
};

const preserveSharedDefault = (
  schema: Record<string, unknown>,
  branches: readonly unknown[],
): void => {
  if (schema.default !== undefined) return;
  const defaults = branches
    .filter(isObject)
    .map((branch) => branch.default)
    .filter((value) => value !== undefined);
  if (
    defaults.length > 0 &&
    defaults.every((value) => isDeepStrictEqual(value, defaults[0]))
  )
    schema.default = defaults[0];
};

/** Schema children, excluding definitions when following validation dependencies. */
const normalizationChildren = (
  schema: Readonly<Record<string, unknown>>,
  definitions: boolean,
): unknown[] =>
  Object.entries(schema).flatMap(([key, value]) => {
    if (schemaMaps.has(key) && isObject(value))
      return !definitions && (key === "$defs" || key === "definitions")
        ? []
        : Object.values(value);
    if (schemaArrays.has(key) && Array.isArray(value)) return value;
    if (schemaChildren.has(key)) return Array.isArray(value) ? value : [value];
    return [];
  });

const hasNormalizedLiteral = (schema: Readonly<Record<string, unknown>>) =>
  typeof schema.const === "boolean" ||
  schema.const === "" ||
  (Array.isArray(schema.enum) &&
    ((schema.enum.length > 0 &&
      schema.enum.every((item) => typeof item === "boolean")) ||
      schema.enum.includes("")));

/** One projection owns actual rewrite sites and their scoped validation dependencies. */
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
    for (const schema of normalizationChildren(entry.schema, true))
      pending.push({ schema, scope });
  }
  const indexed = new Map<JsonSchemaScope | undefined, WeakMap<object, Fact>>();
  const work: {
    schema: Readonly<Record<string, unknown>>;
    scope: JsonSchemaScope | undefined;
    fact: Fact;
  }[] = [];
  const changed: Fact[] = [];
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
    if (
      !ignoresSiblings &&
      sites.get(scope)?.has(schema) &&
      hasNormalizedLiteral(schema)
    ) {
      fact.changed = true;
      changed.push(fact);
    }
    if (typeof schema.$ref === "string") {
      const target = references.resolve(scope, schema.$ref);
      if (target.kind === "target") {
        const dependency = factAt(target.value, scope);
        dependency?.dependents.add(fact);
        dependency?.evaluationDependents.add(fact);
        if (
          dependency !== undefined &&
          isObject(target.value) &&
          !sites.get(references.enter(target.value, scope))?.has(target.value)
        )
          fact.opaqueReference = dependency;
      }
    }
    if (!ignoresSiblings)
      for (const child of normalizationChildren(schema, false))
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

  if (typeof node.const === "boolean") {
    delete node.const;
    if (node.type === undefined) node.type = "boolean";
  }
  if (node.const === "") {
    delete node.const;
    if (node.type === undefined) node.type = "string";
  }
  if (
    Array.isArray(node.enum) &&
    node.enum.length > 0 &&
    node.enum.every((item) => typeof item === "boolean")
  ) {
    delete node.enum;
    if (node.type === undefined) node.type = "boolean";
  }
  if (Array.isArray(node.enum) && node.enum.includes("")) {
    // Removing only the empty member would reject a canonical-valid input.
    // Gemini transports turn const into enum and refuse empty enum members.
    const values = node.enum;
    delete node.enum;
    if (
      node.type === undefined &&
      values.every((item) => typeof item === "string")
    )
      node.type = "string";
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
      const booleanLiteralsOnly = branches.every(isBooleanLiteralSchema);
      if (booleanLiteralsOnly) {
        node.type = "boolean";
        preserveSharedDefault(node, schemas);
        delete node.oneOf;
        continue;
      }
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
    if (
      branchesChanged &&
      schemas.length > 0 &&
      schemas.every(isBooleanSchema)
    ) {
      node.type = "boolean";
      preserveSharedDefault(node, schemas);
      delete node[combinator];
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
        if (
          ![
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
          ].includes(key)
        )
          delete node[key];
    } else delete node.$ref;
    node.description = [
      node.description,
      "This referenced input schema is advertised in reduced form; the server validates the complete canonical input.",
    ]
      .filter((text) => typeof text === "string")
      .join(" ");
  }
  return { schema: node, changed };
};

// Anthropic tool input schemas reject anyOf, oneOf, and allOf at the root, and
// clients then drop the tool or advertise it without parameters. Present a
// root union of strict object groups as one object whose properties are the
// union of the groups. The canonical Zod schema still enforces the exact group.
const flattenRootObjectUnion = (
  root: Record<string, unknown>,
  references: JsonSchemaReferences,
): Record<string, unknown> => {
  const { anyOf, oneOf, ...rest } = root;
  const alternatives = Array.isArray(anyOf) ? anyOf : oneOf;
  if (
    !Array.isArray(alternatives) ||
    alternatives.length === 0 ||
    root.properties !== undefined
  )
    return root;
  // Lifting removes union locations and branch identities. References into those
  // locations, named anchors or unresolved bases cannot survive that rewrite.
  for (const { scope, target } of references.references())
    if (
      (target.kind === "unresolved" && target.reason === "dynamic") ||
      (scope === references.rootScope &&
        (target.kind !== "target" ||
          target.path.length === 0 ||
          target.path[0] === "anyOf" ||
          target.path[0] === "oneOf"))
    )
      return root;
  const branches = alternatives.map((branch) =>
    objectBranch(references, branch),
  );
  if (!branches.every((branch) => branch !== undefined)) return root;
  const variants = new Map<string, unknown[]>();
  for (const branch of branches)
    for (const [name, schema] of Object.entries(branch.properties ?? {})) {
      const known = variants.get(name) ?? [];
      if (!known.some((seen) => isDeepStrictEqual(seen, schema)))
        known.push(schema);
      variants.set(name, known);
    }
  const required = sharedRequiredProperties(branches);
  // A default lifted out of an input group can make a client send a field
  // rejected by another strict group. Keep it only when every group owns the
  // property and supplies the same default. A property some group omits takes
  // its nested defaults too: filling only the inner property would otherwise
  // still send an object that sibling group refuses. A default the nested
  // property carries inside a group that does accept the parent stays, so
  // callers keep that guidance.
  for (const [name, schemas] of variants) {
    const properties = branches.map((branch) =>
      isObject(branch.properties) ? branch.properties[name] : undefined,
    );
    const ownedByEveryGroup = properties.every(isObject);
    const defaults = properties.map((property) =>
      isObject(property) ? property.default : undefined,
    );
    if (
      defaults.every(
        (value) => value !== undefined && isDeepStrictEqual(value, defaults[0]),
      )
    )
      continue;
    const withoutDefaults: unknown[] = [];
    for (const schema of schemas) {
      const withoutDefault = ownedByEveryGroup
        ? isObject(schema) && Object.hasOwn(schema, "default")
          ? Object.fromEntries(
              Object.entries(schema).filter(([key]) => key !== "default"),
            )
          : schema
        : omitNestedDefaults(
            schema,
            isObject(schema) ? referencedDefaultPaths(schema) : new Set(),
          );
      if (
        !withoutDefaults.some((known) =>
          isDeepStrictEqual(known, withoutDefault),
        )
      )
        withoutDefaults.push(withoutDefault);
    }
    variants.set(name, withoutDefaults);
  }
  // A coarse property minimum rejects underspecified objects. Partner fields
  // and exact group membership remain enforced by the canonical runtime parser.
  const fewestRequired = Math.min(
    ...branches.map((branch) => requiredProperties(branch).length),
  );
  // Groups that differ only in property values add no caller guidance.
  const groups = [...new Set(branches.map(inputGroup))];
  const description = [
    typeof rest.description === "string" ? rest.description : undefined,
    groups.length > 1
      ? `Provide a complete input group: ${groups.join("; ")}.`
      : undefined,
  ].filter((text) => text !== undefined);
  const {
    dependencies: _dependencies,
    dependentRequired: _dependentRequired,
    ...presentation
  } = rest;
  return {
    ...presentation,
    type: "object",
    ...(description.length > 0 ? { description: description.join(" ") } : {}),
    properties: Object.fromEntries(
      [...variants].map(([name, schemas]) => [
        name,
        schemas.length === 1 ? schemas[0] : { anyOf: schemas },
      ]),
    ),
    ...(required.length > 0 ? { required } : {}),
    ...(fewestRequired > 0 ? { minProperties: fewestRequired } : {}),
    ...(branches.every((branch) => branch.additionalProperties === false)
      ? { additionalProperties: false }
      : {}),
  };
};

/** Preserve opt-in discriminator relationships without a root union. */
const presentDiscriminatedRoot = (
  root: Record<string, unknown>,
): Record<string, unknown> => {
  const { "x-rea-root-discriminator": discriminator, ...canonical } = root;
  const references = new JsonSchemaReferences(canonical);
  const flattened = flattenRootObjectUnion(canonical, references);
  if (typeof discriminator !== "string" || flattened === canonical)
    return flattened;
  const alternatives = canonical.anyOf ?? canonical.oneOf;
  if (!Array.isArray(alternatives) || alternatives.length !== 2)
    throw new TypeError(
      "A presented root discriminator requires two object alternatives",
    );
  const branches = alternatives.map((alternative) => {
    const branch = objectBranch(references, alternative);
    if (branch === undefined || branch.additionalProperties !== false)
      throw new TypeError(
        "A presented root discriminator requires strict objects",
      );
    return branch;
  });
  const requiredBranch = branches.find((branch) =>
    requiredProperties(branch).includes(discriminator),
  );
  const fallback = branches.find(
    (branch) => !requiredProperties(branch).includes(discriminator),
  );
  const literal = (
    branch: Readonly<Record<string, unknown>> | undefined,
  ): unknown => {
    const properties = branch?.properties;
    const schema = isObject(properties) ? properties[discriminator] : undefined;
    return isObject(schema) ? schema.const : undefined;
  };
  const selected = literal(requiredBranch),
    otherwise = literal(fallback);
  if (
    requiredBranch === undefined ||
    fallback === undefined ||
    typeof selected !== "string" ||
    typeof otherwise !== "string" ||
    selected === otherwise
  )
    throw new TypeError(
      "A presented root discriminator requires distinct literals and one default alternative",
    );
  const properties = Object.fromEntries(
    Object.entries(
      isObject(flattened.properties) ? flattened.properties : {},
    ).map(([key, schema]) => {
      if (!isObject(schema) || !Array.isArray(schema.anyOf))
        return [key, schema];
      const possible = schema.anyOf.filter(
        (alternative) =>
          alternative !== false &&
          !(
            isObject(alternative) &&
            isObject(alternative.not) &&
            Object.keys(alternative.not).length === 0
          ),
      );
      return [key, possible.length === 1 ? possible[0] : schema];
    }),
  );
  const commonRequired = new Set(requiredProperties(flattened));
  const constraints = (branch: Readonly<Record<string, unknown>>) => {
    const own = isObject(branch.properties) ? branch.properties : {};
    const differences = Object.fromEntries(
      Object.entries(properties).flatMap(([key, schema]) => {
        if (key === discriminator || isDeepStrictEqual(schema, own[key]))
          return [];
        return [[key, Object.hasOwn(own, key) ? own[key] : false]];
      }),
    );
    const required = requiredProperties(branch).filter(
      (key) => !commonRequired.has(key),
    );
    return {
      ...(Object.keys(differences).length === 0
        ? {}
        : { properties: differences }),
      ...(required.length === 0 ? {} : { required }),
    };
  };
  // The canonical branch predicates supply validation; omit generic group
  // guidance that would describe the forbidden never-valued property as optional.
  const { description: _description, ...presentation } = flattened;
  return {
    ...presentation,
    properties,
    ...(canonical.description === undefined
      ? {}
      : { description: canonical.description }),
    if: {
      properties: { [discriminator]: { const: selected } },
      required: [discriminator],
    },
    then: constraints(requiredBranch),
    else: constraints(fallback),
  };
};

/** Describe canonical input fields and present the root as one object. */
export const presentInputJsonSchema = (
  root: Record<string, unknown>,
  describeProperty: (property: string) => string | undefined,
): Record<string, unknown> => {
  const flattened = presentDiscriminatedRoot(root);
  const references = new JsonSchemaReferences(flattened);
  const described = describeSchema(
    flattened,
    references,
    references.rootScope,
    describeProperty,
  );
  if (!isObject(described))
    return normalizeAdvertisedSchema(flattened).schema as Record<
      string,
      unknown
    >;
  const {
    dependencies: _dependencies,
    dependentRequired: _dependentRequired,
    ...presentation
  } = described;
  const rootDependencies = isObject(described.dependentRequired)
    ? described.dependentRequired
    : isObject(described.dependencies)
      ? described.dependencies
      : undefined;
  const dependencyGuidance =
    rootDependencies === undefined
      ? []
      : Object.entries(rootDependencies).flatMap(([property, partners]) =>
          Array.isArray(partners) &&
          partners.every((partner) => typeof partner === "string")
            ? [
                `When ${property} is provided, also provide ${partners.join(" and ")}.`,
              ]
            : [],
        );
  if (dependencyGuidance.length === 0)
    return normalizeAdvertisedSchema(presentation).schema as Record<
      string,
      unknown
    >;
  const description = [
    typeof presentation.description === "string"
      ? presentation.description
      : undefined,
    ...dependencyGuidance,
  ].filter((text) => text !== undefined);
  return normalizeAdvertisedSchema({
    ...presentation,
    description: description.join(" "),
  }).schema as Record<string, unknown>;
};
