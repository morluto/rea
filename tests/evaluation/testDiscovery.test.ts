import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { compareTestDiscovery } from "../../scripts/lib/test-discovery.mjs";

const root = resolve("test-discovery-fixture");
const domainTest = "src/domain/sample.test.ts";

describe("test discovery migration guard", () => {
  it("keeps missing, unexpected, overlapping and wrong-project results distinct", () => {
    const missing = "src/new-provider/sample.test.ts";
    const extra = "tests/untracked.test.ts";
    const duplicate = "src/domain/overlap.test.ts";
    const misplaced = "src/domain/misplaced.test.ts";

    expect(
      compareTestDiscovery(
        [domainTest, missing, duplicate, misplaced],
        [
          { file: resolve(root, domainTest), projectName: "domain" },
          { file: misplaced, projectName: "cli-boundary" },
          { file: duplicate, projectName: "domain" },
          { file: duplicate, projectName: "adapters" },
          { file: extra, projectName: "adapters" },
        ],
        root,
      ),
    ).toEqual({
      missing: [missing],
      unexpected: [extra],
      duplicates: [{ file: duplicate, projects: ["adapters", "domain"] }],
      wrongProjects: [
        { file: misplaced, expected: "domain", actual: "cli-boundary" },
      ],
      discovered: 4,
    });
  });

  it.each([
    null,
    {},
    [{ file: "", projectName: "domain" }],
    [{ file: domainTest }],
    [{ file: domainTest, projectName: null }],
  ])("rejects malformed producer output: %j", (input) => {
    expect(() => compareTestDiscovery([domainTest], input, root)).toThrow(
      TypeError,
    );
  });
});
