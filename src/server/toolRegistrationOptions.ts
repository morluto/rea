import type { ToolContract } from "../contracts/toolContracts.js";
import { toolInputSchemaWithMetadata } from "../contracts/toolSchemaMetadata.js";

/** Project the canonical Zod contracts directly into SDK registration. */
export const toolRegistrationOptions = <Contract extends ToolContract>(
  contract: Contract,
): {
  readonly title: Contract["title"];
  readonly description: Contract["description"];
  readonly inputSchema: Contract["inputSchema"];
  readonly outputSchema: Contract["outputSchema"];
  readonly annotations: Contract["annotations"];
} => ({
  title: contract.title,
  description: contract.description,
  inputSchema: withNonRecursiveWireSchema(
    toolInputSchemaWithMetadata(contract),
  ),
  outputSchema: withNonRecursiveWireSchema(contract.outputSchema),
  annotations: contract.annotations,
});

type WireJsonSchemaConverters = Record<
  string,
  ((options: never) => unknown) | unknown
>;

/**
 * Wrap the Standard Schema JSON projection so strict MCP clients (opencode:
 * "Recursive JSON schemas are not currently supported") receive cycle-free
 * schemas. Runtime Zod parsing is untouched; only the advertised wire shape
 * is relaxed at cyclic `$ref`s (e.g. `z.json()`'s self-referential
 * `$defs/__schema0`), which become free-form `{}`.
 */
const withNonRecursiveWireSchema = <Schema>(schema: Schema): Schema => {
  const holder = schema as unknown as {
    readonly "~standard"?: {
      readonly jsonSchema?: WireJsonSchemaConverters | undefined;
    };
  };
  const jsonSchema = holder["~standard"]?.jsonSchema;
  if (jsonSchema === undefined) return schema;
  const wrapped: Record<string, (options: never) => unknown> = {};
  for (const key of ["input", "output"] as const) {
    const converter = jsonSchema[key];
    if (typeof converter !== "function") continue;
    const original = converter as (options: never) => unknown;
    wrapped[key] = (options: never) => withoutRecursiveRefs(original(options));
  }
  if (Object.keys(wrapped).length === 0) return schema;
  Object.defineProperty(schema, "~standard", {
    value: {
      ...(holder["~standard"] as Record<string, unknown>),
      jsonSchema: { ...jsonSchema, ...wrapped },
    },
  });
  return schema;
};

const withoutRecursiveRefs = (
  node: unknown,
  stack: readonly string[] = [],
): unknown => {
  if (Array.isArray(node))
    return node.map((entry) => withoutRecursiveRefs(entry, stack));
  if (typeof node !== "object" || node === null) return node;
  const record = node as Readonly<Record<string, unknown>>;
  if (typeof record.$ref === "string") {
    const target = /^#\/\$defs\/([^/]+)$/.exec(record.$ref)?.[1];
    if (target !== undefined && stack.includes(target)) return {};
    return node;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) =>
      key === "$defs" && isRecord(child)
        ? [
            key,
            Object.fromEntries(
              Object.entries(child).map(([defName, defSchema]) => [
                defName,
                withoutRecursiveRefs(defSchema, [...stack, defName]),
              ]),
            ),
          ]
        : [key, withoutRecursiveRefs(child, stack)],
    ),
  );
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
