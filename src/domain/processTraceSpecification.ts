import canonicalize from "canonicalize";
import { z } from "zod";

import { jsonValueSchema } from "./jsonValue.js";

const identifierSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u);

/** Process observation families admitted by a declared trace specification. */
export const processTraceSourceSchema = z.enum([
  "terminal_raw",
  "terminal_rendered",
  "interaction",
  "lifecycle",
  "process",
  "filesystem",
  "http",
  "websocket",
  "shim",
  "replay_transition",
]);
export type ProcessTraceSource = z.infer<typeof processTraceSourceSchema>;

const cardinalitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("required") }),
  z.strictObject({ kind: z.literal("optional") }),
  z.strictObject({
    kind: z.literal("exact"),
    count: z.number().int().min(0).max(10_000),
  }),
  z
    .strictObject({
      kind: z.literal("range"),
      min: z.number().int().min(0).max(10_000),
      max: z.number().int().min(0).max(10_000),
    })
    .refine(({ min, max }) => min <= max, {
      message: "cardinality min must not exceed max",
      path: ["min"],
    }),
]);

const eventDeclarationSchema = z.strictObject({
  id: identifierSchema,
  source: processTraceSourceSchema,
  exact: jsonValueSchema,
  ignore_fields: z
    .array(
      z.enum([
        "sequence",
        "at_ms",
        "scheduled_at_ms",
        "dispatched_at_ms",
        "elapsed_ms",
      ]),
    )
    .max(5)
    .refine((values) => new Set(values).size === values.length, {
      message: "ignored event fields must be unique",
    })
    .optional(),
  cardinality: cardinalitySchema.default({ kind: "required" }),
});

const partialOrderLanguageSchema = z.strictObject({
  kind: z.literal("partial_order"),
  happens_before: z
    .array(
      z.strictObject({
        before: identifierSchema,
        after: identifierSchema,
      }),
    )
    .max(4_096)
    .default([]),
  not_before: z
    .array(
      z.strictObject({
        event: identifierSchema,
        anchor: identifierSchema,
      }),
    )
    .max(4_096)
    .default([]),
  unordered_groups: z
    .array(
      z.strictObject({ events: z.array(identifierSchema).min(2).max(256) }),
    )
    .max(256)
    .default([]),
  prefix: z.array(identifierSchema).max(4_096).default([]),
  suffix: z.array(identifierSchema).max(4_096).default([]),
});

const finiteTraceTokenSchema = z.union([
  identifierSchema,
  z.strictObject({ unordered: z.array(identifierSchema).min(2).max(256) }),
]);

const finiteTraceLanguageSchema = z.strictObject({
  kind: z.literal("finite_traces"),
  variants: z
    .array(
      z.strictObject({
        id: identifierSchema,
        trace: z.array(finiteTraceTokenSchema).max(4_096),
      }),
    )
    .min(1)
    .max(64),
});

const specificationShapeSchema = z.strictObject({
  version: z.literal(1),
  events: z.array(eventDeclarationSchema).min(1).max(256),
  language: z.discriminatedUnion("kind", [
    partialOrderLanguageSchema,
    finiteTraceLanguageSchema,
  ]),
});

export type ProcessTraceSpecification = z.infer<
  typeof specificationShapeSchema
>;
type PartialOrderLanguage = z.infer<typeof partialOrderLanguageSchema>;

export const canonicalTraceJson = (value: unknown): string => {
  const serialized = canonicalize(value);
  if (serialized === undefined)
    throw new TypeError("Trace specification contains a non-JSON value");
  return serialized;
};

/** Remove only explicitly declared schedule metadata before exact matching. */
export const comparableTracePayload = (
  value: unknown,
  ignoredFields: readonly string[] = [],
): unknown => {
  if (
    ignoredFields.length === 0 ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  )
    return value;
  return Object.fromEntries(
    Object.entries(value).filter(([name]) => !ignoredFields.includes(name)),
  );
};

export const processTraceCardinalityBounds = (
  cardinality: ProcessTraceSpecification["events"][number]["cardinality"],
): readonly [number, number] => {
  switch (cardinality.kind) {
    case "required":
      return [1, 1];
    case "optional":
      return [0, 1];
    case "exact":
      return [cardinality.count, cardinality.count];
    case "range":
      return [cardinality.min, cardinality.max];
  }
};

const addReferenceIssue = (
  context: z.RefinementCtx,
  known: ReadonlySet<string>,
  id: string,
  path: PropertyKey[],
): void => {
  if (!known.has(id))
    context.addIssue({
      code: "custom",
      message: `unknown event id: ${id}`,
      path,
    });
};

const pairKey = (left: string, right: string): string =>
  [left, right].sort().join("\0");

