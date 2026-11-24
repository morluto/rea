import { z } from "zod";

/** Caller-selected name prefixes; counts come from page coverage, not a separate facet. */
export const namePrefixesSchema = (rows: string) =>
  z
    .array(z.string().min(1))
    .optional()
    .describe(
      `Name prefixes for ${rows}; a row matches when its name starts with any listed prefix, case-sensitively. With names, both must match. Omitted includes all names; [] matches none. coverage.total counts every match, so limit 1 returns the count.`,
    );

/** Whether a known name starts with any selected prefix. */
export const startsWithAny = (
  name: string,
  prefixes: readonly string[],
): boolean => prefixes.some((prefix) => name.startsWith(prefix));
