import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { reconstructJavaScriptArtifact } from "../../../src/application/javascript/JavaScriptArtifactReconstruction.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each(["\n", "\r\n", "\r", "\u2028", "\u2029"])(
  "preserves source-map graph evidence coordinates after %j",
  async (separator) => {
    const root = await createTestTempDirectory("rea-source-map-locations-");
    const directive = "//# sourceMappingURL=app.js.map";
    const source = `const marker = "😀";${separator}  ${directive}`;
    await writeFile(join(root, "app.js"), source);
    const result = await reconstructJavaScriptArtifact({ input_path: root });
    expect(result.statistics.parse_failures).toBe(0);
    const edges = result.graph.edges.filter(
      ({ relation, properties }) =>
        relation === "maps_to" && properties.declared_url === "app.js.map",
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]?.evidence).toMatchObject({
      state: "inferred",
      artifact: {
        sha256: createHash("sha256").update(source).digest("hex"),
      },
      location: {
        available: true,
        value: {
          kind: "source-range",
          source: "app.js",
          start: { line: 2, column: 2 },
          end: { line: 2, column: directive.length + 2 },
        },
      },
    });
    expect(edges[0]?.properties).toMatchObject({
      declared_url: "app.js.map",
      resolved_path: null,
    });
  },
);
