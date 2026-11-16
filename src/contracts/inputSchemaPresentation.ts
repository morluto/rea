import {
  JsonSchemaReferences,
  type JsonSchemaScope,
} from "./jsonSchemaReferences.js";
import { isDeepStrictEqual } from "node:util";

import type { SchemaAnnotations } from "../domain/schemaAnnotations.js";
import {
  schemaArrays,
  schemaChildren,
  schemaMaps,
  schemaPointerSteps,
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
    const steps = schemaPointerSteps(target.path);
    const last = steps.at(-1);
    if (last?.kind !== "value" || last.keyword !== "default") continue;
    kept.add(JSON.stringify(target.path.slice(0, steps.length)));
  }
  return kept;
};

// The advertised dialect's `root-shape` rule requires a plain object root
// without a combinator. Present a root union of strict object groups as one
// object whose properties are the union of the groups. The canonical Zod
// schema still enforces the exact group.
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
  canonical: Record<string, unknown>,
  discriminator: string | undefined,
): Record<string, unknown> => {
  const references = new JsonSchemaReferences(canonical);
  const flattened = flattenRootObjectUnion(canonical, references);
  if (discriminator === undefined || flattened === canonical) return flattened;
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
  // A branch may select one literal or an enumerated set of them.
  const literals = (
    branch: Readonly<Record<string, unknown>> | undefined,
  ): readonly string[] | undefined => {
    const properties = branch?.properties;
    const schema = isObject(properties) ? properties[discriminator] : undefined;
    if (!isObject(schema)) return undefined;
    if (typeof schema.const === "string") return [schema.const];
    return Array.isArray(schema.enum) &&
      schema.enum.length > 0 &&
      schema.enum.every((value) => typeof value === "string")
      ? schema.enum
      : undefined;
  };
  const selectedValues = literals(requiredBranch),
    otherwiseValues = literals(fallback);
  const selected = selectedValues?.[0],
    otherwise = otherwiseValues?.[0];
  if (
    requiredBranch === undefined ||
    fallback === undefined ||
    selectedValues === undefined ||
    otherwiseValues === undefined ||
    selected === undefined ||
    otherwise === undefined ||
    selectedValues.some((value) => otherwiseValues.includes(value))
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
      properties: {
        [discriminator]:
          selectedValues.length === 1
            ? { const: selected }
            : { enum: selectedValues },
      },
      required: [discriminator],
    },
    then: constraints(requiredBranch),
    else: constraints(fallback),
  };
};

/**
 * Describe canonical input fields and present the root as one object. Every
 * other portability rule (patterns, literals, dependencies as prose) belongs
 * to the advertised dialect projection that the listed presentation applies.
 */
export const presentInputJsonSchema = (
  root: Record<string, unknown>,
  describeProperty: (property: string) => string | undefined,
  annotations: Pick<SchemaAnnotations, "rootDiscriminator"> = {},
): Record<string, unknown> => {
  const flattened = presentDiscriminatedRoot(
    root,
    annotations.rootDiscriminator,
  );
  const references = new JsonSchemaReferences(flattened);
  const described = describeSchema(
    flattened,
    references,
    references.rootScope,
    describeProperty,
  );
  return isObject(described) ? { ...described } : flattened;
};
