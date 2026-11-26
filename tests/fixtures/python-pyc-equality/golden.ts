import { readFileSync } from "node:fs";
import { z } from "zod";

/** Recorded independently by produce.py; CI needs no matching Python install. */
export const pythonPycEqualityGolden = z
  .strictObject({
    producer: z.literal("CPython 3.12.14, marshal version 0"),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    pyc_base64: z.string(),
    cases: z.array(
      z.strictObject({
        label: z.string(),
        members: z.union([z.literal(1), z.literal(2)]),
      }),
    ),
    code_objects: z.int().positive(),
  })
  .parse(
    JSON.parse(readFileSync(new URL("./golden.json", import.meta.url), "utf8")),
  );
