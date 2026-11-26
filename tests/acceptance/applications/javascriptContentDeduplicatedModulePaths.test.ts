import { inspectEvidenceView } from "../../support/cli/inspectEvidenceView.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "selects each retained path of a content-deduplicated module",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-js-module-alias-view-");
    const source = "export const answer = 42;\n";
    await Promise.all(
      ["a.js", "b.js"].map((path) => writeFile(join(root, path), source)),
    );
    const analyzed = await cli.run({
      arguments: ["analyze-javascript-application", root, "--format", "json"],
    });
    expect(analyzed.exitCode, analyzed.stdout + analyzed.stderr).toBe(0);
    const evidence = parseEvidence(analyzed.json);
    const evidencePath = join(root, "evidence.json");
    await writeFile(evidencePath, JSON.stringify(evidence));
    const queryPath = join(root, "query.json");

    const inspect = inspectEvidenceView(cli, evidencePath, queryPath);

    let sharedNodeId: string | undefined;
    for (const path of ["a.js", "b.js"]) {
      const references = await inspect({
        kind: "javascript",
        collection: "modules",
        projection: "references",
        where: { kind: "javascript-asset", path },
      });
      expect(references).toMatchObject({
        kind: "javascript",
        rows: [{ path }],
        coverage: { total: 1, examined: 1, exhausted: true },
      });
      if (references.kind !== "javascript")
        throw new Error("expected JavaScript module references");
      const nodeId = references.rows[0]?.node_id;
      expect(nodeId).toBeDefined();
      if (sharedNodeId === undefined) sharedNodeId = nodeId;
      else expect(nodeId).toBe(sharedNodeId);
    }
    const item = await inspect({
      kind: "item",
      collection: "modules",
      selector: { node_id: sharedNodeId },
    });
    expect(item).toMatchObject({
      kind: "item",
      item: {
        node_id: sharedNodeId,
        // Observations are ordered by identity, not by their path spelling.
        path: expect.stringMatching(/^[ab]\.js$/u),
        observations: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({ path: "a.js" }),
          }),
          expect.objectContaining({
            properties: expect.objectContaining({ path: "b.js" }),
          }),
        ]),
      },
    });
  },
);
