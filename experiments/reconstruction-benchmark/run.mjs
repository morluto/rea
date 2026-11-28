import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { evaluatePack } from "./adapter.mjs";
import { calibrationPack, EXPECTED_OUTCOMES } from "./calibration.mjs";

// Uses this checkout's built runtime; no install/build is performed.
if (process.argv.length !== 2)
  throw new Error("Usage: node experiments/reconstruction-benchmark/run.mjs");
const runtimeRoot = fileURLToPath(new URL("../..", import.meta.url));
const launcher = join(runtimeRoot, "scripts/rea.mjs");
const launcherSha256 = createHash("sha256")
  .update(await readFile(launcher))
  .digest("hex");
async function distDigest() {
  const files = [];
  async function visit(relative) {
    const entries = await readdir(join(runtimeRoot, "dist", relative), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Unsupported compiled runtime entry: ${path}`);
    }
  }
  await visit("");
  const hash = createHash("sha256");
  for (const file of files.sort())
    hash.update(
      `${file}\0${createHash("sha256")
        .update(await readFile(join(runtimeRoot, "dist", file)))
        .digest("hex")}\n`,
    );
  return hash.digest("hex");
}
const beforeDistSha256 = await distDigest();
const home = await mkdtemp(join(tmpdir(), "rea-reconstruction-calibration-"));
const client = new Client({
  name: "rea-reconstruction-calibration",
  version: "0.1.0",
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [launcher, "mcp"],
  stderr: "pipe",
  env: {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
    REA_LOG_LEVEL: "silent",
    HOPPER_LAUNCHER_PATH: "/rea-unconfigured-deep-provider/hopper",
    GHIDRA_INSTALL_DIR: process.execPath,
  },
});
let stderrTail = Buffer.alloc(0);
let stderrBytes = 0;
transport.stderr.on("data", (chunk) => {
  stderrBytes += chunk.length;
  stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-16384);
});
let observedTransportClose = false;
let resolveClosed;
const closed = new Promise((resolve) => {
  resolveClosed = resolve;
});
transport.onclose = () => {
  observedTransportClose = true;
  resolveClosed();
};
let report;
const cleanupErrors = [];
try {
  await client.connect(transport, { timeout: 30000 });
  report = await evaluatePack(calibrationPack(), (name, args) =>
    client.callTool({ name, arguments: args }, { timeout: 30000 }),
  );
  report.server = client.getServerVersion();
} catch (error) {
  report = {
    format: "rea-reconstruction-calibration-result/v1",
    execution: "error",
    error: error instanceof Error ? error.message : String(error),
  };
} finally {
  for (const [name, close] of [
    ["client", () => client.close()],
    ["transport", () => transport.close()],
  ]) {
    try {
      await close();
    } catch (error) {
      cleanupErrors.push({ owner: name, error: String(error) });
    }
  }
  let timer;
  await Promise.race([
    closed,
    new Promise((resolve) => {
      timer = setTimeout(resolve, 2000);
    }),
  ]);
  clearTimeout(timer);
  if (!observedTransportClose)
    cleanupErrors.push({
      owner: "transport",
      error: "Child close event was not observed; scratch retained.",
    });
  if (cleanupErrors.length === 0) {
    try {
      await rm(home, { recursive: true });
    } catch (error) {
      cleanupErrors.push({ owner: "scratch", error: String(error) });
    }
  }
}
if (report.tasks) {
  report.calibration_checks = Object.entries(EXPECTED_OUTCOMES).map(
    ([id, expected]) => {
      const task = report.tasks.find((task) => task.id === id);
      const actual = task?.verification?.normalized_result?.status ?? null;
      return {
        id,
        expected,
        actual,
        matches: task?.execution === "completed" && actual === expected,
      };
    },
  );
  if (report.calibration_checks.some((check) => !check.matches))
    process.exitCode = 1;
}
report.stderr = {
  total_bytes: stderrBytes,
  retained_tail_base64: stderrTail.toString("base64"),
  truncated: stderrBytes > stderrTail.length,
};
let afterDistSha256 = null;
let runtimeIdentityError;
try {
  afterDistSha256 = await distDigest();
} catch (error) {
  runtimeIdentityError = String(error);
  process.exitCode = 1;
}
report.runtime = {
  node: process.version,
  launcher_sha256: launcherSha256,
  dist_before_sha256: beforeDistSha256,
  dist_after_sha256: afterDistSha256,
  identity_error: runtimeIdentityError,
  identity_limit:
    "These digests fingerprint dist before and after; they do not establish a clean source build, installed dependencies, or current upstream main.",
};
if (report.runtime.dist_before_sha256 !== report.runtime.dist_after_sha256) {
  report.runtime.changed_during_run = true;
  process.exitCode = 1;
}
report.cleanup = cleanupErrors.length
  ? { state: "incomplete", errors: cleanupErrors, retained_home: home }
  : { state: "completed" };
console.log(JSON.stringify(report, null, 2));
if (
  report.execution === "error" ||
  report.not_run?.length ||
  report.tasks?.some((task) => task.execution === "error") ||
  cleanupErrors.length
)
  process.exitCode = 1;
