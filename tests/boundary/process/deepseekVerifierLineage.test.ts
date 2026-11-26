import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { processTest } from "../../support/process/processFixture.js";

const script = new URL(
  "../../../scripts/verify-deepseek-client.mjs",
  import.meta.url,
);
const contracts = new URL("../dist/contracts/toolContracts.js", script).href;
const runModule = new URL("./lib/verifier-run.mjs", script).href;
const moduleUrl = (source: string) =>
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

const model = moduleUrl(`
export { toolCallMessage } from ${JSON.stringify(new URL("./verify/clients/model-fixture.mjs", script).href)};
import { TOOL_CONTRACTS } from ${JSON.stringify(contracts)};
export async function createOpenAiModelFixture({ onRequest }) {
  await onRequest({
    body: { messages: [] },
    tools: TOOL_CONTRACTS.map(({ name }) => ({
      name: "mcp__rea__" + name,
      parameters: { type: "string", pattern: "^fixture$" },
    })),
  });
  return { baseUrl: "http://127.0.0.1:1/v1", async close() {} };
}
`);

processTest.skipIf(process.platform === "win32").for([
  [
    "live owned process",
    "verified",
    "Owned descendants survived verifier cleanup",
  ],
  ["foreign token", "unavailable", "Verifier cleanup could not be verified"],
] as const)(
  "gates the DeepSeek receipt on %s lineage",
  async ([scenario, status, failure], { processes }) => {
    const state = await createTestTempDirectory("rea-deepseek-lineage-");
    const client = join(state, "headless");
    const hook = join(state, "hook.mjs");
    const lineage = moduleUrl(`
import { spawn } from "node:child_process";
import { once } from "node:events";
import { completeVerifierRun as complete } from ${JSON.stringify(runModule)};
export { createVerifierRun, assertVerifierCleanupComplete } from ${JSON.stringify(runModule)};

export async function completeVerifierRun(run) {
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    env: { REA_PROCESS_RUN_ID: ${scenario === "foreign token" ? '"foreign-probe-token"' : "run.run_id"} },
    stdio: ["pipe", "ignore", "ignore"],
  });
  const closed = once(child, "close");
  try {
    await once(child, "spawn");
    return await complete(run);
  } finally {
    child.stdin.end();
    await closed;
  }
}
`);
    await writeFile(
      hook,
      `
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === ${JSON.stringify(script.href)}) {
      if (specifier === "./lib/verifier-run.mjs")
        return { url: ${JSON.stringify(lineage)}, shortCircuit: true };
      if (specifier === "./verify/clients/model-fixture.mjs")
        return { url: ${JSON.stringify(model)}, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
`,
    );
    await writeFile(
      client,
      `#!/bin/sh
if [ "$1" = --version ]; then
  printf '%s\\n' 'lineage fixture'
else
  printf '%s\\n' '{"type":"final","text":"REA_CLIENT_COMPATIBILITY_OK"}'
fi
`,
      { mode: 0o700 },
    );

    const result = await processes.run(
      process.execPath,
      ["--import", hook, fileURLToPath(script), "chat"],
      {
        env: {
          ...process.env,
          TMPDIR: state,
          REA_VERIFY_DEEPSEEK_COMMAND: client,
        },
      },
    );
    const receipt = JSON.parse(result.stdout);
    expect(receipt, result.stderr).toMatchObject({
      lifecycle: [
        "dry-run",
        "setup",
        "idempotent-setup",
        "doctor",
        "native-chat",
        "uninstall",
      ],
      verifier: { process_lineage: { status } },
    });
    if (status === "verified")
      expect(receipt.verifier.process_lineage.descendants).toHaveLength(1);
    else
      expect(receipt.verifier.process_lineage.reason).toMatch(
        /descendant \d+ run token did not match/u,
      );
    expect(
      JSON.parse(
        await readFile(join(receipt.artifacts, "receipt.json"), "utf8"),
      ),
    ).toEqual(receipt);
    expect(receipt.passed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(failure);
  },
);
