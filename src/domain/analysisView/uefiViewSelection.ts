import { z } from "zod";

export const exactNames = <Schema extends z.ZodType>(
  schema: Schema,
  what: string,
) =>
  z
    .array(schema)
    .min(1)
    .optional()
    .describe(`Exact ${what}; any listed value matches`);

export const pageLimit = (defaultRows: number) =>
  z.int().positive().max(256).default(defaultRows);

export const indexedRow = <Row extends object>(
  row: Row,
  source_index: number,
) => ({
  ...row,
  source_index,
});
