import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { browserScenarioSchema } from "../../dist/domain/browserScenario.js";
import { runScenarioCli } from "./browser-scenario-verifier.mjs";
import { requireMcpEvidenceResult } from "./mcp-verifier-results.mjs";

const yamlSecret = "rea: 'text' secret";
const normalizedSecret = "rea-normalized\u00a0secret\u200b-value";
const jsonSecret = 'rea-"quoted\\secret';

const accessibilityRedactionScenario = (endpoint, targetId, origin) =>
  browserScenarioSchema.parse({
    browser: { mode: "connect", cdp_endpoint: endpoint, target_id: targetId },
    start_url: {
      url: `${origin}/scenario-accessibility-redaction`,
      query: [
        {
          name: "yaml",
          value: { source: "secret", secret_id: "accessibility_yaml" },
        },
        {
          name: "normalized",
          value: { source: "secret", secret_id: "accessibility_normalized" },
        },
        {
          name: "json",
          value: { source: "secret", secret_id: "accessibility_json" },
        },
      ],
    },
    actions: [
      {
        step_id: "ready",
        action: "wait_for",
        locator: { kind: "role", role: "link", name: "Ordinary destination" },
        state: "visible",
      },
    ],
    secrets: [
      {
        secret_id: "accessibility_yaml",
        environment_variable: "REA_BROWSER_AX_YAML_SECRET",
      },
      {
        secret_id: "accessibility_normalized",
        environment_variable: "REA_BROWSER_AX_NORMALIZED_SECRET",
      },
      {
        secret_id: "accessibility_json",
        environment_variable: "REA_BROWSER_AX_JSON_SECRET",
      },
    ],
    capture: {
      after_each_step: ["accessibility"],
      at_end: ["accessibility"],
    },
  });

const assertCapture = (capture) => {
  assert.equal(capture.browser.cleanup, "disconnected-external");
  assert.equal(capture.steps.length, 2);
  for (const step of capture.steps) {
    assert.equal(step.status, "completed");
    const artifact = step.artifacts.accessibility;
    assert.equal(artifact.state, "captured");
    const { text, bytes, sha256 } = artifact.value;
    const forbidden = [
      yamlSecret,
      "rea: ''text'' secret",
      normalizedSecret,
      "rea-normalized secret-value",
      jsonSecret,
      JSON.stringify(jsonSecret).slice(1, -1),
    ];
    for (const secret of forbidden)
      assert.ok(
        !text.includes(secret),
        "Accessibility retained a declared secret",
      );
    assert.ok(text.includes("- 'button \"[REDACTED]\"'"));
    assert.equal(text.match(/button "\[REDACTED\]"/gu)?.length, 3);
    assert.ok(text.includes("Ordinary retained text é"));
    assert.ok(text.includes('link "Ordinary destination"'));
    assert.ok(text.includes("/url: /ordinary?value=ordinary-query"));
    assert.equal(bytes, Buffer.byteLength(text, "utf8"));
    assert.equal(
      sha256,
      createHash("sha256").update(text, "utf8").digest("hex"),
    );
  }
};

/** Verify declared secrets in actual serialized accessibility names. */
export async function verifyScenarioAccessibilityRedaction(
  endpoint,
  targetId,
  origin,
) {
  const environment = {
    ...process.env,
    REA_BROWSER_AX_YAML_SECRET: yamlSecret,
    REA_BROWSER_AX_NORMALIZED_SECRET: normalizedSecret,
    REA_BROWSER_AX_JSON_SECRET: jsonSecret,
  };
  const scenario = accessibilityRedactionScenario(endpoint, targetId, origin);
  assertCapture(
    (await runScenarioCli(scenario, environment)).normalized_result,
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../rea.mjs", import.meta.url)), "mcp"],
    env: environment,
    stderr: "pipe",
  });
  const client = new Client({
    name: "browser-accessibility-redaction-e2e",
    version: "1",
  });
  try {
    await client.connect(transport);
    assertCapture(
      requireMcpEvidenceResult(
        await client.callTool({
          name: "capture_browser_scenario",
          arguments: scenario,
        }),
        "capture_browser_scenario",
      ),
    );
  } finally {
    await client.close();
    await transport.close();
  }
  const targets = await (await fetch(`${endpoint}/json/list`)).json();
  assert.ok(
    targets.some(({ id }) => id === targetId),
    "External fixture target was closed",
  );
  return {
    mocked: false,
    cli: true,
    stdio_mcp: true,
    yaml_quoted_name_redacted: true,
    json_escaped_name_redacted: true,
    normalized_name_redacted: true,
    text_digests_and_sizes: true,
    ordinary_text_and_link_retained: true,
    external_target_preserved: true,
  };
}
