import { createHash } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import {
  createJavaScriptSemanticGraphProjection,
  projectJavaScriptSemanticFileSteps,
} from "../../../src/application/javascript/JavaScriptSemanticGraphBuilder.js";
import { analyzeJavaScriptSemantics } from "../../../src/domain/javascript/javascriptSemanticAnalysis.js";
import type { JavaScriptArtifactFile } from "../../../src/domain/javascript/javascriptArtifactFiles.js";
import { resolveJavaScriptSemanticEvidence } from "../../support/javascriptSemanticGraphFixture.js";

// This forked project uses the CLI parent's main-thread stack. The inventory
// exceeds its call-argument capacity and fits the selected graph ceilings.
const count = 130_000;
let fixture: {
  readonly file: JavaScriptArtifactFile;
  readonly ir: ReturnType<typeof analyzeJavaScriptSemantics>;
  readonly sha256: string;
};
// Source preparation retains the original case budget in its new setup stage.
beforeAll(() => {
  const source = "(()=>{});\n".repeat(count);
  const sha256 = createHash("sha256").update(source).digest("hex");
  const file: JavaScriptArtifactFile = {
    path: "entry.mjs",
    container_sha256: sha256,
    sha256,
    bytes: Buffer.byteLength(source),
    inventory_artifact_id: `art_${sha256}`,
    kind: "javascript",
    unpacked: false,
    text: { included: true, value: source },
  };
  const ir = analyzeJavaScriptSemantics(source);
  expect(ir.callables).toHaveLength(count);
  expect(ir.functionFingerprints).toHaveLength(count);
  // Both paths consume the same read-only producer facts. Each test below
  // still creates and verifies its own independently projected graph.
  fixture = { file, ir, sha256 };
}, 30_000);

it.each(["direct", "transferred"] as const)(
  "retains an admitted source's wide fingerprint list through %s projection",
  (mode) => {
    const { file, ir, sha256 } = fixture;
    const projection = createJavaScriptSemanticGraphProjection({
      totalNodes: count + 1,
      fileNodes: count + 1,
    });
    if (mode === "direct") projection.projectFile(file, ir);
    else {
      const steps = projectJavaScriptSemanticFileSteps(
        file,
        ir,
        projection.remainingFileCapacity(),
      );
      let step = steps.next();
      while (!step.done) step = steps.next();
      projection.adoptFileProjection(step.value);
    }
    const graph = projection.finish(sha256, {
      graph_id: `jag_${sha256}`,
      nodes: [],
    });
    const functions = graph.nodes.filter(({ kind }) => kind === "function");
    expect(functions).toHaveLength(count);
    expect(graph.fingerprints).toHaveLength(count);
    // The graph sorts nodes and fingerprints by their independent digests.
    const functionIds = new Set(functions.map(({ node_id }) => node_id));
    expect(
      graph.fingerprints.every(({ function_node_id }) =>
        functionIds.has(function_node_id),
      ),
    ).toBe(true);
    expect(
      new Set(
        graph.fingerprints.map(({ function_node_id }) => function_node_id),
      ).size,
    ).toBe(count);
    expect(
      new Set(graph.fingerprints.map(({ fingerprint_id }) => fingerprint_id))
        .size,
    ).toBe(count);
    expect(graph.coverage.truncated).toBe(false);
    for (const line of [1, count]) {
      const callable = functions.find(
        ({ identity }) => identity.source_range?.start.line === line,
      );
      const fingerprint = graph.fingerprints.find(
        ({ function_node_id }) => function_node_id === callable?.node_id,
      );
      if (fingerprint === undefined) throw new Error("Missing fingerprint");
      expect(
        resolveJavaScriptSemanticEvidence(graph, fingerprint.evidence),
      ).toMatchObject({
        state: "observed",
        authority: "ast-static-analysis",
        artifact: { available: true, sha256 },
        location: {
          available: true,
          value: {
            kind: "source-range",
            source: "entry.mjs",
            start: { line },
          },
        },
      });
    }
  },
  30_000,
);
