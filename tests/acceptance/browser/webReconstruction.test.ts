import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { parseEvidence, type Evidence } from "../../../src/domain/evidence.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import {
  webVerificationMutation,
  webVerificationScenario,
} from "../../../src/domain/reconstructionWebVerification.fixture.js";
import { reconstructionVerificationResultSchema } from "../../../src/domain/reconstructionVerificationSchemas.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

// Modeled producer-boundary observations; real owned-browser examples are separate.
const originMapping = {
  before_origin: "https://original.example.test",
  after_origin: "http://127.0.0.1:43817",
};

cliTest(
  "CLI and MCP require the same complete transitive proof closure",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-web-transitive-");
    const dependency = webVerificationScenario({ duration: 3 });
    const left = webVerificationMutation(webVerificationScenario(), {
      evidence_links: [dependency.evidence_id],
    });
    const right = webVerificationScenario({ duration: 2 });
    const mcp = await connectLocalToolsMcp();
    const response = await mcp.call("compare_web_captures", { left, right });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const comparison = parseEvidence(response.structuredContent);
    const selection = {
      name: "Complete proof closure",
      claims: [
        {
          claim_id: "settings.dom",
          title: "Selected DOM matches",
          kind: "web-scenario",
          dimension: "dom",
          step_id: "wait",
          comparison_evidence_id: comparison.evidence_id,
        },
      ],
    };
    const missingPath = join(root, "missing.json");
    await writeFile(
      missingPath,
      JSON.stringify({
        specification: selection,
        evidence_bundle: createEvidenceBundle([left, right, comparison]),
      }),
    );
    const missingCli = await cli.run({
      arguments: ["verify-reconstruction", missingPath, "--json"],
      environment: { ...process.env, REA_LOG_LEVEL: "silent" },
    });
    expect(missingCli.exitCode).toBe(1);
    expect(missingCli.json).toMatchObject({
      code: "evidence_integrity_mismatch",
    });
    const missingMcp = await mcp.call("verify_reconstruction", {
      specification: selection,
    });
    expect(missingMcp.isError).toBe(true);

    const fullBundle = createEvidenceBundle([
      left,
      right,
      comparison,
      dependency,
    ]);
    const bundlePath = join(root, "bundle.json");
    const requestPath = join(root, "complete.json");
    await Promise.all([
      writeFile(bundlePath, JSON.stringify(fullBundle)),
      writeFile(
        requestPath,
        JSON.stringify({
          specification: selection,
          evidence_bundle: fullBundle,
        }),
      ),
    ]);
    const completeCli = await cli.run({
      arguments: ["verify-reconstruction", requestPath, "--json"],
      environment: { ...process.env, REA_LOG_LEVEL: "silent" },
    });
    expect(completeCli.exitCode, JSON.stringify(completeCli.json)).toBe(0);
    const verified = reconstructionVerificationResultSchema.parse(
      completeCli.json,
    );
    expect(verified.status).toBe("pass");
    expect(verified.evidence_links).toContain(dependency.evidence_id);
    const imported = await mcp.call("import_evidence_bundle", {
      path: bundlePath,
    });
    expect(imported.isError, JSON.stringify(imported)).not.toBe(true);
    const completeMcp = await mcp.call("verify_reconstruction", {
      specification: selection,
    });
    expect(completeMcp.isError, JSON.stringify(completeMcp)).not.toBe(true);
    expect(
      parseEvidence(completeMcp.structuredContent).normalized_result,
    ).toEqual(verified);
  },
);

const specification = (comparison: Evidence, pixels: Evidence) => ({
  name: "Declared settings DOM and pixels",
  claims: [
    {
      claim_id: "settings.dom",
      title: "Settings DOM matches",
      kind: "web-scenario",
      dimension: "dom",
      step_id: "wait",
      comparison_evidence_id: comparison.evidence_id,
    },
    {
      claim_id: "settings.pixels",
      title: "Settings pixels match exactly",
      kind: "web-screenshot",
      dimension: "pixels",
      maximum_changed_ratio: 0,
      comparison_evidence_id: pixels.evidence_id,
    },
  ],
});

