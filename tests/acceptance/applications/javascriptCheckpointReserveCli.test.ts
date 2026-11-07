import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.skipIf(process.versions.bun !== undefined).for([
  { laterSources: 1, heapMb: 640, methodsCount: 400, retainGraph: true },
  { laterSources: 10, heapMb: 640, methodsCount: 400, retainGraph: true },
  // The parent cannot retain this whole graph after reserving transient
  // decoding and the next checkpoint, so it offers a byte budget instead.
  { laterSources: 1, heapMb: 448, methodsCount: 1200, retainGraph: false },
])(
  "preserves evidence with $laterSources later checkpoints and a $heapMb MiB parent heap",
  { timeout: 90_000 },
  async ({ laterSources, heapMb, methodsCount, retainGraph }, { cli }) => {
    const root = await createTestTempDirectory("rea-js-checkpoint-reserve-");
    const source = Array.from(
      { length: methodsCount },
      (_, index) =>
        `export function method_${String(index)}(input) { const value = input + ${String(index)}; const pair = { value }; return pair.value; }`,
    ).join("\n");
    const files: readonly (readonly [string, string])[] = [
      ["a-large.mjs", source],
      ...Array.from(
        { length: laterSources },
        (_, index) =>
          [
            `z-tiny-${String(index)}.mjs`,
            `export const tiny${String(index)} = 1;\n`,
          ] as const,
      ),
    ];
    for (const [name, text] of files) await writeFile(join(root, name), text);
    const response = await cli.run({
      arguments: ["analyze", root, "--format", "json"],
      environment: {
        NODE_OPTIONS: `--max-old-space-size=${String(heapMb)} --max-semi-space-size=8`,
      },
      timeoutMs: 60_000,
    });
    expect(response.exitCode).toBe(0);
    const result = javascriptApplicationAnalysisResultSchema.parse(
      parseEvidence(response.json).normalized_result,
    );
    expect(result.statistics.parsed_javascript_files).toBe(laterSources + 1);
    expect(result.statistics.parse_failures).toBe(0);
    const failures = result.graph.nodes.flatMap((node) =>
      node.observations.flatMap(({ properties }) =>
        properties.analysis_failure === undefined
          ? []
          : [
              {
                kind: node.kind,
                identity: node.identity,
                path: properties.path,
                failure: properties.analysis_failure,
              },
            ],
      ),
    );
    const methods = result.semantic_graph.nodes.filter(
      ({ kind, identity }) =>
        kind === "function" && identity.module_path === "a-large.mjs",
    );
    const largeCoverage = result.semantic_graph.coverage.files.find(
      ({ module_path }) => module_path === "a-large.mjs",
    );
    if (retainGraph) {
      expect(methods.map(({ label }) => label).sort()).toEqual(
        Array.from(
          { length: methodsCount },
          (_, index) => `method_${String(index)}`,
        ).sort(),
      );
      expect(largeCoverage?.status).toBe("complete");
    } else {
      // Functions are projected first, so a truncated source keeps them.
      expect(methods.length).toBeGreaterThan(0);
      expect(largeCoverage).toMatchObject({ status: "truncated" });
      if (
        largeCoverage?.graph_byte_budget == null ||
        largeCoverage.retained_graph_bytes === null
      )
        throw new Error("A truncated source reports its exact budget use");
      expect(largeCoverage.retained_graph_bytes).toBeLessThanOrEqual(
        largeCoverage.final_shared_graph_byte_budget ??
          largeCoverage.graph_byte_budget,
      );
      expect(largeCoverage.omitted_nodes).toBeNull();
      expect(result.semantic_graph.coverage).toMatchObject({
        status: "partial",
        truncated: true,
        omitted_nodes: largeCoverage.omitted_nodes,
      });
      expect(result.semantic_graph.coverage.limits).toContainEqual(
        expect.objectContaining({
          name: "javascript_analysis_evidence_budget_bytes",
        }),
      );
    }
    expect(
      result.semantic_graph.nodes.some(
        ({ identity, label }) =>
          identity.module_path === `z-tiny-${String(laterSources - 1)}.mjs` &&
          label === `tiny${String(laterSources - 1)}`,
      ),
    ).toBe(true);
    for (const [name, text] of files) {
      const digest = createHash("sha256").update(text).digest("hex");
      const node = result.graph.nodes.find(
        ({ kind, identity }) =>
          kind === "javascript-asset" &&
          identity.strategy === "content-digest" &&
          identity.sha256 === digest,
      );
      expect(node?.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              path: name,
              parse_status: "complete",
            }),
          }),
        ]),
      );
      expect(failures).toEqual([]);
      expect(await readFile(join(root, name), "utf8")).toBe(text);
    }
    expect(response.stderr).not.toMatch(/FATAL ERROR:.*heap/iu);
  },
);

cliTest.skipIf(process.versions.bun !== undefined)(
  "keeps every source's static facts after semantic results use the parent result budget",
  { timeout: 90_000 },
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-js-static-capacity-");
    // Plain functions produce semantic graphs large enough to use the result
    // budget of this heap. The later sources' storage findings then produce
    // static checkpoints that exceed its reserve for the next checkpoint.
    const vendors = Array.from({ length: 12 }, (_, vendor) => [
      `a-vendor-${String(vendor)}.mjs`,
      Array.from(
        { length: 100 },
        (_, index) =>
          `export function v${String(vendor)}_${String(index)}(input) { const value = input + ${String(index)}; const pair = { value }; return pair.value; }`,
      ).join("\n"),
    ]);
    const callsPerSource = 12_000;
    const sources = Array.from({ length: 5 }, (_, source) => [
      `z-source-${String(source)}.mjs`,
      Array.from(
        { length: callsPerSource },
        (_, index) =>
          `localStorage.getItem("k${String(source)}_${String(index)}");`,
      ).join("\n"),
    ]);
    for (const [name, text] of [...vendors, ...sources])
      await writeFile(join(root, name!), text!);
    const response = await cli.run({
      arguments: ["analyze", root, "--format", "json"],
      environment: {
        NODE_OPTIONS: "--max-old-space-size=640 --max-semi-space-size=8",
      },
      timeoutMs: 75_000,
    });
    expect(response.stderr).not.toMatch(/FATAL ERROR:.*heap/iu);
    expect(
      response.exitCode,
      JSON.stringify(response.json)?.slice(0, 2000),
    ).toBe(0);
    const result = javascriptApplicationAnalysisResultSchema.parse(
      parseEvidence(response.json).normalized_result,
    );
    expect(result.statistics).toMatchObject({
      parsed_javascript_files: vendors.length + sources.length,
      skipped_javascript_files: 0,
      parse_failures: 0,
    });
    // The omission is reported where a reader finds the retained facts.
    for (const [name, text] of sources) {
      const digest = createHash("sha256").update(text!).digest("hex");
      const node = result.graph.nodes.find(
        ({ kind, identity }) =>
          kind === "javascript-asset" &&
          identity.strategy === "content-digest" &&
          identity.sha256 === digest,
      );
      const observation = node?.observations.find(
        ({ properties }) =>
          properties.application_projection_failure !== undefined,
      );
      expect(observation?.label, name).toBe(name);
      expect(
        z
          .object({ storage: z.array(z.unknown()) })
          .parse(observation?.properties.static_analysis).storage,
      ).toHaveLength(callsPerSource);
    }
    expect(result.graph.coverage.status).toBe("partial");
  },
);
