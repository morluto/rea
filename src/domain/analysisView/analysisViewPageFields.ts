import { z } from "zod";

/** Request fields for views that default to the first 64 rows. */
export const analysisViewPageFields = <Kind extends string>(kind: Kind) =>
  ({
    kind: z.literal(kind),
    offset: z.int().nonnegative().default(0),
    limit: z.int().positive().default(64),
  }) as const;
