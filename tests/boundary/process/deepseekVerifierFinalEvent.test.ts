import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { processTest } from "../../support/process/processFixture.js";

const verifier = fileURLToPath(
  new URL("../../../scripts/verify-deepseek-client.mjs", import.meta.url),
);
const contracts = new URL(
  "../../../dist/contracts/toolContracts.js",
  import.meta.url,
).href;
const marker = "REA_CLIENT_COMPATIBILITY_OK";
const final = JSON.stringify({ type: "final", text: marker }) + "\n";
const preview = JSON.stringify({ type: "text", text: marker }) + "\n";

processTest.skipIf(process.platform === "win32").for([
  { name: "exact final", transcript: preview + final, code: 0, passed: true },
  { name: "marker in preview", transcript: preview, code: 0, passed: false },
  {
    name: "marker in wrong answer",
    transcript: final.replace(marker, marker + " extra"),
    code: 0,
    passed: false,
  },
  {
    name: "torn final event",
    transcript: final.slice(0, -2),
    code: 0,
    passed: false,
  },
  {
    name: "more than one final",
    transcript: final + final,
    code: 0,
    passed: false,
  },
  {
    name: "correct answer and failed exit",
    transcript: final,
    code: 7,
    passed: false,
  },
])(
  "checks $name in the DeepSeek transcript",
  async (scenario, { processes }) => {
    const state = await createTestTempDirectory("rea-deepseek-final-");
    const client = join(state, "headless.mjs");
    await writeFile(
      client,
      `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_CONTRACTS } from ${JSON.stringify(contracts)};
if (process.argv.includes("--version")) {
  console.log("transcript fixture");
} else {
  const config = readFileSync(join(process.env.DSH_HOME, "cordis.patch.yml"), "utf8");
  const base = /^ *baseURL: (.+)$/mu.exec(config)?.[1];
  const response = await fetch(base + "/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "rea-client-fixture",
      messages: [],
      tools: TOOL_CONTRACTS.map(({ name }) => ({
        type: "function",
        function: {
          name: "mcp__rea__" + name,
          parameters: { type: "string", pattern: "^fixture$" },
        },
      })),
    }),
  });
  const body = await response.json();
  if (body.choices?.[0]?.message.content !== ${JSON.stringify(marker)})
    throw new Error(JSON.stringify(body));
  process.stdout.write(${JSON.stringify(scenario.transcript)});
  process.exitCode = ${scenario.code};
}
`,
      { mode: 0o700 },
    );
    const result = await processes.run(process.execPath, [verifier, "chat"], {
      env: {
        ...process.env,
        REA_VERIFY_DEEPSEEK_COMMAND: client,
        TMPDIR: state,
      },
    });
    const receipt = JSON.parse(result.stdout);
    expect(receipt, result.stderr).toMatchObject({
      finalSeen: true,
      clientFinalSeen: scenario.passed || scenario.code === 7,
      lifecycle: expect.arrayContaining(["doctor"]),
    });
    expect(receipt.fixtureFailure).toBeUndefined();
    expect(
      await readFile(join(receipt.artifacts, "client.stdout"), "utf8"),
    ).toBe(scenario.transcript);
    expect(receipt.passed, result.stderr).toBe(scenario.passed);
    expect(result.exitCode).toBe(scenario.passed ? 0 : 1);
  },
);
