import { z } from "zod";

import { jsonValueSchema } from "../domain/jsonValue.js";
import { TOOL_EXAMPLE_OVERRIDES } from "./toolContractExamples.js";
import type { ToolExample } from "./toolContractTypes.js";

export const document = z
  .string()
  .optional()
  .describe(
    "The active target's provider document name; use open_binary to switch targets",
  );
// A selector names one object, so an empty address or procedure is refused
// at admission rather than reaching a provider.
export const address = z
  .string()
  .min(1)
  .describe(
    "A provider-normalized address; default memory uses 0x-prefixed hexadecimal",
  );
export const optionalAddress = address.optional();
export const procedure = z
  .string()
  .min(1)
  .describe("The procedure name or address");
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
