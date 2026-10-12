import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const { values } = parseArgs({
  options: {
    "runtime-root": { type: "string" },
    scenario: { type: "string" },
    output: { type: "string" },
  },
});
if (!values["runtime-root"] || !values.scenario || !values.output)
  throw new Error(
    "Use --runtime-root ABS --scenario JSON --output NEW_ABS_DIR",
  );
await mkdir(values.output, { mode: 0o700 });
const scenario = JSON.parse(await readFile(values.scenario, "utf8"));
const client = new Client({ name: "rea-real-browser-app", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(values["runtime-root"], "scripts/rea.mjs"), "mcp"],
  env: {
    ...process.env,
    REA_LOG_LEVEL: "silent",
    NODE_OPTIONS: "--max-old-space-size=512",
  },
  stderr: "pipe",
});
let failure;
try {
  await client.connect(transport);
  transport.stderr?.resume();
  const reply = await client.callTool(
    { name: "capture_browser_scenario", arguments: scenario },
    { timeout: 120_000 },
  );
  await writeFile(resolve(values.output, "reply.json"), JSON.stringify(reply));
  const value =
    reply.structuredContent ??
    JSON.parse(
      reply.content.find((item) => item.type === "text")?.text ?? "null",
    );
  if (reply.isError) {
    failure = value.error;
  } else {
    const capture = value.normalized_result;
    await writeFile(
      resolve(values.output, "summary.json"),
      JSON.stringify(
        {
          evidence_id: value.evidence_id,
          browser: capture.browser,
          scenario: capture.scenario,
          completeness: capture.completeness,
          step_count: capture.steps.length,
          event_count: capture.events.retained,
          limitations: value.limitations,
        },
        null,
        2,
      ),
    );
    process.stdout.write(
      JSON.stringify({
        evidence_id: value.evidence_id,
        browser: capture.browser,
        step_count: capture.steps.length,
      }) + "\n",
    );
  }
} finally {
  await client.close();
}
if (failure) {
  await writeFile(
    resolve(values.output, "failure.json"),
    JSON.stringify(failure, null, 2),
  );
  process.stdout.write(
    JSON.stringify({ code: failure.code, message: failure.message }) + "\n",
  );
  process.exitCode = 1;
}