const buildAdjacency = (
  language: PartialOrderLanguage,
  context: z.RefinementCtx,
  known: ReadonlySet<string>,
): ReadonlyMap<string, Set<string>> => {
  const adjacency = new Map([...known].map((id) => [id, new Set<string>()]));
  for (const [index, edge] of language.happens_before.entries()) {
    const path = ["language", "happens_before", index];
    addReferenceIssue(context, known, edge.before, [...path, "before"]);
    addReferenceIssue(context, known, edge.after, [...path, "after"]);
    if (edge.before === edge.after)
      context.addIssue({
        code: "custom",
        message: "happens-before edges must reference distinct events",
        path,
      });
    adjacency.get(edge.before)?.add(edge.after);
  }
  return adjacency;
};

const validateNotBefore = (
  language: PartialOrderLanguage,
  context: z.RefinementCtx,
  known: ReadonlySet<string>,
  reachable: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlySet<string> => {
  const pairs = new Set<string>();
  for (const [index, constraint] of language.not_before.entries()) {
    const path = ["language", "not_before", index];
    addReferenceIssue(context, known, constraint.event, [...path, "event"]);
    addReferenceIssue(context, known, constraint.anchor, [...path, "anchor"]);
    if (constraint.event === constraint.anchor)
      context.addIssue({
        code: "custom",
        message: "not-before constraints must reference distinct events",
        path,
      });
    const key = pairKey(constraint.event, constraint.anchor);
    if (pairs.has(key))
      context.addIssue({
        code: "custom",
        message: "not-before event pairs must be declared once",
        path,
      });
    pairs.add(key);
    if (reachable.get(constraint.event)?.has(constraint.anchor) === true)
      context.addIssue({
        code: "custom",
        message: "not-before constraint conflicts with happens-before order",
        path,
      });
  }
  return pairs;
};

const graphHasCycle = (
  ids: readonly string[],
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): boolean => {
  const active = new Set<string>();
  const complete = new Set<string>();
  const visit = (current: string): boolean => {
    if (active.has(current)) return true;
    if (complete.has(current)) return false;
    active.add(current);
    const cyclic = [...(adjacency.get(current) ?? [])].some(visit);
    active.delete(current);
    complete.add(current);
    return cyclic;
  };
  return ids.some(visit);
};

const computeReachability = (
  ids: readonly string[],
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const reachable = new Map<string, Set<string>>();
  for (const origin of ids) {
    const seen = new Set<string>();
    const pending = [...(adjacency.get(origin) ?? [])];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || seen.has(current)) continue;
      seen.add(current);
      pending.push(...(adjacency.get(current) ?? []));
    }
    reachable.set(origin, seen);
  }
  return reachable;
};

const isOrdered = (
  reachable: ReadonlyMap<string, ReadonlySet<string>>,
  left: string,
  right: string,
): boolean =>
  reachable.get(left)?.has(right) === true ||
  reachable.get(right)?.has(left) === true;

type OrderingRelations = {
  readonly reachable: ReadonlyMap<string, ReadonlySet<string>>;
  readonly notBeforePairs: ReadonlySet<string>;
};

const validateUnorderedGroups = (
  language: PartialOrderLanguage,
  context: z.RefinementCtx,
  known: ReadonlySet<string>,
  relations: OrderingRelations,
): ReadonlySet<string> => {
  const pairs = new Set<string>();
  for (const [groupIndex, group] of language.unordered_groups.entries()) {
    const path = ["language", "unordered_groups", groupIndex];
    if (new Set(group.events).size !== group.events.length)
      context.addIssue({
        code: "custom",
        message: "unordered groups must not repeat event ids",
        path: [...path, "events"],
      });
    for (const [eventIndex, id] of group.events.entries())
      addReferenceIssue(context, known, id, [...path, "events", eventIndex]);
    for (const [leftIndex, leftId] of group.events.entries()) {
      for (const rightId of group.events.slice(leftIndex + 1)) {
        const key = pairKey(leftId, rightId);
        if (pairs.has(key))
          context.addIssue({
            code: "custom",
            message: "unordered event pairs must be declared once",
            path,
          });
        pairs.add(key);
        if (
          isOrdered(relations.reachable, leftId, rightId) ||
          relations.notBeforePairs.has(key)
        )
          context.addIssue({
            code: "custom",
            message: "ordered events cannot also be declared unordered",
            path,
          });
      }
    }
  }
  return pairs;
};

const validateCompletePairDeclarations = (
  ids: readonly string[],
  relations: OrderingRelations,
  unorderedPairs: ReadonlySet<string>,
  context: z.RefinementCtx,
): void => {
  for (const [leftIndex, leftId] of ids.entries())
    for (const rightId of ids.slice(leftIndex + 1))
      if (
        !isOrdered(relations.reachable, leftId, rightId) &&
        !relations.notBeforePairs.has(pairKey(leftId, rightId)) &&
        !unorderedPairs.has(pairKey(leftId, rightId))
      )
        context.addIssue({
          code: "custom",
          message: `event pair ${leftId}/${rightId} must be explicitly ordered or unordered`,
          path: ["language"],
        });
};

