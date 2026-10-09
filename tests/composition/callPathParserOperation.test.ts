import { expect, it } from "vitest";
import { z } from "zod";

import { traceCallPath } from "../../src/application/CallPathTracing.js";
import { jsonValueSchema } from "../../src/domain/jsonValue.js";
import { ok } from "../../src/domain/result.js";

it("attributes malformed relationship output to the originating provider operation", async () => {
  const result = await traceCallPath(
    async (operation) =>
      ok(
        jsonValueSchema.parse(
          operation === "procedure_address" ? "0x1000" : { callees: [123] },
        ),
      ),
    { start: "entry", direction: "forward" },
  );

  expect(result.ok).toBe(true);
  if (result.ok) {
    const failures = z
      .object({
        failures: z.array(
          z.object({
            error: z.object({
              details: z.object({ operation: z.string() }),
            }),
          }),
        ),
      })
      .parse(result.value).failures;
    expect(failures[0]?.error.details.operation).toBe("procedure_callees");
  }
});
