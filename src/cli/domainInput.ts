import { z } from "incur";

/**
 * CLI argv keeps the domain field's inbound text. A service transform still
 * runs when that service parses the same field, and `--schema` matches the
 * input view advertised by tools/list.
 */
export const cliDomainInput = (field: z.ZodType): z.ZodType =>
  field instanceof z.ZodPipe ? (field.def.in as z.ZodType) : field;
