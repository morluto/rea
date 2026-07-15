import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { TOOL_CONTRACTS } from "../dist/contracts/toolContracts.js";
import * as prompts from "./verify-package-prompts.mjs";
import { verifyPackagedInvestigation } from "./verify-package-investigation.mjs";
import { verifyPackedBridge } from "./verify-packed-bridge.mjs";

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
  await verifyPackedBridge({ root, workspace, tarball, packedFiles });
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
  const codexDir = join(home, ".codex");
  const cursorDir = join(home, ".cursor");
  await Promise.all([
    mkdir(claudeDir, { recursive: true }),
    mkdir(codexDir, { recursive: true }),
    mkdir(cursorDir, { recursive: true }),
  ]);
  const claudeConfig = join(claudeDir, "claude_desktop_config.json");
  const codexConfig = join(codexDir, "config.toml");
  const codexTarget = join(home, "managed-codex.toml");
  const cursorConfig = join(cursorDir, "mcp.json");
  const cursorTarget = join(home, "managed-cursor.json");
  await writeFile(claudeConfig, '{"existing":true}\n');
  await writeFile(codexTarget, 'model = "gpt-5"\n');
  await writeFile(cursorTarget, '{"existing":true}\n');
  await symlink(codexTarget, codexConfig);
  await symlink(cursorTarget, cursorConfig);
  const environment = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    REA_ANALYSIS_PROVIDER: "auto",
    HOPPER_LAUNCHER_PATH: process.execPath,
    HOPPER_LOADER_ARGS_JSON: JSON.stringify([
      join(root, "tests/fixtures/fakeLauncher.mjs"),
    ]),
    REA_NPX_LOG: npxLog,
    REA_EVIDENCE_ROOTS_JSON: JSON.stringify([evidenceRoot]),
    REA_INVESTIGATION_INPUT_ROOTS_JSON: JSON.stringify([workspace]),
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
  const doctorExecution = await runWithStatus(
    cli,
    ["doctor", "--json"],
    environment,
  );
  const doctor = json(doctorExecution.stdout);
  const supportedSetupHost =
    doctor.checks?.find(({ name }) => name === "host")?.ok === true;
  const expectedDoctorHealth = doctor.checks?.every(({ ok }) => ok) === true;
  if (
    !help.includes("setup") ||
    !help.includes("upgrade") ||
    !help.includes("inventory-artifact") ||
    !help.includes("extract-artifact") ||
    !help.includes("investigate-versions") ||
    !help.includes("import-reference-source") ||
    !help.includes("list-browser-targets") ||
    !help.includes("inspect-web-page") ||
    !help.includes("compare") ||
    !llms.includes("decompile") ||
    !llms.includes("function") ||
    !llms.includes("search") ||
    !llms.includes("inspect") ||
    !llms.includes("xrefs") ||
    !llms.includes("trace") ||
    !llms.includes("capabilities") ||
    !llms.includes("providers") ||
    !llms.includes("inventory-artifact") ||
    !llms.includes("list-browser-targets") ||
    !llms.includes("inspect-web-page") ||
    doctor.healthy !== expectedDoctorHealth ||
    doctorExecution.status !== (expectedDoctorHealth ? 0 : 1) ||
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
  // prettier-ignore
  const investigationReplay = await verifyPackagedInvestigation({ cli, workspace, evidenceRoot, artifactArchive, environment });
  const unknownProviderExecution = await runWithStatus(
    cli,
    ["analyze", process.execPath, "--provider", "missing-provider", "--json"],
    environment,
  );
  const unknownProvider = json(unknownProviderExecution.stdout);
  if (
    unknownProviderExecution.status !== 1 ||
    unknownProvider.details?.selection_reason !== "unknown_provider" ||
    unknownProvider.details?.requested_provider_id !== "missing-provider"
  )
    throw new Error(
      `packaged CLI provider selection failed: ${JSON.stringify(unknownProvider)}`,
    );
  if (process.platform === "linux") {
    const unsupportedExecution = await runWithStatus(
      cli,
      ["analyze", process.execPath, "--json"],
      environment,
    );
    const unsupported = json(unsupportedExecution.stdout);
    if (
      unsupportedExecution.status !== 1 ||
      unsupported.details?.failure_code !== "unsupported_hopper_build"
    )
      throw new Error(
        `packaged Linux Hopper verification did not fail closed: ${JSON.stringify(unsupported)}`,
      );
  } else {
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
    const inspected = json(
      await run(
        cli,
        [
          "inspect",
          process.execPath,
          "--detail",
          "detailed",
          "--limit",
          "1",
          "--json",
        ],
        environment,
      ),
    );
    if (
      inspected.operation !== "binary_overview" ||
      inspected.normalized_result?.detail !== "detailed"
    )
      throw new Error("packaged inspect CLI failed");
    const functionResult = json(
      await run(
        cli,
        ["function", process.execPath, "0x1000", "--json"],
        environment,
      ),
    );
    if (
      functionResult.operation !== "analyze_function" ||
      functionResult.provider?.id !== "hopper" ||
      functionResult.normalized_result?.procedure?.address !== "0x1000"
    )
      throw new Error(
        `packaged function CLI failed: ${JSON.stringify(functionResult)}`,
      );
    const xrefs = json(
      await run(
        cli,
        ["xrefs", process.execPath, "0x1000", "--json"],
        environment,
      ),
    );
    if (
      xrefs.operation !== "xrefs" ||
      JSON.stringify(xrefs.normalized_result) !== JSON.stringify(["0x1000"])
    )
      throw new Error(`packaged xrefs CLI failed: ${JSON.stringify(xrefs)}`);
    const trace = json(
      await run(
        cli,
        ["trace", process.execPath, "fixture", "--json"],
        environment,
      ),
    );
    if (trace.operation !== "trace_feature")
      throw new Error(`packaged trace CLI failed: ${JSON.stringify(trace)}`);
  }
  const capabilities = json(
    await run(cli, ["capabilities", "--json"], environment),
  );
  if (!Array.isArray(capabilities.capabilities))
    throw new Error("packaged capabilities CLI failed");
  const providers = json(await run(cli, ["providers", "--json"], environment));
  if (
    !Array.isArray(providers.providers) ||
    providers.providers.some(({ id }) => typeof id !== "string") ||
    providers.analysis_provider_binding !== null ||
    providers.analysis_provider_candidates?.find(
      ({ provider }) => provider?.id === "hopper",
    )?.target_support?.status !== "unknown"
  )
    throw new Error("packaged providers CLI failed");
  if (process.platform !== "linux") {
    const searchResult = json(
      await run(
        cli,
        ["search", process.execPath, "fixture", "--json"],
        environment,
      ),
    );
    if (
      searchResult.operation !== "search_strings" ||
      searchResult.normalized_result?.items?.length !== 1
    )
      throw new Error(
        `packaged search CLI failed: ${JSON.stringify(searchResult)}`,
      );
  }
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
  const comparedBundle = json(
    await run(
      cli,
      ["compare", sourceBundlePath, canonicalBundlePath, "--json"],
      environment,
    ),
  );
  if (
    importedBundle.imported !== 1 ||
    importedBundle.total !== 1 ||
    exportedBundle.records !== 1 ||
    (await readFile(canonicalBundlePath, "utf8")) !==
      serializeEvidenceBundle(sourceBundle) ||
    comparedBundle.status !== "unchanged" ||
    comparedBundle.summary?.records_unchanged !== 1
  )
    throw new Error(
      "packaged CLI evidence bundle comparison round trip failed",
    );
  await run(cli, ["mcp", "add"], environment);
  const mcpRegistration = await readFile(npxLog, "utf8");
  if (!mcpRegistration.includes("add-mcp npx -y rea-agents mcp --name rea"))
    throw new Error("Incur mcp add did not register the floating npx command");
  const skillPath = join(home, ".agents/skills/rea-analysis/SKILL.md");
  const siblingSkillPath = join(home, ".agents/skills/unrelated/SKILL.md");
  if (supportedSetupHost) {
    await mkdir(join(home, ".agents/skills/rea-analysis"), {
      recursive: true,
    });
    await mkdir(join(home, ".agents/skills/unrelated"), { recursive: true });
    await writeFile(skillPath, "stale managed skill\n");
    await writeFile(siblingSkillPath, "unrelated skill\n");
  }
  const plannedExecution = await runWithStatus(
    cli,
    ["setup", "--json"],
    environment,
  );
  const planned = json(plannedExecution.stdout);
  if (supportedSetupHost) {
    const plannedClaudeConfig = await readFile(claudeConfig, "utf8");
    const plannedCodexConfig = await readFile(codexTarget, "utf8");
    const plannedCursorConfig = await readFile(cursorConfig, "utf8");
    const plannedSkill = await readFile(skillPath, "utf8");
    if (
      planned.status !== "needs_confirmation" ||
      plannedExecution.status !== 1 ||
      planned.appliedActions.length !== 0 ||
      !planned.plannedActions.some(({ kind }) => kind === "configure_client") ||
      !planned.plannedActions.some(({ kind }) => kind === "install_skill") ||
      plannedClaudeConfig !== '{"existing":true}\n' ||
      plannedCodexConfig !== 'model = "gpt-5"\n' ||
      plannedCursorConfig !== '{"existing":true}\n' ||
      plannedSkill !== "stale managed skill\n"
    )
      throw new Error(
        `packaged setup plan was not read-only: ${JSON.stringify({ status: planned.status, exitCode: plannedExecution.status, plannedKinds: planned.plannedActions.map(({ kind }) => kind), appliedKinds: planned.appliedActions.map(({ kind }) => kind), claudeConfig: plannedClaudeConfig, codexConfig: plannedCodexConfig, cursorConfig: plannedCursorConfig, skill: plannedSkill })}`,
      );
  }
  const firstExecution = await runWithStatus(
    cli,
    ["setup", "--yes", "--json"],
    environment,
  );
  const first = json(firstExecution.stdout);
  const alignedExecution = await runWithStatus(
    cli,
    ["setup", "--json"],
    environment,
  );
  const aligned = json(alignedExecution.stdout);
  const secondExecution = await runWithStatus(
    cli,
    ["setup", "--install-hopper", "--json"],
    environment,
  );
  const second = json(secondExecution.stdout);
  if (supportedSetupHost) {
    const status = process.platform === "linux" ? "needs_human" : "ready";
    if (
      first.status !== status ||
      second.status !== "needs_confirmation" ||
      firstExecution.status !== (status === "ready" ? 0 : 1) ||
      secondExecution.status !== 1 ||
      aligned.status !== status ||
      alignedExecution.status !== (status === "ready" ? 0 : 1) ||
      aligned.plannedActions.length !== 0 ||
      aligned.appliedActions.length !== 0 ||
      !second.plannedActions.some(({ kind }) => kind === "install_hopper") ||
      second.appliedActions.length !== 0
    )
      throw new Error(
        `packaged setup did not preserve idempotent defaults and explicit Hopper reinstall behavior: ${JSON.stringify({ first, aligned, second })}`,
      );
    for (const configPath of [claudeConfig, cursorConfig]) {
      const config = json(await readFile(configPath, "utf8"));
      if (
        config.existing !== true ||
        config.mcpServers?.rea?.command !== cli ||
        JSON.stringify(config.mcpServers?.rea?.args) !== JSON.stringify(["mcp"])
      )
        throw new Error("packaged client readback failed");
      if (
        !(await readFile(`${configPath}.rea.backup`, "utf8")).includes(
          "existing",
        )
      )
        throw new Error("packaged client backup failed");
    }
    const codex = await readFile(codexTarget, "utf8");
    if (
      !(await lstat(codexConfig)).isSymbolicLink() ||
      !(await lstat(cursorConfig)).isSymbolicLink() ||
      !codex.includes("[mcp_servers.rea]") ||
      !codex.includes(`command = "${cli}"`) ||
      (await readFile(`${codexConfig}.rea.backup`, "utf8")) !==
        'model = "gpt-5"\n' ||
      (await readFile(`${cursorConfig}.rea.backup`, "utf8")) !==
        '{"existing":true}\n'
    )
      throw new Error("packaged setup did not preserve config symlinks");
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

    await writeFile(claudeConfig, "malformed");
    await writeFile(cursorConfig, '{"existing":true}\n');
    const failedExecution = await runWithStatus(
      cli,
      ["setup", "--yes", "--json"],
      environment,
    );
    const failed = json(failedExecution.stdout);
    if (
      failed.status !== "needs_human" ||
      failedExecution.status !== 1 ||
      failed.clients?.claude_desktop?.status !== "failed" ||
      failed.clients?.cursor?.status !== "configured" ||
      !failed.appliedActions.includes("configured_cursor") ||
      (await readFile(claudeConfig, "utf8")) !== "malformed" ||
      json(await readFile(cursorConfig, "utf8")).mcpServers?.rea?.command !==
        cli
    )
      throw new Error(
        `packaged setup did not continue after an earlier client failure: ${JSON.stringify(failed)}`,
      );
    await writeFile(claudeConfig, "{}\n");
    const recoveredExecution = await runWithStatus(
      cli,
      ["setup", "--yes", "--json"],
      environment,
    );
    const recovered = json(recoveredExecution.stdout);
    if (
      recovered.status !== status ||
      recoveredExecution.status !== (status === "ready" ? 0 : 1)
    )
      throw new Error("packaged setup did not recover");

    const geminiDir = join(home, ".gemini");
    const geminiConfig = join(geminiDir, "settings.json");
    await mkdir(geminiDir, { recursive: true });
    await symlink(join(home, "missing-gemini.json"), geminiConfig);
    const danglingExecution = await runWithStatus(
      cli,
      ["setup", "--yes", "--json"],
      environment,
    );
    const dangling = json(danglingExecution.stdout);
    if (
      dangling.status !== "needs_human" ||
      danglingExecution.status !== 1 ||
      dangling.clients?.gemini_cli?.status !== "failed" ||
      dangling.clients?.gemini_cli?.reason !== "path" ||
      !(await lstat(geminiConfig)).isSymbolicLink() ||
      (await pathExists(`${geminiConfig}.rea.backup`))
    )
      throw new Error(
        `packaged setup did not reject a dangling config symlink before mutation: ${JSON.stringify(dangling)}`,
      );
    await rm(geminiDir, { recursive: true });

    const uninstallExecution = await runWithStatus(
      cli,
      ["uninstall", "--json"],
      environment,
    );
    const uninstall = json(uninstallExecution.stdout);
    const cursorAfterUninstall = json(await readFile(cursorTarget, "utf8"));
    const codexAfterUninstall = await readFile(codexTarget, "utf8");
    if (
      uninstall.status !== "complete" ||
      uninstallExecution.status !== 0 ||
      uninstall.items?.find(({ name }) => name === "cursor")?.status !==
        "removed" ||
      uninstall.items?.find(({ name }) => name === "codex")?.status !==
        "removed" ||
      !(await lstat(cursorConfig)).isSymbolicLink() ||
      !(await lstat(codexConfig)).isSymbolicLink() ||
      cursorAfterUninstall.existing !== true ||
      cursorAfterUninstall.mcpServers?.rea !== undefined ||
      !codexAfterUninstall.includes('model = "gpt-5"') ||
      codexAfterUninstall.includes("mcp_servers.rea") ||
      !(await readFile(`${cursorConfig}.rea.backup`, "utf8")).includes(
        '"rea"',
      ) ||
      !(await readFile(`${codexConfig}.rea.backup`, "utf8")).includes(
        "[mcp_servers.rea]",
      )
    )
      throw new Error(
        `packaged uninstall did not preserve config symlinks: ${JSON.stringify(uninstall)}`,
      );
  } else if (
    first.status !== "needs_human" ||
    aligned.status !== "needs_human" ||
    second.status !== "needs_human"
  ) {
    throw new Error("packaged setup did not reject an unsupported host");
  }

  const transport = new StdioClientTransport({
    command: cli,
    args: ["mcp"],
    env: {
      ...environment,
      REA_INVESTIGATION_INPUT_ROOTS_JSON: JSON.stringify([]),
    },
    stderr: "pipe",
  });
  let mcpStderr = "";
  transport.stderr?.on("data", (chunk) => {
    mcpStderr += chunk.toString();
  });
  const client = new Client({ name: "package-smoke", version: "1.0.0" });
  try {
    await client.connect(transport);
    const mcpOptions = { timeout: 15_000 };
    if (
      (await client.listTools(undefined, mcpOptions)).tools.length !==
      TOOL_CONTRACTS.length
    )
      throw new Error("packaged MCP tool inventory diverged from contracts");
    await prompts.verifyPromptCatalog(client, mcpOptions, prompts.names);
    await prompts.verifyPromptCompletion(client, mcpOptions, false);
    const replay = await client.callTool(
      {
        name: "find_changed_behavior",
        arguments: { investigation_run: investigationReplay.arguments },
      },
      mcpOptions,
    );
    const replayEvidence = json(prompts.mcpText(replay));
    const replayWorkspace = json(
      await readFile(investigationReplay.workspacePath, "utf8"),
    );
    if (
      replay.isError === true ||
      replayEvidence.evidence_id !== investigationReplay.evidenceId ||
      replayWorkspace.revision !== investigationReplay.revision
    )
      throw new Error(
        "packaged MCP did not replay with workspace-only authority",
      );
    const result = await client.callTool(
      { name: "current_document", arguments: {} },
      mcpOptions,
    );
    if (result.isError !== true)
      throw new Error("packaged target-free MCP omitted no-target error");
    const unknownProvider = await client.callTool(
      {
        name: "open_binary",
        arguments: { path: process.execPath, provider_id: "missing-provider" },
      },
      mcpOptions,
    );
    if (
      unknownProvider.isError !== true ||
      unknownProvider.structuredContent?.error?.details?.selection_reason !==
        "unknown_provider"
    )
      throw new Error("packaged MCP accepted an unknown analysis provider");
    const opened = await client.callTool(
      {
        name: "open_binary",
        arguments: { path: process.execPath, provider_id: "hopper" },
      },
      mcpOptions,
    );
    if (opened.isError === true)
      throw new Error("packaged MCP could not open a binary");
    const providerStatus = json(
      prompts.mcpText(
        await client.callTool(
          { name: "binary_session", arguments: {} },
          mcpOptions,
        ),
      ),
    );
    if (
      providerStatus.analysis_provider_binding?.provider?.id !== "hopper" ||
      providerStatus.analysis_provider_binding?.selection_source !== "request"
    )
      throw new Error("packaged MCP omitted its explicit Hopper binding");
    await prompts.verifyPromptCompletion(
      client,
      mcpOptions,
      process.platform !== "linux",
    );
    const current = await client.callTool(
      { name: "current_document", arguments: {} },
      mcpOptions,
    );
    if (process.platform === "linux") {
      if (
        current.isError !== true ||
        !prompts
          .mcpText(current)
          .includes("not supported for unattended Linux analysis")
      )
        throw new Error("packaged Linux MCP did not reject an unpinned Hopper");
    } else {
      if (json(prompts.mcpText(current)).normalized_result !== "fixture")
        throw new Error("packaged MCP bridge call failed");
      const batch = await client.callTool(
        { name: "batch_decompile", arguments: { addresses: ["0x1000"] } },
        mcpOptions,
      );
      const batchResult = json(prompts.mcpText(batch)).normalized_result;
      if (
        batch.isError === true ||
        batchResult?.total !== 1 ||
        batchResult?.succeeded !== 1 ||
        batchResult?.failed !== 0 ||
        batchResult?.items?.[0]?.status !== "ok" ||
        batchResult?.items?.[0]?.pseudocode !== "return 0;"
      )
        throw new Error("packaged MCP structured batch result failed");
    }
    const closed = await client.callTool(
      { name: "close_binary", arguments: {} },
      mcpOptions,
    );
    if (closed.isError === true)
      throw new Error("packaged MCP could not close its binary");
    await prompts.verifyPromptCompletion(client, mcpOptions, false);
    const mcpBundlePath = join(evidenceRoot, "mcp.json");
    const mcpExport = await client.callTool(
      { name: "export_evidence_bundle", arguments: { path: mcpBundlePath } },
      mcpOptions,
    );
    if (mcpExport.isError === true)
      throw new Error("packaged MCP evidence export failed");
    const mcpImport = await client.callTool(
      { name: "import_evidence_bundle", arguments: { path: mcpBundlePath } },
      mcpOptions,
    );
    if (mcpImport.isError === true)
      throw new Error("packaged MCP evidence import failed");
  } catch (cause) {
    throw new Error(`packaged MCP smoke failed: ${mcpStderr}`, { cause });
  } finally {
    await client.close();
    await transport.close();
  }

  process.stdout.write(
    `${JSON.stringify({ cli: true, analysisCli: true, artifactCli: true, evidenceCli: true, incurMcpCommand: "npx -y rea-agents mcp", doctor: "platform-appropriate", setup: supportedSetupHost ? "planned-then-idempotent" : "unsupported-host-rejected", setupPlanReadOnly: supportedSetupHost, existingHopperPreserved: supportedSetupHost, clients: supportedSetupHost ? 3 : 0, backupReadback: supportedSetupHost, failureRecovery: supportedSetupHost, configSymlinkLifecycle: supportedSetupHost, skill: supportedSetupHost, mcpTools: TOOL_CONTRACTS.length, mcpPrompts: prompts.names.length, promptCompletion: true, promptCompletionLifecycle: true, evidenceMcp: true, targetFree: true, targetLifecycle: true, boundedRegexBridge: true })}\n`,
  );
} finally {
  if (tarball) await rm(join(root, tarball), { force: true });
  await rm(workspace, { recursive: true, force: true });
}

async function run(command, args, env) {
  return (await exec(command, args, { env })).stdout;
}
async function runWithStatus(command, args, env) {
  try {
    return { stdout: await run(command, args, env), status: 0 };
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      cause.code === 1 &&
      typeof cause.stdout === "string"
    )
      return { stdout: cause.stdout, status: 1 };
    throw cause;
  }
}
function json(text) {
  return JSON.parse(text);
}
async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return false;
    throw cause;
  }
}
