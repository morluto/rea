import { describe, expect, it } from "vitest";

import { childConditions } from "./selectorCandidates.js";

describe("childConditions", () => {
  it("stops reading a child's text once it is past what a selector names a member by, however long the text", () => {
    const element = (text: string) => ({
      name: "record",
      attributes: {},
      children: [
        { name: "title", attributes: {}, children: ["Budget"] },
        { name: "body", attributes: {}, children: [text] },
      ],
    });
    const huge = element(`a b ${"x".repeat(4 * 1024 * 1024)}`);

    const started = performance.now();
    const conditions = childConditions(huge);
    const elapsed = performance.now() - started;

    expect(conditions).toEqual(["[>title=Budget]"]);
    // Building the whole collapsed text took about half a second.
    expect(elapsed).toBeLessThan(100);
  });
});
