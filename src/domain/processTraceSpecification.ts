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

const validateUnorderedGroups = (
  language: PartialOrderLanguage,
  context: z.RefinementCtx,
  known: ReadonlySet<string>,
  reachable: ReadonlyMap<string, ReadonlySet<string>>,
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
        if (isOrdered(reachable, leftId, rightId))
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
  reachable: ReadonlyMap<string, ReadonlySet<string>>,
  unorderedPairs: ReadonlySet<string>,
  context: z.RefinementCtx,
): void => {
  for (const [leftIndex, leftId] of ids.entries())
    for (const rightId of ids.slice(leftIndex + 1))
      if (
        !isOrdered(reachable, leftId, rightId) &&
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
      path: ["language", "happens_before"],
    });
  const reachable = computeReachability(ids, adjacency);
  const unorderedPairs = validateUnorderedGroups(
    specification.language,
    context,
    known,
    reachable,
  );
  validateCompletePairDeclarations(ids, reachable, unorderedPairs, context);
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
    for (const [index, event] of specification.events.entries()) {
      if (ids.has(event.id))
        context.addIssue({
          code: "custom",
          message: "event ids must be unique",
          path: ["events", index, "id"],
        });
      ids.add(event.id);
      const predicate = `${event.source}\0${canonicalTraceJson(event.exact)}`;
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
