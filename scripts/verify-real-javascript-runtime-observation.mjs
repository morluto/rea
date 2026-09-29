import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../tests/conformance/runtime-inspector",
);
const targetPath = resolve(root, "node-target.mjs");
const child = spawn(process.execPath, ["--inspect=127.0.0.1:0", targetPath], {
  stdio: ["ignore", "ignore", "pipe"],
});

try {
  const webSocketUrl = await inspectorUrl(child);
  const socket = new URL(webSocketUrl);
  const endpoint = `http://127.0.0.1:${socket.port}`;
  const environment = {
    ...process.env,
    REA_V8_INSPECTOR_OBSERVE_ENABLED: "true",
  };
  const listed = await runCli(
    ["list-javascript-runtime-targets", endpoint, "--json"],
    environment,
  );
  const target = listed.normalized_result?.targets?.[0];
  if (
    listed.operation !== "list_javascript_runtime_targets" ||
    typeof target?.target_id !== "string" ||
    target.location?.kind !== "file" ||
    target.location.file_path !== targetPath
  )
    throw new Error("Real Node Inspector target discovery did not match");
  const observed = await runCli(
    [
      "observe-javascript-runtime",
      endpoint,
      target.target_id,
      "--runtime-kind",
      "node",
      "--observation-ms",
      "100",
      "--json",
    ],
    environment,
  );
  const result = observed.normalized_result;
  if (
    observed.operation !== "observe_javascript_runtime" ||
    observed.provider?.id !== "rea-v8-inspector" ||
    result?.target?.target_id !== target.target_id ||
    result?.target?.runtime_kind !== "node" ||
    !Array.isArray(result?.scripts?.items) ||
    result.scripts.items.length === 0
  )
    throw new Error("Real Node Inspector observation did not match");
  if (
    !Array.isArray(result.directly_observed) ||
    !Array.isArray(result.unavailable_without_instrumentation) ||
    result.capture?.truncated !== false
  )
    throw new Error("Real Node Inspector capture was incomplete");
  process.stdout.write(
    `${JSON.stringify({
      status: "pass",
      provider: observed.provider.id,
      target_id: target.target_id,
      listed_evidence_id: listed.evidence_id,
      observation_evidence_id: observed.evidence_id,
      scripts: result.scripts.items.length,
      contexts: result.execution_contexts.length,
      endpoint,
    })}\n`,
  );
} finally {
  await terminate(child);
}

async function inspectorUrl(process_) {
  let captured = "";
  for await (const chunk of process_.stderr) {
    captured += chunk.toString("utf8");
    const match = /Debugger listening on (ws:\/\/[^\s]+)/u.exec(captured);
    if (match?.[1] !== undefined) return match[1];
    if (captured.length > 64 * 1_024)
      throw new Error("Inspector startup output exceeded its bound");
  }
  throw new Error("Node exited before reporting its Inspector URL");
}

async function runCli(arguments_, environment) {
  const { stdout } = await execute(
    process.execPath,
    ["scripts/rea.mjs", ...arguments_],
    {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
      env: environment,
      maxBuffer: 16 * 1_024 * 1_024,
    },
  );
  return JSON.parse(stdout);
}

async function terminate(process_) {
  if (process_.exitCode !== null) return;
  const exited = once(process_, "exit");
  process_.kill("SIGTERM");
  const terminated = await Promise.race([
    exited.then(() => true),
    new Promise((resolveTimeout) =>
      setTimeout(() => resolveTimeout(false), 2_000),
    ),
  ]);
  if (terminated || process_.exitCode !== null) return;
  process_.kill("SIGKILL");
  await exited;
}
