import { z } from "incur";

/** Describe decoded JSON without changing the inline/file/stdin string transport. */
export const jsonInputArgument = (command: string, payload: z.ZodType) =>
  z.string().meta({
    contentMediaType: "application/json",
    contentSchema: {
      ...z.toJSONSchema(payload, { io: "input", unrepresentable: "any" }),
      // Recursive payload references belong to this resource, not the outer
      // positional-arguments schema produced by Incur.
      $id: `urn:rea:cli:${command}:input`,
    },
  });
