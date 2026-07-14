import { z } from "zod";

const jsonValueTypeSchema = z.enum([
  "object",
  "array",
  "string",
  "number",
  "boolean",
  "null",
]);
type JsonValueType = z.infer<typeof jsonValueTypeSchema>;

/** Value-free structural summary of one approved JSON payload. */
export const jsonShapeSchema = z.object({
  root_type: jsonValueTypeSchema,
  node_count: z.number().int().min(1),
  max_depth_observed: z.number().int().min(0),
  properties: z.array(
    z.object({
      path: z.string(),
      types: z.array(jsonValueTypeSchema).min(1),
      observations: z.number().int().min(1),
    }),
  ),
  truncated: z.boolean(),
});
export type JsonShape = z.infer<typeof jsonShapeSchema>;

export interface JsonShapeLimits {
  readonly maximumBytes: number;
  readonly maximumNodes: number;
  readonly maximumDepth: number;
}

/** Parse approved JSON and immediately discard values after iterative shape inference. */
export const inferJsonShape = (
  text: string,
  limits: JsonShapeLimits,
): JsonShape | null => {
  if (Buffer.byteLength(text) > limits.maximumBytes) return null;
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  const properties = new Map<
    string,
    { readonly types: Set<JsonValueType>; observations: number }
  >();
  const pending: Array<{
    readonly value: unknown;
    readonly path: string;
    readonly depth: number;
  }> = [{ value: root, path: "", depth: 0 }];
  let nodeCount = 0;
  let maxDepthObserved = 0;
  let truncated = false;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (nodeCount >= limits.maximumNodes) {
      truncated = true;
      break;
    }
    nodeCount += 1;
    maxDepthObserved = Math.max(maxDepthObserved, current.depth);
    if (current.depth >= limits.maximumDepth) {
      if (hasChildren(current.value)) truncated = true;
      continue;
    }
    if (Array.isArray(current.value)) {
      const capacity = Math.max(
        0,
        limits.maximumNodes - nodeCount - pending.length,
      );
      const retained = Math.min(current.value.length, capacity);
      if (retained < current.value.length) truncated = true;
      for (let index = retained - 1; index >= 0; index -= 1)
        pending.push({
          value: current.value[index],
          path: `${current.path}/*`,
          depth: current.depth + 1,
        });
      continue;
    }
    if (!isRecord(current.value)) continue;
    const allEntries = Object.entries(current.value);
    const capacity = Math.max(
      0,
      limits.maximumNodes - nodeCount - pending.length,
    );
    const entries = allEntries.slice(0, capacity);
    if (entries.length < allEntries.length) truncated = true;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry === undefined) continue;
      const [name, value] = entry;
      const path = `${current.path}/${pointerName(name)}`.slice(0, 2_048);
      const type = jsonValueType(value);
      const existing = properties.get(path);
      if (existing === undefined)
        properties.set(path, { types: new Set([type]), observations: 1 });
      else {
        existing.types.add(type);
        existing.observations += 1;
      }
      pending.push({ value, path, depth: current.depth + 1 });
    }
  }
  return jsonShapeSchema.parse({
    root_type: jsonValueType(root),
    node_count: nodeCount,
    max_depth_observed: maxDepthObserved,
    properties: [...properties.entries()]
      .map(([path, value]) => ({
        path,
        types: [...value.types].sort(),
        observations: value.observations,
      }))
      .sort((left, right) => left.path.localeCompare(right.path))
      .slice(0, limits.maximumNodes),
    truncated,
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

const hasChildren = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.length > 0
    : isRecord(value) && Object.keys(value).length > 0;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pointerName = (value: string): string =>
  value.slice(0, 256).replaceAll("~", "~0").replaceAll("/", "~1");
