import { z } from "zod";

import type { ToolContract } from "../contracts/toolContracts.js";

/** Project the public contract fields accepted by MCP tool registration. */
export const toolRegistrationOptions = (contract: ToolContract) => ({
  title: contract.title,
  description: contract.description,
  inputSchema: advertisedInputSchema(contract.inputSchema),
  outputSchema: advertisedOutputSchema(contract.outputSchema),
  annotations: contract.annotations,
});

/**
 * Advertise the exact Zod contract while leaving validation to REA's adapter.
 * The SDK otherwise converts validation failures to text-only JSON-RPC errors
 * before REA can return its stable structured error envelope.
 */
const advertisedInputSchema = (schema: z.ZodObject) => ({
  "~standard": {
    version: 1 as const,
    vendor: "rea",
    validate: (input: unknown) => ({ value: input }),
    jsonSchema: {
      input: () =>
        describeProperties(closeObjectSchemas(inputJsonSchema(schema))),
      output: () =>
        describeProperties(closeObjectSchemas(inputJsonSchema(schema))),
    },
  },
});

const advertisedOutputSchema = (schema: z.ZodObject) => {
  const standard = schema["~standard"];
  const converter = standard.jsonSchema?.output;
  if (converter === undefined)
    throw new TypeError(
      "Tool output schema does not expose Standard JSON Schema",
    );
  return {
    "~standard": {
      ...standard,
      jsonSchema: {
        input: () => closeObjectSchemas(converter({ target: "draft-2020-12" })),
        output: () =>
          closeObjectSchemas(converter({ target: "draft-2020-12" })),
      },
    },
  };
};

const inputJsonSchema = (schema: z.ZodObject): Record<string, unknown> => {
  const converter = schema["~standard"].jsonSchema?.input;
  if (converter === undefined)
    throw new TypeError(
      "Tool input schema does not expose Standard JSON Schema",
    );
  return converter({ target: "draft-2020-12" });
};

/** Close fixed-shape JSON Schema objects while preserving explicit maps. */
export const closeObjectSchemas = (
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const closed = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, closeSchemaValue(child)]),
  );
  return value.type === "object" &&
    isObject(value.properties) &&
    value.additionalProperties === undefined
    ? { ...closed, additionalProperties: false }
    : closed;
};

const closeSchemaValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(closeSchemaValue);
  if (!isObject(value)) return value;
  return closeObjectSchemas(value);
};

const describeProperties = (
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key !== "properties" || typeof child !== "object" || child === null)
        return [key, describeValue(child)];
      return [
        key,
        Object.fromEntries(
          Object.entries(child).map(([property, schema]) => [
            property,
            isObject(schema) && typeof schema.description !== "string"
              ? {
                  ...describeProperties(schema),
                  description: property.replaceAll("_", " "),
                }
              : describeValue(schema),
          ]),
        ),
      ];
    }),
  );

const describeValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(describeValue);
  return isObject(value) ? describeProperties(value) : value;
};

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
