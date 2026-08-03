import { z } from "zod";

import { jsonValueSchema } from "../domain/jsonValue.js";
import { TOOL_EXAMPLE_OVERRIDES } from "./toolContractExamples.js";
import type { ToolExample } from "./toolContractTypes.js";

export const document = z.string().optional().describe("The document name");
export const address = z
  .string()
  .describe(
    "A provider-normalized address; default memory uses 0x-prefixed hexadecimal",
  );
export const optionalAddress = address.optional();
export const procedure = z.string().describe("The procedure name or address");
export const pagination = {
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(100),
};

const exampleInputSchema = z.record(z.string(), jsonValueSchema);

export const examplesFor = (
  name: string,
  inputSchema: z.ZodObject,
): readonly ToolExample[] => {
  const parsed = inputSchema.parse(TOOL_EXAMPLE_OVERRIDES[name] ?? {});
  return [
    {
      title: `Example ${name.replaceAll("_", " ")} request`,
      input: exampleInputSchema.parse(parsed),
    },
  ];
};
