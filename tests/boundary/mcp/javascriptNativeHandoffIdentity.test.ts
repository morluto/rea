import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisView.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import type { JavaScriptApplicationAnalysisResult } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import {
  applicationFeatureTraceResultSchema,
  type ApplicationFeatureTraceResult,
} from "../../../src/domain/javascript/javascriptFeatureTraceSchemas.js";
import { createStrippedAsarAddon } from "../../fixtures/strippedAsarAddon.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const client = new Client({ name: "native-handoff-identity", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("scripts/rea.mjs"), "mcp"],
  cwd: process.cwd(),
  env: { PATH: process.env.PATH ?? "" },
  stderr: "pipe",
});
beforeAll(async () => {
  await client.connect(transport);
  transport.stderr?.on("data", () => undefined);
});
afterAll(async () => {
  await Promise.all([client.close(), transport.close()]);
});

const sha256 = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const nativeObservation = (path: string, sha256: string) =>
  createEvidence(
    { path, sha256, format: "raw-binary" },
    { id: "ghidra", name: "Ghidra", version: "simulated" },
    {
      operation: "binary_overview",
      parameters: {},
      result: {
        summary: "Simulated native Evidence for subject identity only.",
      },
      limitations: ["No native provider executed."],
    },
  );

interface ExpectedIdentity {
  readonly available: boolean;
  readonly addon: string;
  readonly archiveDigest: string;
  readonly nativeDigest: string;
  readonly parentId: string;
  readonly nativeId: string;
  readonly linked: boolean;
}

const expectHandoffIdentity = (
  trace: ApplicationFeatureTraceResult,
  expected: ExpectedIdentity,
) => {
  const node = trace.graph?.nodes.find(({ kind }) => kind === "native-addon");
  expect(node).toBeDefined();
  expect(trace.evidence_links).toEqual(
    [
      expected.parentId,
      ...(expected.available && expected.linked ? [expected.nativeId] : []),
    ].sort(),
  );
  if (expected.available) {
    expect(node?.identity).toMatchObject({
      strategy: "content-digest",
      sha256: expected.nativeDigest,
    });
    expect(trace.native_handoffs).toHaveLength(1);
    expect(trace.native_handoffs[0]).toMatchObject({
      native_node_id: node?.node_id,
      artifact_sha256: expected.nativeDigest,
      artifact_path: expected.addon,
      status: expected.linked
        ? "evidence-linked"
        : "requires-provider-analysis",
      evidence_ids: expected.linked ? [expected.nativeId] : [],
    });
  } else {
    expect(node?.identity).toMatchObject({
      strategy: "canonical-path",
      artifact_sha256: expected.archiveDigest,
      path: expected.addon,
    });
    expect(node?.observations).toContainEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          availability: "unavailable",
          hash_status: "unavailable",
          inventory_artifact_id: null,
        }),
      }),
    );
    expect(trace.coverage.status).toBe("partial");
    expect(trace.graph?.coverage.status).toBe("partial");
    expect(trace.native_handoffs).toEqual([]);
    expect(trace.summary.native_handoffs).toBe(0);
  }
};

