import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import { lt, rcompare } from "semver";

import { CATALOG_IDENTITY } from "../dist/catalogIdentity.js";
import { completeVerifierRun, createVerifierRun } from "./lib/verifier-run.mjs";

const verifierRun = createVerifierRun();
const execFileAsync = promisify(execFile);
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version ?? ""))
  throw new Error("Usage: node scripts/verify-published-package.mjs <version>");

const serverEnvironment = { ...process.env };
delete serverEnvironment.HOPPER_TARGET_PATH;
const canaryRoot = await mkdtemp(join(tmpdir(), "rea-published-canary-"));
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
let upgrade;

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
  upgrade = await verifyPublishedUpgrade({ version, canaryRoot });
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
  `${JSON.stringify({ verifier_run: await completeVerifierRun(verifierRun), package: "rea-agents", version, mcpTools: publishedToolCount, canonicalMcpTools: CATALOG_IDENTITY.counts.mcp_tools, upgrade })}\n`,
);

async function verifyPublishedUpgrade({ version: targetVersion, canaryRoot }) {
  const previousVersion = await findPreviousPublishedVersion(targetVersion);
  const prefix = join(canaryRoot, "upgrade-prefix");
  const home = join(canaryRoot, "upgrade-home");
  const environment = {
    ...process.env,
    HOME: home,
    npm_config_cache: join(canaryRoot, "upgrade-cache"),
    npm_config_prefix: prefix,
    PATH: `${join(prefix, "bin")}${delimiter}${process.env.PATH ?? ""}`,
  };

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

  const { stdout } = await execFileAsync(
    "npx",
    ["rea-agents", "upgrade", "--json"],
    { cwd: canaryRoot, env: environment, maxBuffer: 16 * 1024 * 1024 },
  );
  const result = JSON.parse(stdout);
  if (
    result.status !== "upgraded" ||
    result.previousVersion !== previousVersion ||
    result.latestVersion !== targetVersion
  )
    throw new Error(
      `npx rea-agents upgrade did not upgrade ${previousVersion} to ${targetVersion}: ${stdout}`,
    );

  const npmRoot = (
    await execFileAsync("npm", ["root", "--global"], {
      cwd: canaryRoot,
      env: environment,
    })
  ).stdout.trim();
  const installed = JSON.parse(
    await readFile(join(npmRoot, "rea-agents", "package.json"), "utf8"),
  );
  if (installed.version !== targetVersion)
    throw new Error(
      `npx rea-agents upgrade installed ${installed.version}, expected ${targetVersion}`,
    );

  const help = (
    await execFileAsync(join(prefix, "bin", "rea-agents"), ["--help"], {
      cwd: canaryRoot,
      env: environment,
    })
  ).stdout;
  if (!help.includes("setup"))
    throw new Error("the upgraded rea-agents executable did not start");

  return {
    status: result.status,
    previousVersion,
    latestVersion: result.latestVersion,
    installedVersion: installed.version,
  };
}

async function findPreviousPublishedVersion(targetVersion) {
  const { stdout } = await execFileAsync(
    "npm",
    ["view", "rea-agents", "versions", "--json"],
    { maxBuffer: 16 * 1024 * 1024 },
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
