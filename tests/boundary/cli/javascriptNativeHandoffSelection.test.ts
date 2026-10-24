import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { applicationFeatureTraceResultSchema } from "../../../src/domain/javascript/javascriptFeatureTraceSchemas.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "keeps native exports, digest links and selection separate across two add-ons and all trace directions",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-native-selection-");
    const app = join(root, "app");
    await mkdir(app);
    await writeFile(
      join(app, "main.js"),
      [
        'const { openProject, closeProject } = require("./addon-a.node");',
        'const { openProject: again } = require("./addon-a.node");',
        "openProject(); again(); closeProject();",
        'const { saveProject } = require("./addon-b.node"); saveProject();',
      ].join("\n"),
    );
    const bytesA = Buffer.from("inert addon A");
    const bytesB = Buffer.from("inert addon B");
    const pathA = join(app, "addon-a.node");
    const pathB = join(app, "addon-b.node");
    await writeFile(pathA, bytesA);
    await writeFile(pathB, bytesB);
    const digest = (bytes: Buffer) =>
      createHash("sha256").update(bytes).digest("hex");
    const analysis = await cli.run({
      arguments: [
        "analyze-javascript-application",
        app,
        "--artifact-format",
        "directory",
        "--json",
      ],
    });
    expect(analysis.exitCode, analysis.stderr + analysis.stdout).toBe(0);
    const parent = toolContract(
      "analyze_javascript_application",
    ).outputSchema.parse(analysis.json);
    const { graph } = javascriptApplicationAnalysisResultSchema.parse(
      parent.normalized_result,
    );
    const addonA = graph.nodes.find(
      (node) =>
        node.kind === "native-addon" &&
        node.identity.strategy === "content-digest" &&
        node.identity.sha256 === digest(bytesA),
    );
    const addonB = graph.nodes.find(
      (node) =>
        node.kind === "native-addon" &&
        node.identity.strategy === "content-digest" &&
        node.identity.sha256 === digest(bytesB),
    );
    if (addonA === undefined || addonB === undefined)
      throw new Error("Expected two distinct add-ons");
    const observation = (path: string, sha256: string) =>
      createEvidence(
        { path, sha256, format: "raw-binary" },
        { id: "ghidra", name: "Ghidra", version: "simulated" },
        {
          operation: "binary_overview",
          parameters: {},
          result: { fixture: true },
          limitations: ["No native provider executed."],
        },
      );
    const evidenceA = observation(pathA, digest(bytesA));
    const evidenceB = observation(pathB, digest(bytesB));
    const unrelated = observation("unrelated.node", "9".repeat(64));
    for (const direction of ["outgoing", "incoming", "both"] as const) {
      const request = join(root, `${direction}.json`);
      await writeFile(
        request,
        JSON.stringify({
          application: parent,
          seed: {
            kind: "node-id",
            value: addonA.node_id,
            match: "exact",
            case_sensitive: true,
          },
          direction,
          native_observations: [evidenceB, unrelated, evidenceA],
        }),
      );
      const invoke = () =>
        cli.run({
          arguments: ["trace-application-feature", request, "--json"],
        });
      const first = await invoke();
      const repeated = await invoke();
      expect(first.exitCode, first.stderr).toBe(0);
      expect(repeated.exitCode, repeated.stderr).toBe(0);
      const envelope = toolContract(
        "trace_application_feature",
      ).outputSchema.parse(first.json);
      const repeatedEnvelope = toolContract(
        "trace_application_feature",
      ).outputSchema.parse(repeated.json);
      expect(repeatedEnvelope.evidence_id).toBe(envelope.evidence_id);
      const trace = applicationFeatureTraceResultSchema.parse(
        envelope.normalized_result,
      );
      expect(repeatedEnvelope.normalized_result).toEqual(
        envelope.normalized_result,
      );
      const selectedA = trace.native_handoffs.find(
        ({ native_node_id }) => native_node_id === addonA.node_id,
      );
      expect(selectedA).toMatchObject({
        artifact_sha256: digest(bytesA),
        status: "evidence-linked",
        requested_exports: ["closeProject", "openProject"],
        evidence_ids: [evidenceA.evidence_id],
      });
      expect(selectedA?.export_node_ids.length).toBeGreaterThan(0);
      expect(new Set(selectedA?.export_node_ids).size).toBe(
        selectedA?.export_node_ids.length,
      );
      const reached = trace.graph?.nodes
        .filter(({ kind }) => kind === "native-addon")
        .map(({ node_id }) => node_id)
        .sort();
      expect(
        trace.native_handoffs
          .map(({ native_node_id }) => native_node_id)
          .sort(),
      ).toEqual(reached);
      if (direction === "both") {
        expect(
          trace.native_handoffs.find(
            ({ native_node_id }) => native_node_id === addonB.node_id,
          ),
        ).toMatchObject({
          requested_exports: ["saveProject"],
          evidence_ids: [evidenceB.evidence_id],
        });
      } else {
        expect(
          trace.native_handoffs.some(
            ({ native_node_id }) => native_node_id === addonB.node_id,
          ),
        ).toBe(false);
      }
      expect(trace.evidence_links).not.toContain(unrelated.evidence_id);
    }
    expect(await readFile(pathA)).toEqual(bytesA);
    expect(await readFile(pathB)).toEqual(bytesB);
  },
);
