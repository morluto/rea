import { expect, it } from "vitest";

import { javaScriptSemanticQueryInputSchema } from "./javascriptSemanticQuerySchemas.js";

it("rejects a source-map authority setting that the query does not consume", () => {
  expect(
    javaScriptSemanticQueryInputSchema.safeParse({
      seed: { kind: "endpoint", value: "/api" },
      direction: "forward-influence",
      source_map_authority: { authority: "none" },
    }).success,
  ).toBe(false);
});