for (const available of [false, true]) {
  cliTest(
    `keeps native handoff byte identity ${available ? "exact when available" : "unknown for a missing ASAR companion"}`,
    async ({ cli }) => {
      const { root, archive, addon, original } =
        await createStrippedAsarAddon();
      const companion = join(`${archive}.unpacked`, addon);
      if (available) await writeFile(companion, original);
      else await rm(companion);
      const archiveDigest = sha256(await readFile(archive));
      const nativeDigest = sha256(original);
      const containerEvidence = nativeObservation(archive, archiveDigest);
      const nativeEvidence = nativeObservation(companion, nativeDigest);
      const analysis = await cli.run({
        arguments: ["analyze-javascript-application", archive, "--json"],
      });
      expect(analysis.exitCode, analysis.stderr).toBe(0);
      const parent = toolContract(
        "analyze_javascript_application",
      ).outputSchema.parse(analysis.json);
      const summary = await client.callTool({
        name: "analyze_javascript_application",
        arguments: { input_path: archive, detail: "summary" },
      });
      expect(summary.isError).not.toBe(true);
      const summaryEvidence = toolContract(
        "analyze_javascript_application",
      ).outputSchema.parse(summary.structuredContent);
      expect(
        analysisViewResultSchema.parse(summaryEvidence.normalized_result)
          .parent_evidence_id,
      ).toBe(parent.evidence_id);
      const observed: {
        trace: ApplicationFeatureTraceResult;
        linked: boolean;
      }[] = [];
      for (const native_observations of [
        [containerEvidence, nativeEvidence],
        [],
      ]) {
        const query = {
          seed: {
            kind: "string",
            value: addon,
            match: "exact",
            case_sensitive: true,
          },
          direction: "outgoing",
          native_observations,
        };
        const request = join(
          root,
          `trace-${String(native_observations.length)}.json`,
        );
        await writeFile(
          request,
          JSON.stringify({
            ...query,
            application: parent,
          }),
        );
        const cliTrace = await cli.run({
          arguments: ["trace-application-feature", request, "--json"],
        });
        expect(
          cliTrace.exitCode,
          cliTrace.exitCode === 0
            ? undefined
            : JSON.stringify(cliTrace.json ?? cliTrace.stderr),
        ).toBe(0);
        const cliEvidence = toolContract(
          "trace_application_feature",
        ).outputSchema.parse(cliTrace.json);
        const response = await client.callTool({
          name: "trace_application_feature",
          arguments: {
            ...query,
            application: {
              kind: "retained-evidence",
              evidence_id: parent.evidence_id,
            },
          },
        });
        expect(response.isError).not.toBe(true);
        const evidence = toolContract(
          "trace_application_feature",
        ).outputSchema.parse(response.structuredContent);
        expect(evidence.evidence_id).toBe(cliEvidence.evidence_id);
        for (const value of [cliEvidence, evidence])
          observed.push({
            trace: applicationFeatureTraceResultSchema.parse(
              value.normalized_result,
            ),
            linked: native_observations.length > 0,
          });
      }
      // Exercise both provider-evidence selections and adapters before checking
      // the missing-byte outcome; a failed baseline still observes both paths.
      for (const { trace, linked } of observed)
        expectHandoffIdentity(trace, {
          available,
          addon,
          archiveDigest,
          nativeDigest,
          parentId: parent.evidence_id,
          nativeId: nativeEvidence.evidence_id,
          linked,
        });
      expect(sha256(await readFile(archive))).toBe(archiveDigest);
      if (available)
        expect(sha256(await readFile(companion))).toBe(nativeDigest);
      await client.ping();
    },
  );
}

cliTest(
  "keeps known requested add-on exports in every trace direction",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-native-direction-");
    const app = join(root, "app");
    await mkdir(app);
    await writeFile(
      join(app, "main.js"),
      'const { openProject } = require("./addon.node"); openProject();\n',
    );
    await writeFile(join(app, "addon.node"), "inert native addon fixture");
    const analysis = await cli.run({
      arguments: [
        "analyze-javascript-application",
        app,
        "--artifact-format",
        "directory",
        "--json",
      ],
    });
    expect(analysis.exitCode, analysis.stderr).toBe(0);
    const parent = toolContract(
      "analyze_javascript_application",
    ).outputSchema.parse(analysis.json);
    const { graph } =
      parent.normalized_result as unknown as JavaScriptApplicationAnalysisResult;
    const addonNode = graph.nodes.find(({ kind }) => kind === "native-addon");
    const exportNode = graph.nodes.find(({ kind }) => kind === "native-export");
    expect(addonNode?.identity.strategy).toBe("content-digest");
    expect(exportNode).toBeDefined();
    for (const direction of ["outgoing", "incoming", "both"] as const) {
      const request = join(root, `${direction}.json`);
      await writeFile(
        request,
        JSON.stringify({
          application: parent,
          seed: {
            kind: "node-id",
            value: addonNode?.node_id,
            match: "exact",
            case_sensitive: true,
          },
          direction,
        }),
      );
      const traced = await cli.run({
        arguments: ["trace-application-feature", request, "--json"],
      });
      expect(traced.exitCode, traced.stderr).toBe(0);
      const trace = applicationFeatureTraceResultSchema.parse(
        toolContract("trace_application_feature").outputSchema.parse(
          traced.json,
        ).normalized_result,
      );
      expect(trace.native_handoffs, direction).toEqual([
        expect.objectContaining({
          native_node_id: addonNode?.node_id,
          export_node_ids: [exportNode?.node_id],
          requested_exports: ["openProject"],
        }),
      ]);
      // The direction still selects the traced subgraph; only the handoff
      // binds the add-on's requested members from the source graph.
      expect(
        trace.graph?.nodes.some(
          ({ node_id: id }) => id === exportNode?.node_id,
        ),
        direction,
      ).toBe(direction !== "incoming");
    }
  },
);
