#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parse as parseToml } from "smol-toml";
import {
  hashPortableFile,
  readPortableManifest,
  verifyPortableInventory,
} from "./lib/portable-inventory.mjs";
import {
  executePortableBatchHelp,
  executePortableCommand as execute,
} from "./lib/portable-command.mjs";

const { values } = parseArgs({
  options: { directory: { type: "string" }, powershell: { type: "string" } },
});
if (process.platform !== "win32" || !values.directory)
  throw new Error("Use --directory <extracted portable directory> on Windows.");
const directory = resolve(values.directory);
const reportStage = (stage) =>
  console.error(`[portable verification] ${stage}`);
reportStage("inventory and SHA-256");
const manifest = await readPortableManifest(join(directory, "portable.json"));
await verifyPortableInventory(directory, manifest.files);
for (const file of manifest.files) {
  const path = resolve(directory, file.path);
  const within = relative(directory, path);
  if (isAbsolute(within) || within === ".." || within.startsWith("..\\"))
    throw new Error(
      `Inventory path is outside the portable directory: ${file.path}`,
    );
  const observed = await hashPortableFile(path, file.size);
  assert.equal(observed.sha256, file.sha256, file.path);
}

const workspace = await mkdtemp(join(tmpdir(), "rea-portable-verification-"));
const node = join(directory, "runtime/node.exe");
const entry = join(directory, "app/scripts/rea.mjs");
let complete = false;
try {
  const sample = join(workspace, "sample %REA_PORTABLE_PROBE% & !NAME! 中文");
  await mkdir(sample);
  const source = 'export function greet(name) { return "Hello " + name; }\n';
  await writeFile(join(sample, "app.js"), source, "utf8");
  const guard = join(workspace, "network-guard.cjs");
  await writeFile(
    guard,
    'require("node:net").Socket.prototype.connect = function () { throw new Error("Portable verification forbids Node network connections"); };\n',
    "utf8",
  );
  // This removes package managers and host Node from PATH. The preload rejects
  // Node socket connections; it is not an OS firewall for external executables.
  const environment = {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    PATH: join(process.env.SystemRoot, "System32"),
    HOME: workspace,
    USERPROFILE: workspace,
    APPDATA: join(workspace, "Roaming"),
    LOCALAPPDATA: join(workspace, "Local"),
    TEMP: workspace,
    TMP: workspace,
    NODE_OPTIONS: `--require "${guard.replaceAll("\\", "/")}"`,
    npm_command: "exec",
    REA_PORTABLE_PROBE: "expanded-probe",
    NO_COLOR: "1",
  };
  // Invoke the full script path through inbox Windows PowerShell (including 5.1).
  // The artifact is local test output; bypass policy only in this child process.
  const powershellExecutable =
    values.powershell ??
    join(
      process.env.SystemRoot,
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    );
  const powershell = async (root, args) =>
    execute(
      powershellExecutable,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(root, "rea.ps1"),
        ...args,
      ],
      {
        cwd: workspace,
        env: environment,
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
  const launcher = (args) => powershell(directory, args);
  // Use the shipped launcher unchanged with a controlled child to prove argv,
  // cleared npm context and exit-code forwarding independently of REA.
  const capture = join(workspace, "argv %REA_PORTABLE_PROBE% & !NAME! 中文");
  await mkdir(join(capture, "runtime"), { recursive: true });
  await mkdir(join(capture, "app/scripts"), { recursive: true });
  await copyFile(node, join(capture, "runtime/node.exe"));
  await copyFile(
    join(directory, "runtime/launch.mjs"),
    join(capture, "runtime/launch.mjs"),
  );
  await copyFile(join(directory, "rea.ps1"), join(capture, "rea.ps1"));
  await writeFile(
    join(capture, "app/scripts/rea.mjs"),
    "process.stdout.write(JSON.stringify({args:process.argv.slice(2),npm:process.env.npm_command??null}));process.exitCode=17;\n",
    "utf8",
  );
  const capturedArgs = [
    'text with "quotes" & ^ %REA_PORTABLE_PROBE% !',
    "C:\\has spaces\\",
    "",
    "中文",
    "literal !REA_PORTABLE_PROBE! and %REA_PORTABLE_PROBE%",
    'slash\\"quote',
    "line\nbreak",
    "tab\tvalue",
  ];
  reportStage("PowerShell literal arguments and exit status");
  await assert.rejects(powershell(capture, capturedArgs), (cause) => {
    assert.equal(cause.code, 17);
    assert.deepEqual(JSON.parse(cause.stdout), {
      args: capturedArgs,
      npm: null,
    });
    assert.equal(cause.stderr, "");
    return true;
  });
  reportStage("CLI help and offline setup/doctor");
  assert.match(
    (
      await executePortableBatchHelp(directory, {
        cwd: workspace,
        env: environment,
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout,
    /analyze-javascript-application/u,
  );
  assert.match(
    (await launcher(["--help"])).stdout,
    /analyze-javascript-application/u,
  );
  const planned = JSON.parse(
    (await launcher(["setup", "--client", "codex", "--dry-run", "--json"]))
      .stdout,
  );
  assert.equal(planned.status, "planned");
  const setupArgs = ["setup", "--client", "codex", "--yes", "--json"];
  const setup = JSON.parse((await launcher(setupArgs)).stdout);
  assert.equal(setup.status, "ready");
  const registration = parseToml(
    await readFile(join(workspace, ".codex/config.toml"), "utf8"),
  ).mcp_servers.rea;
  assert.equal(registration.command, node);
  assert.deepEqual(registration.args, [entry, "mcp"]);
  const doctor = JSON.parse(
    (await launcher(["doctor", "--client", "codex", "--skill", "--json"]))
      .stdout,
  );
  assert.equal(doctor.healthy, true);
  assert.equal(doctor.scope.mode, "explicit");
  assert.deepEqual(doctor.scope.clients, ["codex"]);
  assert.equal(doctor.scope.skill, true);
  assert.equal(doctor.identity.skill.state, "aligned");
  assert.equal(
    `v${doctor.checks.find(({ name }) => name === "node")?.details?.version}`,
    manifest.runtime.version,
  );
  assert.equal(
    doctor.identity.registrations.find(({ client }) => client === "codex")
      ?.state,
    "aligned",
  );
  const repeated = JSON.parse((await launcher(setupArgs)).stdout);
  assert.equal(repeated.status, "ready");
  assert.deepEqual(repeated.plannedActions, []);
  assert.deepEqual(repeated.appliedActions, []);
  const cli = JSON.parse(
    (await launcher(["analyze-javascript-application", sample, "--json"]))
      .stdout,
  );
  assert.equal(cli.operation, "analyze_javascript_application");
  const sessionHarness = join(workspace, "powershell-session.ps1");
  await writeFile(
    sessionHarness,
    `param([string]$Launcher, [string]$Sample, [string]$Mode, [string]$Passing)
$ErrorActionPreference = 'Stop'
if ($Passing) { $PSNativeCommandArgumentPassing = $Passing }
if ($Mode -eq 'argv') {
  $golden = Get-Content -LiteralPath $Sample -Raw -Encoding UTF8 | ConvertFrom-Json
  $beforeEncoding = [Console]::OutputEncoding.CodePage
  $beforeNpm = $env:npm_command
  $captured = & $Launcher @golden
  if ($LASTEXITCODE -ne 17) { throw 'Captured exit code changed' }
  if ($env:npm_command -ne $beforeNpm) { throw 'Caller npm context changed' }
  if ([Console]::OutputEncoding.CodePage -ne $beforeEncoding) { throw 'Caller encoding changed' }
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  [Console]::Out.WriteLine(($captured | ConvertFrom-Json | ConvertTo-Json -Compress))
  exit 0
}
Set-Location -LiteralPath $Sample
if ($Mode -eq 'relative') {
  & $Launcher analyze-javascript-application . --json
  exit $LASTEXITCODE
}
$captured = & $Launcher doctor --client codex --skill --json
if ($LASTEXITCODE -ne 0) { throw 'Captured doctor failed' }
if (@($captured).Count -eq 0) { throw 'PowerShell did not capture doctor output' }
$doctor = $captured | ConvertFrom-Json
if (-not $doctor.healthy) { throw 'Captured doctor was not healthy' }
$piped = & $Launcher doctor --client codex --skill --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $piped.healthy) { throw 'Piped doctor failed' }
[Console]::Out.WriteLine((@{ captured = $doctor.healthy; piped = $piped.healthy } | ConvertTo-Json -Compress))
`,
    "utf8",
  );
  const sessionPowerShell = (
    mode,
    root = directory,
    input = sample,
    passing = "",
  ) =>
    execute(
      powershellExecutable,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        sessionHarness,
        join(root, "rea.ps1"),
        input,
        mode,
        passing,
      ],
      {
        cwd: workspace,
        env: environment,
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
  const goldenPath = join(workspace, "argv.json");
  await writeFile(goldenPath, JSON.stringify(capturedArgs), "utf8");
  for (const passing of ["", "Legacy"]) {
    assert.deepEqual(
      JSON.parse(
        (await sessionPowerShell("argv", capture, goldenPath, passing)).stdout,
      ),
      { args: capturedArgs, npm: null },
    );
  }
  reportStage("PowerShell session working directory and output capture");
  const relative = JSON.parse((await sessionPowerShell("relative")).stdout);
  assert.deepEqual(relative.normalized_result, cli.normalized_result);
  assert.deepEqual(JSON.parse((await sessionPowerShell("capture")).stdout), {
    captured: true,
    piped: true,
  });
  for (const invocation of [
    { command: node, args: [entry, "mcp"] },
    ...["mcp", "--mcp"].map((mode) => ({
      command: powershellExecutable,
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(directory, "rea.ps1"),
        mode,
      ],
    })),
  ]) {
    const client = new Client({
      name: "rea-portable-verifier",
      version: "1.0.0",
    });
    reportStage(`MCP ${invocation.command} ${invocation.args.at(-1)}`);
    const transport = new StdioClientTransport({
      ...invocation,
      env: environment,
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.ok(
        tools.tools.some(
          ({ name }) => name === "analyze_javascript_application",
        ),
      );
      const result = await client.callTool({
        name: "analyze_javascript_application",
        arguments: { input_path: sample },
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const payload =
        result.structuredContent ??
        JSON.parse(result.content.find(({ type }) => type === "text").text);
      assert.equal(payload.operation, "analyze_javascript_application");
      assert.deepEqual(payload.normalized_result, cli.normalized_result);
      await client.ping();
    } finally {
      await client.close();
    }
  }
  assert.equal(await readFile(join(sample, "app.js"), "utf8"), source);
  reportStage("offline uninstall and cleanup");
  const uninstalled = JSON.parse(
    (await launcher(["uninstall", "--json"])).stdout,
  );
  assert.equal(uninstalled.status, "complete");
  for (const name of ["codex", "skill"])
    assert.equal(
      uninstalled.items.find((item) => item.name === name)?.status,
      "removed",
      `Portable uninstall must remove ${name}`,
    );
  const config = parseToml(
    await readFile(join(workspace, ".codex/config.toml"), "utf8"),
  );
  assert.equal(config.mcp_servers?.rea, undefined);
  await assert.rejects(
    readFile(
      join(workspace, ".agents/skills/reverse-engineer-anything/SKILL.md"),
    ),
    { code: "ENOENT" },
    "Portable uninstall must remove the installed skill manifest",
  );
  complete = true;
} finally {
  if (complete) await rm(workspace, { recursive: true, force: true });
  else
    console.error(
      `Verification did not complete; retained workspace: ${workspace}`,
    );
}
console.log(
  JSON.stringify({
    ok: true,
    directory,
    files: manifest.files.length,
    cli: true,
    mcp: true,
    offlineDoctor: true,
    nodeSocketConnections: "denied",
    externalProviders: "not exercised",
  }),
);