const validatePartialOrder = (
  specification: ProcessTraceSpecification,
  context: z.RefinementCtx,
): void => {
  if (specification.language.kind !== "partial_order") return;
  const ids = specification.events.map(({ id }) => id);
  const known = new Set(ids);
  const adjacency = buildAdjacency(specification.language, context, known);
  if (graphHasCycle(ids, adjacency))
    context.addIssue({
      code: "custom",
      message: "happens-before graph must be acyclic",
      path: ["language"],
    });
  const reachable = computeReachability(ids, adjacency);
  const notBeforePairs = validateNotBefore(
    specification.language,
    context,
    known,
    reachable,
  );
  const relations = { reachable, notBeforePairs };
  const unorderedPairs = validateUnorderedGroups(
    specification.language,
    context,
    known,
    relations,
  );
  validateCompletePairDeclarations(ids, relations, unorderedPairs, context);
  for (const [kind, values] of [
    ["prefix", specification.language.prefix],
    ["suffix", specification.language.suffix],
  ] as const)
    for (const [index, id] of values.entries())
      addReferenceIssue(context, known, id, ["language", kind, index]);
};

const countVariantEvents = (
  trace: readonly (string | { readonly unordered: readonly string[] })[],
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const token of trace)
    for (const id of typeof token === "string" ? [token] : token.unordered)
      counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
};

const validateFiniteTraces = (
  specification: ProcessTraceSpecification,
  context: z.RefinementCtx,
): void => {
  if (specification.language.kind !== "finite_traces") return;
  const known = new Set(specification.events.map(({ id }) => id));
  const variantIds = new Set<string>();
  const variantTraces = new Set<string>();
  for (const [
    variantIndex,
    variant,
  ] of specification.language.variants.entries()) {
    const variantPath = ["language", "variants", variantIndex];
    if (variantIds.has(variant.id))
      context.addIssue({
        code: "custom",
        message: "finite trace variant ids must be unique",
        path: [...variantPath, "id"],
      });
    variantIds.add(variant.id);
    const canonicalTrace = canonicalTraceJson(variant.trace);
    if (variantTraces.has(canonicalTrace))
      context.addIssue({
        code: "custom",
        message: "finite trace variants must not duplicate a trace",
        path: [...variantPath, "trace"],
      });
    variantTraces.add(canonicalTrace);
    for (const [tokenIndex, token] of variant.trace.entries()) {
      const values = typeof token === "string" ? [token] : token.unordered;
      for (const [eventIndex, id] of values.entries())
        addReferenceIssue(context, known, id, [
          ...variantPath,
          "trace",
          tokenIndex,
          ...(typeof token === "string" ? [] : ["unordered", eventIndex]),
        ]);
    }
    const counts = countVariantEvents(variant.trace);
    for (const event of specification.events) {
      const [minimum, maximum] = processTraceCardinalityBounds(
        event.cardinality,
      );
      const count = counts.get(event.id) ?? 0;
      if (count < minimum || count > maximum)
        context.addIssue({
          code: "custom",
          message: `variant ${variant.id} violates ${event.id} cardinality`,
          path: [...variantPath, "trace"],
        });
    }
  }
};

/** Strict, bounded concurrency model for Process Capture observations. */
export const processTraceSpecificationSchema =
  specificationShapeSchema.superRefine((specification, context) => {
    const ids = new Set<string>();
    const predicates = new Set<string>();
    const ignoredFieldsBySource = new Map<string, string>();
    for (const [index, event] of specification.events.entries()) {
      if (ids.has(event.id))
        context.addIssue({
          code: "custom",
          message: "event ids must be unique",
          path: ["events", index, "id"],
        });
      ids.add(event.id);
      const ignoredFields = [...(event.ignore_fields ?? [])].sort();
      if (
        ignoredFields.length > 0 &&
        (typeof event.exact !== "object" ||
          event.exact === null ||
          Array.isArray(event.exact))
      )
        context.addIssue({
          code: "custom",
          message: "ignored schedule fields require an exact object payload",
          path: ["events", index, "ignore_fields"],
        });
      const ignoredKey = canonicalTraceJson(ignoredFields);
      const priorIgnoredKey = ignoredFieldsBySource.get(event.source);
      if (priorIgnoredKey !== undefined && priorIgnoredKey !== ignoredKey)
        context.addIssue({
          code: "custom",
          message:
            "events from one source must use the same ignored schedule fields",
          path: ["events", index, "ignore_fields"],
        });
      ignoredFieldsBySource.set(event.source, ignoredKey);
      if (
        ignoredFields.some(
          (field) =>
            typeof event.exact === "object" &&
            event.exact !== null &&
            !Array.isArray(event.exact) &&
            field in event.exact,
        )
      )
        context.addIssue({
          code: "custom",
          message: "exact payload must omit every ignored schedule field",
          path: ["events", index, "exact"],
        });
      const predicate = `${event.source}\0${canonicalTraceJson(
        comparableTracePayload(event.exact, ignoredFields),
      )}`;
      if (predicates.has(predicate))
        context.addIssue({
          code: "custom",
          message: "exact event predicates must not overlap",
          path: ["events", index],
        });
      predicates.add(predicate);
    }
    validatePartialOrder(specification, context);
    validateFiniteTraces(specification, context);
  });
