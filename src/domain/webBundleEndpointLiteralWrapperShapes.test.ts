import { describe, expect, it } from "vitest";

import { createWebPageInspection } from "../../tests/support/browser/webPageInspection.js";
import { analyzeWebBundleFixture } from "../../tests/support/browser/analyzeWebBundleFixture.js";

const origin = "https://app.example.test";
const inspection = (source: string) =>
  createWebPageInspection([
    {
      source,
      scriptKey: `scr_${"1".repeat(64)}`,
      url: `${origin}/assets/app.js`,
      origin,
      cdpHash: "hash",
    },
  ]);

/**
 * Shapes reported from a production application (issue #3539): every observed
 * call argument was a no-substitution template literal, and several wrappers
 * name the method in upper case (`client.GET`, `client.POST`, openapi-fetch
 * style). Both must stay candidates, and a proven `fetch` stays an observation.
 */
describe("web bundle literal candidates from wrapper shapes", () => {
  it("keeps upper-case method wrappers and template literal arguments", () => {
    const result = analyzeWebBundleFixture(
      inspection(
        [
          "client.GET('/rest/users');",
          "client.POST('/rest/orders');",
          "Fe.SSE(`/rest/sse/stream`, body, options);",
          "fetch('/rest/feedback');",
        ].join("\n"),
      ),
    );

    expect(
      result.inferences
        .filter(({ kind }) => kind === "endpoint_candidate")
        .map(({ value }) => value)
        .sort(),
    ).toEqual(["/rest/orders", "/rest/sse/stream", "/rest/users"]);
    expect(result.observations.endpoints.map(({ value }) => value)).toEqual([
      "/rest/feedback",
    ]);
  });
});
