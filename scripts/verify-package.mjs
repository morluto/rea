import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const exec = promisify(execFile);
const root = process.cwd();
const workspace = await mkdtemp(join(tmpdir(), "better-binary-package-"));
let tarball;

try {
  tarball = (
    await exec("npm", ["pack", "--silent"], { cwd: root })
  ).stdout.trim();
  const prefix = join(workspace, "prefix");
  const home = join(workspace, "home");
  const fakeBin = join(workspace, "bin");
  await mkdir(fakeBin, { recursive: true });
  const brew = join(fakeBin, "brew");
  const swVers = join(fakeBin, "sw_vers");
  const npx = join(fakeBin, "npx");
  const npxLog = join(workspace, "npx.log");
  const hopper = join(workspace, "hopper");
  await writeFile(
    brew,
    '#!/bin/sh\nif [ "$1" = "--prefix" ]; then echo /fake/cask; fi\nexit 0\n',
  );
  await writeFile(swVers, "#!/bin/sh\necho 14.5\n");
  await writeFile(
    npx,
    '#!/bin/sh\nprintf "%s\\n" "$*" > "$BETTER_BINARY_NPX_LOG"\necho "│ ✓ Cursor: isolated │"\n',
  );
  await writeFile(hopper, "#!/bin/sh\nexit 0\n");
  await Promise.all([
    chmod(brew, 0o755),
    chmod(swVers, 0o755),
    chmod(hopper, 0o755),
    chmod(npx, 0o755),
  ]);
  const claudeDir = join(home, "Library/Application Support/Claude");
  const cursorDir = join(home, ".cursor");
  await Promise.all([
    mkdir(claudeDir, { recursive: true }),
    mkdir(cursorDir, { recursive: true }),
  ]);
  const claudeConfig = join(claudeDir, "claude_desktop_config.json");
  const cursorConfig = join(cursorDir, "mcp.json");
  await writeFile(claudeConfig, '{"existing":true}\n');
  await writeFile(cursorConfig, '{"existing":true}\n');
  const environment = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    HOPPER_LAUNCHER_PATH: hopper,
    BETTER_BINARY_NPX_LOG: npxLog,
  };
  await exec(
    "npm",
    ["install", "--global", "--prefix", prefix, join(root, tarball)],
    { env: environment },
  );
  const cli = join(prefix, "bin", "better-binary");
  const mcp = join(prefix, "bin", "better-binary-mcp");
  const help = await run(cli, ["--help"], environment);
  const llms = await run(cli, ["--llms"], environment);
  const doctor = json(await run(cli, ["doctor", "--json"], environment));
  if (
    !help.includes("setup") ||
    !llms.includes("decompile") ||
    doctor.healthy !== true
  )
    throw new Error("packaged CLI discovery or doctor failed");
  await run(cli, ["mcp", "add"], environment);
  const mcpRegistration = await readFile(npxLog, "utf8");
  if (
    !mcpRegistration.includes("add-mcp better-binary-mcp --name better-binary")
  )
    throw new Error("Incur mcp add did not register the beta.3 executable");
  const first = json(await run(cli, ["setup", "--yes", "--json"], environment));
  const second = json(
    await run(cli, ["setup", "--yes", "--json"], environment),
  );
  if (
    first.status !== "ready" ||
    second.status !== "ready" ||
    second.actions.length !== 0
  )
    throw new Error("packaged setup was not ready and idempotent");
  for (const configPath of [claudeConfig, cursorConfig]) {
    const config = json(await readFile(configPath, "utf8"));
    if (
      config.existing !== true ||
      config.mcpServers?.["better-binary"]?.command !== "better-binary-mcp"
    )
      throw new Error("packaged client readback failed");
    if (
      !(await readFile(`${configPath}.better-binary.backup`, "utf8")).includes(
        "existing",
      )
    )
      throw new Error("packaged client backup failed");
  }
  const skill = await readFile(
    join(home, ".agents/skills/better-binary-analysis/SKILL.md"),
    "utf8",
  );
  if (!skill.includes("open_binary"))
    throw new Error("packaged skill readback failed");

  await writeFile(cursorConfig, "malformed");
  const failed = json(
    await run(cli, ["setup", "--yes", "--json"], environment),
  );
  if (
    failed.status !== "needs_human" ||
    (await readFile(cursorConfig, "utf8")) !== "malformed"
  )
    throw new Error("packaged setup failure recovery did not preserve input");
  await writeFile(cursorConfig, "{}\n");
  const recovered = json(
    await run(cli, ["setup", "--yes", "--json"], environment),
  );
  if (recovered.status !== "ready")
    throw new Error("packaged setup did not recover");

  const transport = new StdioClientTransport({
    command: mcp,
    env: environment,
    stderr: "pipe",
  });
  let mcpStderr = "";
  transport.stderr?.on("data", (chunk) => {
    mcpStderr += chunk.toString();
  });
  const client = new Client({ name: "package-smoke", version: "1.0.0" });
  try {
    await client.connect(transport);
    if ((await client.listTools()).tools.length !== 42)
      throw new Error("packaged MCP did not expose 42 tools");
    const result = await client.callTool({
      name: "current_document",
      arguments: {},
    });
    if (result.isError !== true)
      throw new Error("packaged target-free MCP omitted no-target error");
  } catch (cause) {
    throw new Error(`packaged MCP smoke failed: ${mcpStderr}`, { cause });
  } finally {
    await client.close();
    await transport.close();
  }

  process.stdout.write(
    `${JSON.stringify({ cli: true, incurMcpCommand: "better-binary-mcp", doctor: true, setup: "idempotent", clients: 2, backupReadback: true, failureRecovery: true, skill: true, mcpTools: 42, targetFree: true })}\n`,
  );
} finally {
  if (tarball) await rm(join(root, tarball), { force: true });
  await rm(workspace, { recursive: true, force: true });
}

async function run(command, args, env) {
  return (await exec(command, args, { env })).stdout;
}
function json(text) {
  return JSON.parse(text);
}
