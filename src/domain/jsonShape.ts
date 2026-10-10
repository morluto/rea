import { z } from "zod";

import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";

const jsonValueTypeSchema = z.enum([
  "object",
  "array",
  "string",
  "number",
  "boolean",
  "null",
]);
type JsonValueType = z.infer<typeof jsonValueTypeSchema>;

const jsonShapePathSegmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("property"), name: z.string() }),
  z.object({ kind: z.literal("array-element") }),
]);
type JsonShapePathSegment = z.infer<typeof jsonShapePathSegmentSchema>;

/** Value-free structural summary of one approved JSON payload. */
export const jsonShapeSchema = z.object({
  root_type: jsonValueTypeSchema,
  node_count: z.number().int().min(1),
  max_depth_observed: z.number().int().min(0),
  properties: z.array(
    z.object({
      path: z.array(jsonShapePathSegmentSchema).min(1),
      types: z.array(jsonValueTypeSchema).min(1),
      observations: z.number().int().min(1),
    }),
  ),
});
export type JsonShape = z.infer<typeof jsonShapeSchema>;

/** Parse approved JSON and immediately discard values after iterative shape inference. */
export const inferJsonShape = (text: string): JsonShape | null => {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (cause: unknown) {
    // Invalid JSON is represented by the null return.
    void cause;
    return null;
  }
  const properties = new Map<
    string,
    {
      readonly path: JsonShapePathSegment[];
      readonly types: Set<JsonValueType>;
      observations: number;
    }
  >();
  const pending: Array<{
    readonly value: unknown;
    readonly path: JsonShapePathSegment[];
    readonly depth: number;
  }> = [{ value: root, path: [], depth: 0 }];
  let nodeCount = 0;
  let maxDepthObserved = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    nodeCount += 1;
    maxDepthObserved = Math.max(maxDepthObserved, current.depth);
    if (current.path.length > 0) {
      const key = JSON.stringify(current.path);
      const type = jsonValueType(current.value);
      const existing = properties.get(key);
      if (existing === undefined)
        properties.set(key, {
          path: current.path,
          types: new Set([type]),
          observations: 1,
        });
      else {
        existing.types.add(type);
        existing.observations += 1;
      }
    }
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1)
        pending.push({
          value: current.value[index],
          path: [...current.path, { kind: "array-element" }],
          depth: current.depth + 1,
        });
      continue;
    }
    if (!isRecord(current.value)) continue;
    const allEntries = Object.entries(current.value);
    for (let index = allEntries.length - 1; index >= 0; index -= 1) {
      const entry = allEntries[index];
      if (entry === undefined) continue;
      const [name, value] = entry;
      const path: JsonShapePathSegment[] = [
        ...current.path,
        { kind: "property", name },
      ];
      pending.push({ value, path, depth: current.depth + 1 });
    }
  }
  return jsonShapeSchema.parse({
    root_type: jsonValueType(root),
    node_count: nodeCount,
    max_depth_observed: maxDepthObserved,
    properties: [...properties.values()]
      .map((value) => ({
        path: value.path,
        types: [...value.types].sort(),
        observations: value.observations,
      }))
      .sort((left, right) => compareShapePaths(left.path, right.path)),
  });
};

const jsonValueType = (value: unknown): JsonValueType => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const compareShapePaths = (
  left: readonly JsonShapePathSegment[],
  right: readonly JsonShapePathSegment[],
): number => {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) break;
    const order =
      compareUnicodeCodePoints(a.kind, b.kind) ||
      (a.kind === "property" && b.kind === "property"
        ? compareUnicodeCodePoints(a.name, b.name)
        : 0);
    if (order !== 0) return order;
  }
  return left.length - right.length;
};