cliTest(
  "portable CLI and stdio MCP preserve web sources, retained references and finite verification",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-web-verification-");
    const left = webVerificationScenario();
    const right = webVerificationScenario({
      origin: originMapping.after_origin,
      duration: 2,
    });
    const leftPath = join(root, "original.json");
    const rightPath = join(root, "candidate.json");
    await Promise.all([
      writeFile(leftPath, JSON.stringify(left)),
      writeFile(rightPath, JSON.stringify(right)),
    ]);
    const compare = async (command: string, extra: readonly string[] = []) => {
      const result = await cli.run({
        arguments: [
          command,
          leftPath,
          rightPath,
          "--origin-mapping-json",
          JSON.stringify(originMapping),
          ...extra,
          "--json",
        ],
        environment: { ...process.env, REA_LOG_LEVEL: "silent" },
      });
      expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
      return parseEvidence(result.json);
    };
    const comparison = await compare("compare-web-captures");
    const pixels = await compare("compare-web-screenshots", [
      "--step-id",
      "wait",
    ]);
    expect(comparison.evidence_links).toEqual(
      [left.evidence_id, right.evidence_id].sort(),
    );
    expect(pixels.evidence_links).toEqual(comparison.evidence_links);
    const bundle = createEvidenceBundle([left, right, comparison, pixels]);
    const requestPath = join(root, "request.json");
    const sourceBundlePath = join(root, "sources.json");
    await Promise.all([
      writeFile(
        requestPath,
        JSON.stringify({
          specification: specification(comparison, pixels),
          evidence_bundle: bundle,
        }),
      ),
      writeFile(
        sourceBundlePath,
        JSON.stringify(createEvidenceBundle([left, right])),
      ),
    ]);
    const checked = await cli.run({
      arguments: ["verify-reconstruction", requestPath, "--json"],
      environment: { ...process.env, REA_LOG_LEVEL: "silent" },
    });
    expect(checked.exitCode, JSON.stringify(checked.json)).toBe(0);
    const verified = reconstructionVerificationResultSchema.parse(checked.json);
    expect(verified).toMatchObject({
      status: "pass",
      summary: { passed: 2, failed: 0, unknown: 0 },
    });

    const references = {
      left: { kind: "retained-evidence", evidence_id: left.evidence_id },
      right: { kind: "retained-evidence", evidence_id: right.evidence_id },
      origin_mapping: originMapping,
    };
    const retained = await cli.run({
      arguments: [
        "compare-web-captures",
        JSON.stringify(references.left),
        JSON.stringify(references.right),
        "--origin-mapping-json",
        JSON.stringify(originMapping),
        "--evidence-bundle",
        sourceBundlePath,
        "--json",
      ],
      environment: { ...process.env, REA_LOG_LEVEL: "silent" },
    });
    expect(retained.exitCode, JSON.stringify(retained.json)).toBe(0);
    expect(parseEvidence(retained.json).evidence_id).toBe(
      comparison.evidence_id,
    );

    const mcp = await connectLocalToolsMcp();
    const captured = await mcp.call("compare_web_captures", {
      left,
      right,
      origin_mapping: originMapping,
    });
    expect(captured.isError, JSON.stringify(captured)).not.toBe(true);
    expect(parseEvidence(captured.structuredContent).evidence_id).toBe(
      comparison.evidence_id,
    );
    const visual = await mcp.call("compare_web_screenshots", {
      ...references,
      step_id: "wait",
    });
    expect(visual.isError, JSON.stringify(visual)).not.toBe(true);
    expect(parseEvidence(visual.structuredContent).evidence_id).toBe(
      pixels.evidence_id,
    );
    const result = await mcp.call("verify_reconstruction", {
      specification: specification(comparison, pixels),
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(parseEvidence(result.structuredContent).normalized_result).toEqual(
      verified,
    );
  },
);

cliTest(
  "CLI reports a real declared DOM difference and incomplete pixels separately",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-web-partial-");
    const left = webVerificationScenario();
    const right = webVerificationScenario({
      duration: 2,
      dom: "<main>Different settings</main>",
      screenshot: null,
    });
    const mcp = await connectLocalToolsMcp();
    const compared = await mcp.call("compare_web_captures", { left, right });
    const visual = await mcp.call("compare_web_screenshots", {
      left,
      right,
      step_id: "wait",
    });
    expect(compared.isError, JSON.stringify(compared)).not.toBe(true);
    expect(visual.isError, JSON.stringify(visual)).not.toBe(true);
    const comparison = parseEvidence(compared.structuredContent);
    const pixels = parseEvidence(visual.structuredContent);
    const requestPath = join(root, "request.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        specification: specification(comparison, pixels),
        evidence_bundle: createEvidenceBundle([
          left,
          right,
          comparison,
          pixels,
        ]),
      }),
    );
    const checked = await cli.run({
      arguments: ["verify-reconstruction", requestPath, "--json"],
      environment: { ...process.env, REA_LOG_LEVEL: "silent" },
    });
    expect(checked.exitCode, JSON.stringify(checked.json)).toBe(0);
    const result = reconstructionVerificationResultSchema.parse(checked.json);
    expect(result.status).toBe("fail");
    expect(
      result.claims.items.map(({ claim_id, status }) => [claim_id, status]),
    ).toEqual([
      ["settings.dom", "fail"],
      ["settings.pixels", "unknown"],
    ]);
  },
);
