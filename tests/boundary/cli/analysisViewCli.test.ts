import { apiSurfaceHar } from "../../fixtures/historicalHar.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

import {
  analysisViewLayoutEvidence,
  analysisViewCaptureFixture,
  analysisViewCaptureEvidence,
  analysisViewObjectDenseCapture,
} from "../../fixtures/analysisView.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { ghidraFunctionDossier } from "../../../src/domain/ghidraValues.fixture.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { inspectEvidenceBundle } from "../../../src/application/investigation/InspectEvidenceBundle.js";

cliTest(
  "admits portable captures before parsing and preserves capture caveats",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-inline-capture-cli-");
    const path = join(root, "view.json");
    const environment = {
      HOME: root,
      XDG_CONFIG_HOME: root,
      XDG_CACHE_HOME: root,
    };
    await writeFile(
      path,
      JSON.stringify({
        source: {
          kind: "inline",
          evidence: analysisViewCaptureEvidence(
            analysisViewObjectDenseCapture(),
          ),
        },
        view: { kind: "api-surface" },
      }),
    );
    const refused = await cli.run({
      arguments: ["inspect-analysis-view", path, "--json"],
      environment,
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.json).toMatchObject({
      code: "resource_constraint",
      details: { resource: "memory" },
    });

    const capture = analysisViewCaptureFixture();
    capture.records = capture.records.slice(0, 1);
    capture.total_records = 1;
    const caveat = "Producer omitted exchanges before capture startup.";
    capture.limitations = [caveat, caveat];
    capture.records[0]!.reported = {
      request: { method: "GET", url: "https://api.test/a" },
      response: {
        status: 200,
        content: { mimeType: "\u000btext/plain\u000b" },
      },
    };
    const parent = analysisViewCaptureEvidence(capture);
    expect(parent.limitations).not.toContain(caveat);
    await writeFile(
      path,
      JSON.stringify({
        source: { kind: "inline", evidence: parent },
        view: { kind: "api-surface" },
      }),
    );
    const response = await cli.run({
      arguments: ["inspect-analysis-view", path, "--json"],
      environment,
    });
    expect(response.exitCode, response.stdout).toBe(0);
    const result = parseEvidence(response.json);
    expect(result.limitations.filter((value) => value === caveat)).toEqual([
      caveat,
    ]);
    expect(result.normalized_result).toMatchObject({
      groups: [{ content_types: [], flags: ["single-sample"] }],
      limitations: expect.arrayContaining([caveat]),
      unknowns: [
        "Some retained records have unavailable status or content type values.",
      ],
    });
  },
);

cliTest(
  "discovers native records from a complete portable bundle using the shared workflow",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-evidence-discovery-cli-");
    const parent = createEvidence(
      { path: "/fixtures/native.exe", format: "pe", sha256: "a".repeat(64) },
      { id: "ghidra", name: "Ghidra", version: "12.1.4" },
      {
        operation: "analyze_function",
        parameters: {},
        result: ghidraFunctionDossier(),
      },
    );
    const bundle = createEvidenceBundle([parent]);
    const path = join(root, "evidence.json");
    await writeFile(path, JSON.stringify(bundle));
    const options = {
      detail: "summary" as const,
      filters: { evidence_id: parent.evidence_id },
    };
    const result = await cli.run({
      arguments: [
        "inspect-evidence-bundle",
        JSON.stringify({ path, ...options }),
        "--json",
      ],
      environment: { HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root },
    });
    expect(result.exitCode).toBe(0);
    const expected = inspectEvidenceBundle(bundle, options);
    if (!expected.ok) throw expected.error;
    expect(result.json).toEqual(expected.value);
    const complete = await cli.run({
      arguments: [
        "inspect-evidence-bundle",
        JSON.stringify({ path }),
        "--json",
      ],
      environment: { HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root },
    });
    expect(complete.exitCode).toBe(0);
    expect(complete.json).toEqual(bundle);
  },
);
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

for (const [view, reason] of [
  [{ kind: "unknown-view" }, "invalid_value"],
  [{}, "missing_argument"],
] as const) {
  cliTest(
    `reports correction details for ${reason} view kind`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-view-variant-");
      const input = join(root, "view.json");
      await writeFile(
        input,
        JSON.stringify({
          source: {
            kind: "inline",
            evidence: analysisViewLayoutEvidence(),
          },
          view,
        }),
      );
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
        details: {
          issues: [
            {
              path: ["view", "kind"],
              reason,
              expected: expect.arrayContaining(["summary", "page"]),
            },
          ],
        },
      });
      expect(JSON.stringify(result.json)).not.toContain("unknown-view");
    },
  );
}

cliTest(
  "decodes HAR credentials and projects recorded API paths through the compiled workflows",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-surface-cli-");
    const fixture = apiSurfaceHar();
    const entry = fixture.log.entries[0]!;
    const urls = [
      "https://user:password@api.example.test/a/%2e%2e/admin?token=ordinary#fragment",
      "https://api.example.test/admin",
      "https:user:password@api.example.test/path",
      "https:///user:password@api.example.test/path",
    ];
    fixture.log.entries.push(
      ...urls.map((url) => ({
        ...entry,
        request: { ...entry.request, url },
      })),
    );
    const bytes = JSON.stringify(fixture);
    const capturePath = join(root, "capture.har");
    const input = join(root, "view.json");
    const environment = {
      HOME: root,
      XDG_CONFIG_HOME: root,
      XDG_CACHE_HOME: root,
    };
    await writeFile(capturePath, bytes);
    const capture = await cli.run({
      arguments: ["inspect-web-network-capture", capturePath, "har", "--json"],
      environment,
    });
    expect(capture.exitCode, capture.stdout).toBe(0);
    const parent = parseEvidence(capture.json);
    expect(parent.subject?.digest.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(JSON.stringify(parent)).not.toContain("password");
    await writeFile(
      input,
      JSON.stringify({
        source: { kind: "inline", evidence: parent },
        view: { kind: "api-surface" },
      }),
    );
    const result = await cli.run({
      arguments: ["inspect-analysis-view", input, "--json"],
      environment,
    });
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.json).toMatchObject({
      confidence: "inferred",
      evidence_links: [parent.evidence_id],
      normalized_result: {
        kind: "api-surface",
        records: { examined: 17, total: 17, excluded: 2 },
        coverage: { total: 14, exhausted: true },
        groups: expect.arrayContaining([
          expect.objectContaining({
            path_template: "/a/%2e%2e/admin",
            record_ordinals: [13],
          }),
          expect.objectContaining({
            path_template: "/admin",
            record_ordinals: [14],
          }),
        ]),
        excluded_records: [
          { ordinal: 15, reason: "url-redacted" },
          { ordinal: 16, reason: "url-redacted" },
        ],
      },
    });
    expect(JSON.stringify(result.json)).not.toContain("password");
    expect(JSON.stringify(result.json)).not.toContain("ordinary");
  },
);
