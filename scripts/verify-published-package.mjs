import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { lt, rcompare } from "semver";

import { CATALOG_IDENTITY } from "../dist/catalogIdentity.js";
import { completeVerifierRun, createVerifierRun } from "./lib/verifier-run.mjs";

const verifierRun = createVerifierRun();
const execFileAsync = promisify(execFile);
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version ?? ""))
  throw new Error("Usage: node scripts/verify-published-package.mjs <version>");

const canaryRoot = await mkdtemp(join(tmpdir(), "rea-published-canary-"));
const serverEnvironment = {
  ...process.env,
  npm_config_cache: join(canaryRoot, "npm-cache"),
};
delete serverEnvironment.HOPPER_TARGET_PATH;
const transport = new StdioClientTransport({
  command: "npm",
  args: [
    "exec",
    "--yes",
    `--package=rea-agents@${version}`,
    "--",
    "rea",
    "mcp",
  ],
  cwd: canaryRoot,
  env: serverEnvironment,
  stderr: "pipe",
});
const client = new Client({
  name: "published-package-canary",
  version: "1",
});
let stderr = "";
transport.stderr?.on("data", (chunk) => {
  if (stderr.length < 16_384) stderr += chunk.toString("utf8");
});

let publishedToolCount = 0;
let update;

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const toolNames = tools.tools.map(({ name }) => name);
  const canonicalToolNames = new Set(
    CATALOG_IDENTITY.tools.map(({ name }) => name),
  );
  const unknownToolNames = toolNames.filter(
    (name) => !canonicalToolNames.has(name),
  );
  publishedToolCount = toolNames.length;
  if (
    publishedToolCount === 0 ||
    new Set(toolNames).size !== publishedToolCount ||
    unknownToolNames.length > 0
  )
    throw new Error(
      `Published MCP exposed an invalid capability-scoped tool projection (${String(publishedToolCount)} tools, unknown: ${unknownToolNames.join(", ") || "none"})`,
    );
  const status = await client.callTool({
    name: "binary_session",
    arguments: {},
  });
  if (status.isError === true)
    throw new Error("Published target-free MCP session check failed");
  update = await verifyPublishedUpdate({ version, canaryRoot });
} catch (cause) {
  throw new Error(`Published package verification failed: ${stderr}`, {
    cause,
  });
} finally {
  try {
    await client.close();
    await transport.close();
  } finally {
    await rm(canaryRoot, { recursive: true, force: true });
  }
}

process.stdout.write(
  `${JSON.stringify({ verifier_run: await completeVerifierRun(verifierRun), package: "rea-agents", version, mcpTools: publishedToolCount, canonicalMcpTools: CATALOG_IDENTITY.counts.mcp_tools, update })}\n`,
);

async function verifyPublishedUpdate({ version: targetVersion, canaryRoot }) {
  const prefix = join(canaryRoot, "update-prefix");
  const home = join(canaryRoot, "update-home");
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    CLAUDE_CONFIG_DIR: home,
    CODEX_HOME: join(home, ".codex"),
    COPILOT_HOME: join(home, ".copilot"),
    GROK_HOME: join(home, ".grok"),
    SAND_DATA_ROOT: join(home, ".grokbot"),
    OMP_PROFILE: undefined,
    PI_CODING_AGENT_DIR: undefined,
    PI_CONFIG_DIR: undefined,
    PI_PROFILE: undefined,
    XDG_CONFIG_HOME: join(home, ".config"),
    OPENCODE_CONFIG: join(home, ".config", "opencode", "opencode.json"),
    npm_config_cache: join(canaryRoot, "update-cache"),
    npm_config_prefix: prefix,
    PATH: `${join(prefix, "bin")}${delimiter}${process.env.PATH ?? ""}`,
  };
  const previousVersion = await findPreviousPublishedVersion(
    targetVersion,
    canaryRoot,
    environment,
  );

  await execFileAsync(
    "npm",
    [
      "install",
      "--global",
      "--ignore-scripts",
      "--prefix",
      prefix,
      `rea-agents@${previousVersion}`,
    ],
    { cwd: canaryRoot, env: environment, maxBuffer: 16 * 1024 * 1024 },
  );

  const npmRoot = (
    await execFileAsync("npm", ["root", "--global"], {
      cwd: canaryRoot,
      env: environment,
    })
  ).stdout.trim();
  // Older releases may predate the update command. Exercise the new published
  // updater's production workflow against that real previous installation.
  const updaterPrefix = join(canaryRoot, "updater");
  await execFileAsync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-save",
      "--no-package-lock",
      "--prefix",
      updaterPrefix,
      `rea-agents@${targetVersion}`,
    ],
    { cwd: canaryRoot, env: environment, maxBuffer: 16 * 1024 * 1024 },
  );
  const updaterRoot = join(updaterPrefix, "node_modules", "rea-agents");
  const harness = join(canaryRoot, "update.mjs");
  await writeFile(
    harness,
    `
import { runUpdate } from ${JSON.stringify(pathToFileURL(join(updaterRoot, "dist/application/Update.js")).href)};
import { systemUpdateHost } from ${JSON.stringify(pathToFileURL(join(updaterRoot, "dist/application/UpdateRuntime.js")).href)};
const result = await runUpdate(${JSON.stringify(previousVersion)}, systemUpdateHost(${JSON.stringify(join(npmRoot, "rea-agents"))}, ${JSON.stringify(home)}), "structured");
process.stdout.write(JSON.stringify(result));
if (result.status === "failed") process.exitCode = 1;
`,
  );
  const { stdout } = await execFileAsync(process.execPath, [harness], {
    cwd: canaryRoot,
    env: environment,
    maxBuffer: 16 * 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  if (
    result.status !== "updated" ||
    result.previousVersion !== previousVersion ||
    result.latestVersion !== targetVersion ||
    result.installedVersion !== targetVersion ||
    result.command.at(-1) !== `rea-agents@${targetVersion}`
  )
    throw new Error(
      `Published REA updater did not update ${previousVersion} to ${targetVersion}: ${stdout}`,
    );

  const installed = JSON.parse(
    await readFile(join(npmRoot, "rea-agents", "package.json"), "utf8"),
  );
  if (installed.version !== targetVersion)
    throw new Error(
      `REA update installed ${installed.version}, expected ${targetVersion}`,
    );

  const help = (
    await execFileAsync(join(prefix, "bin", "rea-agents"), ["--help"], {
      cwd: canaryRoot,
      env: environment,
    })
  ).stdout;
  if (!/^\s{2}update\s/mu.test(help) || /^\s{2}upgrade\s/mu.test(help))
    throw new Error(
      "the updated executable did not expose only the update command",
    );

  return {
    status: result.status,
    previousVersion,
    latestVersion: result.latestVersion,
    installedVersion: installed.version,
  };
}

async function findPreviousPublishedVersion(targetVersion, cwd, environment) {
  const { stdout } = await execFileAsync(
    "npm",
    ["view", "rea-agents", "versions", "--json"],
    { cwd, env: environment, maxBuffer: 16 * 1024 * 1024 },
  );
  const versions = JSON.parse(stdout);
  const previous = versions
    .filter(
      (candidate) =>
        typeof candidate === "string" && lt(candidate, targetVersion),
    )
    .sort(rcompare)[0];
  if (previous === undefined)
    throw new Error(
      `No published rea-agents version precedes ${targetVersion}`,
    );
  return previous;
}
