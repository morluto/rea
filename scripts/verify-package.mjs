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
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { TOOL_CONTRACTS } from "../dist/contracts/toolContracts.js";

const expectedToolCount = TOOL_CONTRACTS.length;

// Exercise the packed artifact in isolated HOME and prefix directories so the
// verifier cannot mutate real MCP registrations or rely on checkout-only files.
const exec = promisify(execFile);
const root = process.cwd();
const workspace = await mkdtemp(join(tmpdir(), "rea-package-"));
const evidenceRoot = join(workspace, "evidence");
const referenceRoot = join(workspace, "reference-source");
let tarball;

try {
  tarball = (
    await exec("npm", ["pack", "--silent"], { cwd: root })
  ).stdout.trim();
  const packedFiles = (
    await exec("tar", ["-tf", join(root, tarball)])
  ).stdout.split("\n");
  if (
    packedFiles.some(
      (path) => path.includes("__pycache__") || path.endsWith(".pyc"),
    )
  ) {
    throw new Error("package contained generated Python bytecode");
  }
  const prefix = join(workspace, "prefix");
  const home = join(workspace, "home");
  const fakeBin = join(workspace, "bin");
  await mkdir(fakeBin, { recursive: true });
  await Promise.all([
    mkdir(evidenceRoot, { recursive: true }),
    mkdir(join(referenceRoot, "src"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(referenceRoot, "src", "main.ts"),
      'import "./dependency";\n',
    ),
    writeFile(
      join(referenceRoot, "src", "dependency.ts"),
      "export const value = 1;\n",
    ),
    writeFile(join(referenceRoot, ".env"), "PACKAGE_SECRET_SENTINEL=1\n"),
  ]);
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
    '#!/bin/sh\nprintf "%s\\n" "$*" > "$REA_NPX_LOG"\necho "│ ✓ Cursor: isolated │"\n',
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
    HOPPER_LAUNCHER_PATH: process.execPath,
    HOPPER_LOADER_ARGS_JSON: JSON.stringify([
      join(root, "tests/fixtures/fakeLauncher.mjs"),
    ]),
    REA_NPX_LOG: npxLog,
    REA_EVIDENCE_ROOTS_JSON: JSON.stringify([evidenceRoot]),
    REA_REFERENCE_ROOTS_JSON: JSON.stringify([referenceRoot]),
    REA_REFERENCE_SECRET_PATTERNS_JSON: JSON.stringify([".env"]),
  };
  await exec(
    "npm",
    ["install", "--global", "--prefix", prefix, join(root, tarball)],
    { env: environment },
  );
  const cli = join(prefix, "bin", "rea");
  const help = await run(cli, ["--help"], environment);
  const llms = await run(cli, ["--llms"], environment);
  const doctor = json(await run(cli, ["doctor", "--json"], environment));
  const expectedDoctorHealth = process.platform === "darwin";
  if (
    !help.includes("setup") ||
    !help.includes("inventory-artifact") ||
    !help.includes("extract-artifact") ||
    !help.includes("import-reference-source") ||
    !llms.includes("decompile") ||
    !llms.includes("inventory-artifact") ||
    doctor.healthy !== expectedDoctorHealth ||
    doctor.checks?.find(({ name }) => name === "hopper")?.ok !== true
  )
    throw new Error(
      `packaged CLI discovery or doctor failed: ${JSON.stringify({ helpSetup: help.includes("setup"), llmsDecompile: llms.includes("decompile"), doctor })}`,
    );
  const artifactArchive = join(workspace, "artifact.zip");
  const artifactWriter = new ZipWriter(new Uint8ArrayWriter());
  await artifactWriter.add("app/main.js", new TextReader("main();"));
  await writeFile(artifactArchive, await artifactWriter.close());
  const artifactInventory = json(
    await run(
      cli,
      ["inventory-artifact", artifactArchive, "--limit", "500", "--json"],
      environment,
    ),
  );
  if (
    artifactInventory.operation !== "inventory_artifact" ||
    artifactInventory.provider?.id !== "rea-artifact-graph" ||
    artifactInventory.normalized_result?.manifest?.root_format !== "zip"
  )
    throw new Error("packaged artifact inventory CLI failed");
  const overview = json(
    await run(cli, ["analyze", process.execPath, "--json"], environment),
  );
  if (
    overview.operation !== "binary_overview" ||
    overview.normalized_result?.procedure_count < 1
  )
    throw new Error(
      `packaged Hopper-backed analyze CLI failed: ${JSON.stringify(overview)}`,
    );
  const referenceImport = json(
    await run(
      cli,
      ["import-reference-source", referenceRoot, "--json"],
      environment,
    ),
  );
  if (
    referenceImport.authority !== "historical-reference" ||
    referenceImport.root_alias !== "$REFERENCE_ROOT" ||
    referenceImport.relationships?.[0]?.resolution !== "internal" ||
    JSON.stringify(referenceImport).includes("PACKAGE_SECRET_SENTINEL")
  )
    throw new Error("packaged historical reference import CLI failed");
  const { createEvidence } = await import(
    new URL("../dist/domain/evidence.js", import.meta.url)
  );
  const { createEvidenceBundle, serializeEvidenceBundle } = await import(
    new URL("../dist/domain/evidenceBundle.js", import.meta.url)
  );
  const sourceBundle = createEvidenceBundle([
    createEvidence(
      undefined,
      { id: "package", name: "Package verifier", version: "1" },
      { operation: "health", parameters: {}, result: true },
    ),
  ]);
  const sourceBundlePath = join(evidenceRoot, "source.json");
  const canonicalBundlePath = join(evidenceRoot, "canonical.json");
  await writeFile(sourceBundlePath, serializeEvidenceBundle(sourceBundle));
  const importedBundle = json(
    await run(
      cli,
      ["evidence-import", sourceBundlePath, "--json"],
      environment,
    ),
  );
  const exportedBundle = json(
    await run(
      cli,
      ["evidence-export", sourceBundlePath, canonicalBundlePath, "--json"],
      environment,
    ),
  );
  if (
    importedBundle.imported !== 1 ||
    importedBundle.total !== 1 ||
    exportedBundle.records !== 1 ||
    (await readFile(canonicalBundlePath, "utf8")) !==
      serializeEvidenceBundle(sourceBundle)
  )
    throw new Error("packaged CLI evidence bundle round trip failed");
  await run(cli, ["mcp", "add"], environment);
  const mcpRegistration = await readFile(npxLog, "utf8");
  if (!mcpRegistration.includes("add-mcp npx -y rea-agents mcp --name rea"))
    throw new Error("Incur mcp add did not register the floating npx command");
  const skillPath = join(home, ".agents/skills/rea-analysis/SKILL.md");
  const siblingSkillPath = join(home, ".agents/skills/unrelated/SKILL.md");
  if (process.platform === "darwin") {
    await mkdir(join(home, ".agents/skills/rea-analysis"), {
      recursive: true,
    });
    await mkdir(join(home, ".agents/skills/unrelated"), { recursive: true });
    await writeFile(skillPath, "stale managed skill\n");
    await writeFile(siblingSkillPath, "unrelated skill\n");
  }
  const first = json(await run(cli, ["setup", "--yes", "--json"], environment));
  const second = json(
    await run(cli, ["setup", "--yes", "--json"], environment),
  );
  if (process.platform === "darwin") {
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
        config.mcpServers?.rea?.command !== "npx" ||
        JSON.stringify(config.mcpServers?.rea?.args) !==
          JSON.stringify(["-y", "rea-agents", "mcp"])
      )
        throw new Error("packaged client readback failed");
      if (
        !(await readFile(`${configPath}.rea.backup`, "utf8")).includes(
          "existing",
        )
      )
        throw new Error("packaged client backup failed");
    }
    const skill = await readFile(skillPath, "utf8");
    const canonicalSkill = await readFile(
      join(root, "skills/rea-analysis/SKILL.md"),
      "utf8",
    );
    if (skill !== canonicalSkill)
      throw new Error("packaged skill did not match its canonical source");
    if (
      (await readFile(`${skillPath}.rea.backup`, "utf8")) !==
        "stale managed skill\n" ||
      (await readFile(siblingSkillPath, "utf8")) !== "unrelated skill\n"
    )
      throw new Error("packaged stale-skill upgrade was not isolated");

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
  } else if (
    first.status !== "needs_human" ||
    second.status !== "needs_human"
  ) {
    throw new Error("packaged setup did not reject an unsupported host");
  }

  const transport = new StdioClientTransport({
    command: cli,
    args: ["mcp"],
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
    if ((await client.listTools()).tools.length !== expectedToolCount)
      throw new Error("packaged MCP tool inventory diverged from contracts");
    const result = await client.callTool({
      name: "current_document",
      arguments: {},
    });
    if (result.isError !== true)
      throw new Error("packaged target-free MCP omitted no-target error");
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path: process.execPath },
    });
    if (opened.isError === true)
      throw new Error("packaged MCP could not open a binary");
    const overviewResult = await client.callTool({
      name: "binary_overview",
      arguments: {},
    });
    if (
      overviewResult.isError === true ||
      json(text(overviewResult)).normalized_result?.procedure_count < 1
    )
      throw new Error("packaged MCP analysis workflow failed");
    const closed = await client.callTool({
      name: "close_binary",
      arguments: {},
    });
    if (closed.isError === true)
      throw new Error("packaged MCP could not close its binary");
    const mcpBundlePath = join(evidenceRoot, "mcp.json");
    const mcpExport = await client.callTool({
      name: "export_evidence_bundle",
      arguments: { path: mcpBundlePath },
    });
    if (mcpExport.isError === true)
      throw new Error("packaged MCP evidence export failed");
    const mcpImport = await client.callTool({
      name: "import_evidence_bundle",
      arguments: { path: mcpBundlePath },
    });
    if (mcpImport.isError === true)
      throw new Error("packaged MCP evidence import failed");
  } catch (cause) {
    throw new Error(`packaged MCP smoke failed: ${mcpStderr}`, { cause });
  } finally {
    await client.close();
    await transport.close();
  }

  process.stdout.write(
    `${JSON.stringify({ cli: true, analysisCli: true, artifactCli: true, evidenceCli: true, incurMcpCommand: "npx -y rea-agents mcp", doctor: "platform-appropriate", setup: process.platform === "darwin" ? "idempotent" : "unsupported-host-rejected", clients: process.platform === "darwin" ? 2 : 0, backupReadback: process.platform === "darwin", failureRecovery: process.platform === "darwin", skill: process.platform === "darwin", mcpTools: expectedToolCount, evidenceMcp: true, targetFree: true, targetLifecycle: true })}\n`,
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

function text(result) {
  const value = result.content?.find((item) => item.type === "text")?.text;
  if (typeof value !== "string") throw new Error("MCP result omitted text");
  return value;
}
