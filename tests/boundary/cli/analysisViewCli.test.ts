import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

import { analysisViewLayoutEvidence } from "../../fixtures/analysisView.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { ghidraFunctionDossier } from "../../../src/domain/ghidraValues.fixture.js";
cliTest(
  "projects one section from a JSON file of inline layout Evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-analysis-view-cli-");
    const parent = analysisViewLayoutEvidence();
    const request = {
      source: { kind: "inline", evidence: parent },
      view: {
        kind: "item",
        collection: "sections",
        selector: { name: ".data" },
      },
    };
    const input = join(root, "view.json");
    await mkdir(root, { recursive: true });
    await writeFile(input, JSON.stringify(request));
    const result = await cli.run({
      arguments: ["inspect-analysis-view", input, "--json"],
      environment: {
        HOME: root,
        XDG_CONFIG_HOME: root,
        XDG_CACHE_HOME: root,
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      operation: "inspect_analysis_view",
      normalized_result: {
        kind: "item",
        parent_evidence_id: parent.evidence_id,
        item: { name: { display: ".data" } },
      },
    });
  },
);

cliTest(
  "projects native function pseudocode without requiring Ghidra",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-native-view-cli-");
    const parent = createEvidence(
      { path: "/fixtures/native.exe", format: "pe", sha256: "a".repeat(64) },
      { id: "ghidra", name: "Ghidra", version: "12.1.4" },
      {
        operation: "analyze_function",
        parameters: { address: "0x401000" },
        result: ghidraFunctionDossier(),
      },
    );
    const input = join(root, "native-view.json");
    await writeFile(
      input,
      JSON.stringify({
        source: { kind: "inline", evidence: parent },
        view: { kind: "native", facet: "pseudocode", offset: 0, limit: 12 },
      }),
    );
    const result = await cli.run({
      arguments: ["inspect-analysis-view", input, "--json"],
      environment: { HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root },
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      operation: "inspect_analysis_view",
      normalized_result: {
        kind: "native",
        parent_evidence_id: parent.evidence_id,
        procedure_address: "0x401000",
        item: { text: "int fixture_", unit: "utf16-code-units" },
      },
      locations: [
        { kind: "artifact-path", path: "/fixtures/native.exe" },
        { kind: "address", address: "0x401000" },
      ],
    });
  },
);

cliTest("rejects malformed JSON before projection", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-analysis-view-cli-bad-");
  const result = await cli.run({
    arguments: ["inspect-analysis-view", "{", "--json"],
    environment: {
      HOME: root,
      XDG_CONFIG_HOME: root,
      XDG_CACHE_HOME: root,
    },
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "invalid_request",
    category: "invalid_input",
    details: { operation: "inspect-analysis-view" },
  });
});

cliTest("rejects a request that omits source", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-analysis-view-cli-missing-");
  const input = join(root, "missing-source.json");
  await writeFile(input, JSON.stringify({ view: { kind: "summary" } }));
  const result = await cli.run({
    arguments: ["inspect-analysis-view", input, "--json"],
    environment: {
      HOME: root,
      XDG_CONFIG_HOME: root,
      XDG_CACHE_HOME: root,
    },
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "invalid_request",
    category: "invalid_input",
    details: { operation: "inspect-analysis-view" },
  });
});
