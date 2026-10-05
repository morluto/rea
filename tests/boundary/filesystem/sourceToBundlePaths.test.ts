import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { analyzeJavaScriptApplication } from "../../../src/application/JavaScriptApplicationService.js";
import { parseApplicationGraphEvidence } from "../../../src/application/JavaScriptApplicationEvidenceGraph.js";
import { importReferenceSource } from "../../../src/application/ReferenceSourceImport.js";
import { compareSourceToBundle } from "../../../src/domain/sourceToBundleComparison.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("keeps literal hash characters in historical/current filesystem paths", async () => {
  const root = await createTestTempDirectory("rea-source-path-");
  const previous = join(root, "previous");
  const current = join(root, "current");
  await Promise.all([mkdir(previous), mkdir(current)]);
  await Promise.all([
    writeFile(join(previous, "worker#main.js"), "export const value = 1;"),
    writeFile(join(current, "worker#main.js"), "export const value = 2;"),
  ]);
  const reference = await importReferenceSource({
    root: previous,
    caller: "source-to-bundle-path-test",
    policy: { secretPatterns: [] },
  });
  if (!reference.ok) throw new Error(reference.error.message);
  const analyzed = await analyzeJavaScriptApplication({ input_path: current });
  if (!analyzed.ok) throw analyzed.error;
  const application = parseApplicationGraphEvidence(analyzed.value);
  const comparison = compareSourceToBundle({
    reference: reference.value,
    application: {
      evidenceId: application.evidence.evidence_id,
      rootArtifactSha256: application.rootArtifactSha256,
      graph: application.graph,
    },
  });

  expect(reference.value.entries).toContainEqual(
    expect.objectContaining({
      kind: "file",
      path: "worker#main.js",
      content_state: "hashed",
    }),
  );
  expect(comparison.items).toContainEqual(
    expect.objectContaining({
      source_path: "worker#main.js",
      candidates: expect.arrayContaining([
        expect.objectContaining({
          signals: expect.arrayContaining([
            expect.objectContaining({
              kind: "current-path-exact",
              source_value: "worker#main.js",
            }),
          ]),
        }),
      ]),
    }),
  );
});
