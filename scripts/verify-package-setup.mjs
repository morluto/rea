import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { spawn } from "@lydell/node-pty";

import { TOOL_CONTRACTS } from "../dist/contracts/toolContracts.js";
import { PRODUCT_IDENTITY } from "../dist/identity.js";
import {
  json,
  pathExists,
  run,
  runWithStatus,
} from "./lib/verify-package-core.mjs";
import { parse as parseJsonc } from "jsonc-parser";
import { skillReferenceIssues } from "./lib/docs-facts.mjs";

const OPENCODE_ORIGINAL = `{
  // OpenCode preferences must survive setup.
  "model": "provider/model",
  "mcp": {
    // Keep this independently managed server.
    "other": { "type": "local", "command": ["node", "other.js"] },
  },
}\n`;

const verifyMcpAdd = async ({ cli, environment, npxLog }) => {
  await run(cli, ["mcp", "add"], environment);
  const mcpRegistration = await readFile(npxLog, "utf8");
  const expected = `add-mcp npx -y ${PRODUCT_IDENTITY.registrationPackageSpecifier} mcp --name rea`;
  if (!mcpRegistration.includes(expected))
    throw new Error("Incur mcp add did not register the pinned npx command");
};

const snapshotFiles = async (paths) =>
  Promise.all(
    paths.map(async (path) => {
      const exists = await pathExists(path);
      return {
        path,
        exists,
        content: exists ? await readFile(path, "utf8") : null,
      };
    }),
  );

const assertFilesUnchanged = async (snapshot, label) => {
  for (const entry of snapshot) {
    const exists = await pathExists(entry.path);
    const content = exists ? await readFile(entry.path, "utf8") : null;
    if (exists !== entry.exists || content !== entry.content)
      throw new Error(`${label} changed ${entry.path}`);
  }
};

const verifyInteractiveSetup = async ({
  command,
  environment,
  root,
  unchangedPaths,
}) =>
  new Promise((resolvePromise, reject) => {
    let output = "";
    let cancelled = false;
    let settled = false;
    const unchanged = snapshotFiles(unchangedPaths);
    const wrapper = `
      const { spawnSync } = require("node:child_process");
      const child = spawnSync(process.argv[1], ["setup"], { stdio: "inherit", env: process.env, shell: process.platform === "win32" });
      const terminal = process.platform === "win32"
        ? spawnSync("cmd.exe", ["/c", "mode", "CON"], { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] })
        : spawnSync("stty", ["-a"], { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });
      process.stdout.write("\\n__REA_SETUP_EXIT__" + JSON.stringify({ status: child.status, termios: terminal.stdout, error: child.error?.message }));
      process.exit(child.status ?? 1);
    `;
    const terminal = spawn(process.execPath, ["-e", wrapper, command], {
      cwd: root,
      env: { ...environment, NO_COLOR: "1", TERM: "xterm-256color" },
      name: "xterm-256color",
      cols: 120,
      rows: 40,
    });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error === undefined) resolvePromise();
      else reject(error);
    };
    const timeout = setTimeout(() => {
      terminal.kill();
      finish(
        new Error(`packaged setup wizard timed out after output: ${output}`),
      );
    }, 20_000);

    terminal.onData((data) => {
      output += data;
      if (!cancelled && output.includes("Which agents should use REA?")) {
        cancelled = true;
        terminal.write("\u0003");
      }
    });
    terminal.onExit(async ({ exitCode }) => {
      const marker = output.lastIndexOf("__REA_SETUP_EXIT__");
      const result = marker < 0 ? undefined : output.slice(marker + 18).trim();
      let childResult;
      try {
        childResult = result === undefined ? undefined : JSON.parse(result);
      } catch {
        childResult = undefined;
      }
      if (
        !cancelled ||
        exitCode !== 0 ||
        childResult?.status !== 0 ||
        !output.includes("\u001b[?25h") ||
        (process.platform !== "win32" &&
          (!childResult.termios?.includes("icanon") ||
            !childResult.termios?.includes("echo"))) ||
        !output.includes("No changes were made.")
      ) {
        finish(
          new Error(
            `packaged rea-agents setup did not cancel with a restored terminal and exit 0: ${output}`,
          ),
        );
        return;
      }
      try {
        await assertFilesUnchanged(await unchanged, "Interactive cancellation");
        finish();
      } catch (error) {
        finish(error);
      }
    });
  });

const verifyRedirectedStdoutSetup = async ({
  command,
  environment,
  root,
  unchangedPaths,
}) =>
  new Promise((resolvePromise, reject) => {
    let output = "";
    let settled = false;
    const unchanged = snapshotFiles(unchangedPaths);
    const wrapper = `
      const { spawnSync } = require("node:child_process");
      const child = spawnSync(process.argv[1], ["setup"], { encoding: "utf8", env: process.env, stdio: ["inherit", "pipe", "inherit"], shell: process.platform === "win32" });
      process.stdout.write("\\n__REA_REDIRECTED_SETUP__" + JSON.stringify({ status: child.status, stdout: child.stdout, error: child.error?.message, stdinTTY: process.stdin.isTTY, stderrTTY: process.stderr.isTTY, stdoutRedirected: true }));
      process.exit(child.status ?? 1);
    `;
    const terminal = spawn(process.execPath, ["-e", wrapper, command], {
      cwd: root,
      env: { ...environment, NO_COLOR: "1", TERM: "xterm-256color" },
      name: "xterm-256color",
      cols: 120,
      rows: 40,
    });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error === undefined) resolvePromise();
      else reject(error);
    };
    const timeout = setTimeout(() => {
      terminal.kill();
      finish(
        new Error(
          `packaged setup started an interactive prompt with redirected stdout: ${output}`,
        ),
      );
    }, 15_000);
    terminal.onData((data) => {
      output += data;
    });
    terminal.onExit(async ({ exitCode }) => {
      const marker = output.lastIndexOf("__REA_REDIRECTED_SETUP__");
      let childResult;
      try {
        childResult =
          marker < 0 ? undefined : JSON.parse(output.slice(marker + 24).trim());
      } catch {
        childResult = undefined;
      }
      const allOutput = `${output}\n${childResult?.stdout ?? ""}`;
      if (
        (exitCode !== 0 && exitCode !== 1) ||
        childResult?.status !== exitCode ||
        childResult.stdinTTY !== true ||
        childResult.stderrTTY !== true ||
        childResult.stdoutRedirected !== true ||
        childResult.stdout?.includes("Which agents should use REA?") ||
        allOutput.includes("Which agents should use REA?") ||
        /\u001b\[[0-9;?]*[ -/]*[@-~]/u.test(allOutput)
      ) {
        finish(
          new Error(
            `packaged setup did not remain plain and non-interactive with redirected stdout: ${output}`,
          ),
        );
        return;
      }
      try {
        await assertFilesUnchanged(await unchanged, "Redirected-stdout setup");
        finish();
      } catch (error) {
        finish(error);
      }
    });
  });

const verifySetupPlan = async ({
  cli,
  environment,
  claudeConfig,
  cursorConfig,
  codexTarget,
  opencodeConfig,
  opencodeOriginal,
  supportedSetupHost,
}) => {
  const plannedExecution = await runWithStatus(
    cli,
    ["setup", "--all-detected", "--dry-run", "--json"],
    environment,
  );
  const planned = json(plannedExecution.stdout);
  if (supportedSetupHost) {
    const plannedClaudeConfig = await readFile(claudeConfig, "utf8");
    const plannedCodexConfig = await readFile(codexTarget, "utf8");
    const plannedCursorConfig = await readFile(cursorConfig, "utf8");
    const plannedOpenCodeConfig = await readFile(opencodeConfig, "utf8");
    if (
      planned.status !== "planned" ||
      plannedExecution.status !== 0 ||
      planned.appliedActions.length !== 0 ||
      !planned.plannedActions.some(({ kind }) => kind === "configure_client") ||
      !planned.plannedActions.some(({ kind }) => kind === "install_skill") ||
      plannedClaudeConfig !== '{"existing":true}\n' ||
      plannedCodexConfig !== 'model = "gpt-5"\n' ||
      plannedCursorConfig !== '{"existing":true}\n' ||
      plannedOpenCodeConfig !== opencodeOriginal
    )
      throw new Error(
        `packaged setup plan was not read-only: ${JSON.stringify({ status: planned.status, exitCode: plannedExecution.status, plannedKinds: planned.plannedActions.map(({ kind }) => kind), appliedKinds: planned.appliedActions.map(({ kind }) => kind), claudeConfig: plannedClaudeConfig, codexConfig: plannedCodexConfig, cursorConfig: plannedCursorConfig })}`,
      );
  }
  return { planned };
};

const verifyAbsentOpenCodeSetup = async ({ cli, environment, home }) => {
  const xdgConfigHome = join(home, ".xdg-opencode-absent");
  const configPath = join(xdgConfigHome, "opencode", "opencode.json");
  if (await pathExists(configPath))
    throw new Error("packaged OpenCode first-run fixture was not absent");
  const execution = await runWithStatus(
    cli,
    ["setup", "--yes", "--client", "opencode", "--skill=false", "--json"],
    { ...environment, XDG_CONFIG_HOME: xdgConfigHome },
  );
  const result = json(execution.stdout);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (
    execution.status !== 0 ||
    result.status !== "ready" ||
    !result.appliedActions.includes("configured_opencode") ||
    config.mcp?.rea?.type !== "local" ||
    config.mcp.rea.enabled !== true ||
    JSON.stringify(config.mcp.rea.command) !== JSON.stringify([cli, "mcp"])
  )
    throw new Error(
      `packaged setup did not configure explicitly selected OpenCode without a config file: ${JSON.stringify(result)}`,
    );
  await rm(xdgConfigHome, { recursive: true, force: true });
};

const verifyAbsentClaudeCodeSetup = async ({ cli, environment, home }) => {
  const freshHome = join(home, ".claude-code-absent-home");
  const configPath = join(freshHome, ".claude.json");
  const markerPath = join(freshHome, ".claude");
  await rm(freshHome, { recursive: true, force: true });
  await mkdir(freshHome, { recursive: true });
  const childEnvironment = {
    ...environment,
    HOME: freshHome,
    USERPROFILE: freshHome,
    XDG_CONFIG_HOME: join(freshHome, ".config"),
  };
  delete childEnvironment.CLAUDE_CONFIG_DIR;
  if ((await pathExists(configPath)) || (await pathExists(markerPath)))
    throw new Error("packaged Claude Code first-run fixture was not absent");
  const args = [
    "setup",
    "--yes",
    "--client",
    "claude_code",
    "--skill=false",
    "--json",
  ];
  const firstExecution = await runWithStatus(cli, args, childEnvironment);
  const first = json(firstExecution.stdout);
  const config = json(await readFile(configPath, "utf8"));
  const registration = first.doctor.identity?.registrations?.find(
    ({ client }) => client === "claude_code",
  );
  if (
    firstExecution.status !== 0 ||
    first.status !== "ready" ||
    !first.appliedActions.includes("configured_claude_code") ||
    config.mcpServers?.rea?.command !== cli ||
    JSON.stringify(config.mcpServers?.rea?.args) !== JSON.stringify(["mcp"]) ||
    (await pathExists(markerPath)) ||
    registration?.state !== "aligned" ||
    registration.config_path !== configPath
  )
    throw new Error(
      `packaged setup did not configure an explicitly selected Claude Code with no marker directory: ${JSON.stringify(first)}`,
    );
  const repeatExecution = await runWithStatus(cli, args, childEnvironment);
  const repeat = json(repeatExecution.stdout);
  if (
    repeatExecution.status !== 0 ||
    repeat.status !== "ready" ||
    repeat.appliedActions.length !== 0 ||
    repeat.plannedActions.length !== 0
  )
    throw new Error(
      `packaged setup was not idempotent for Claude Code without a marker directory: ${JSON.stringify(repeat)}`,
    );
  await rm(freshHome, { recursive: true, force: true });
};

const verifySetupApply = async ({
  cli,
  environment,
  supportedSetupHost,
  hopperSetupSupported,
}) => {
  const status = "ready";
  const hopperStatus = hopperSetupSupported
    ? "needs_confirmation"
    : "needs_human";
  const firstExecution = await runWithStatus(
    cli,
    ["setup", "--yes", "--all-detected", "--json"],
    environment,
  );
  const first = json(firstExecution.stdout);
  const alignedExecution = await runWithStatus(
    cli,
    ["setup", "--all-detected", "--json"],
    environment,
  );
  const aligned = json(alignedExecution.stdout);
  const secondExecution = await runWithStatus(
    cli,
    [
      "setup",
      "--client",
      "claude_desktop",
      "--client",
      "codex",
      "--client",
      "cursor",
      "--install-hopper",
      "--json",
    ],
    environment,
  );
  const second = json(secondExecution.stdout);
  if (supportedSetupHost) {
    if (
      first.status !== status ||
      second.status !== hopperStatus ||
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
        `packaged setup did not preserve idempotent agent configuration and explicit Hopper reinstall behavior: ${JSON.stringify({ first, aligned, second })}`,
      );
  }
  return {
    first,
    aligned,
    second,
    firstExecution,
    alignedExecution,
    secondExecution,
    status,
  };
};

const assertClientConfig = async (cli, configPath) => {
  const config = json(await readFile(configPath, "utf8"));
  if (
    config.existing !== true ||
    config.mcpServers?.rea?.command !== cli ||
    JSON.stringify(config.mcpServers?.rea?.args) !== JSON.stringify(["mcp"])
  )
    throw new Error("packaged client readback failed");
  if (
    !(await readFile(`${configPath}.rea.backup`, "utf8")).includes("existing")
  )
    throw new Error("packaged client backup failed");
};

const assertOpenCodeConfig = async ({
  cli,
  configPath,
  expectedRegistration,
}) => {
  const contents = await readFile(configPath, "utf8");
  const errors = [];
  const parsed = parseJsonc(contents, errors, { allowTrailingComma: true });
  const config = parsed;
  const mcp = config?.mcp;
  if (
    errors.length !== 0 ||
    !contents.includes("// OpenCode preferences must survive setup.") ||
    !contents.includes("// Keep this independently managed server.") ||
    config?.model !== "provider/model" ||
    mcp?.other?.command?.[0] !== "node" ||
    (expectedRegistration &&
      (mcp?.rea?.type !== "local" ||
        mcp.rea.enabled !== true ||
        JSON.stringify(mcp.rea.command) !== JSON.stringify([cli, "mcp"]))) ||
    (!expectedRegistration && mcp?.rea !== undefined)
  )
    throw new Error("packaged OpenCode JSONC registration readback failed");
};

const assertCodexSymlink = async ({
  cli,
  codexConfig,
  cursorConfig,
  codexTarget,
}) => {
  const codex = await readFile(codexTarget, "utf8");
  if (
    !(await lstat(codexConfig)).isSymbolicLink() ||
    !(await lstat(cursorConfig)).isSymbolicLink() ||
    !codex.includes("[mcp_servers.rea]") ||
    !codex.includes(`command = "${cli}"`) ||
    !codex.includes("startup_timeout_sec = 30") ||
    (await readFile(`${codexConfig}.rea.backup`, "utf8")) !==
      'model = "gpt-5"\n' ||
    (await readFile(`${cursorConfig}.rea.backup`, "utf8")) !==
      '{"existing":true}\n'
  )
    throw new Error("packaged setup did not preserve config symlinks");
};

const assertSkill = async ({ skillPath, siblingSkillPath, root }) => {
  const skill = await readFile(skillPath, "utf8");
  const canonicalSkill = await readFile(
    join(root, "skills/reverse-engineer-anything/SKILL.md"),
    "utf8",
  );
  if (skill !== canonicalSkill)
    throw new Error("packaged skill did not match its canonical source");
  const canonicalRoot = join(root, "skills/reverse-engineer-anything");
  for (const reference of await readdir(join(canonicalRoot, "references"))) {
    const installed = await readFile(
      join(dirname(skillPath), "references", reference),
      "utf8",
    );
    const canonical = await readFile(
      join(canonicalRoot, "references", reference),
      "utf8",
    );
    if (installed !== canonical)
      throw new Error(
        `packaged skill reference did not match canonical source: ${reference}`,
      );
  }
  const issues = await skillReferenceIssues(dirname(skillPath));
  if (issues.length > 0) throw new Error(issues.join("\n"));
  if ((await readFile(siblingSkillPath, "utf8")) !== "unrelated skill\n")
    throw new Error("packaged skill installation modified a sibling skill");
};

const assertAlignedDoctor = async (cli, environment) => {
  const alignedDoctorExecution = await runWithStatus(
    cli,
    ["doctor", "--json"],
    environment,
  );
  const alignedDoctor = json(alignedDoctorExecution.stdout);
  if (
    alignedDoctorExecution.status !== (alignedDoctor.healthy ? 0 : 1) ||
    alignedDoctor.identity?.skill?.state !== "aligned" ||
    alignedDoctor.identity?.skill?.installed_tool_count !==
      TOOL_CONTRACTS.length ||
    alignedDoctor.checks?.some(({ name }) => name === "skill:identity")
  )
    throw new Error(
      "packaged doctor did not report the upgraded skill aligned",
    );
};

const verifyConfigReadback = async ({
  cli,
  environment,
  claudeConfig,
  cursorConfig,
  codexConfig,
  codexTarget,
  root,
  skillPath,
  siblingSkillPath,
  opencodeConfig,
  opencodeOriginal,
}) => {
  await assertClientConfig(cli, claudeConfig);
  await assertClientConfig(cli, cursorConfig);
  await assertCodexSymlink({
    cli,
    codexConfig,
    cursorConfig,
    codexTarget,
  });
  await assertSkill({ skillPath, siblingSkillPath, root });
  await assertOpenCodeConfig({
    cli,
    configPath: opencodeConfig,
    expectedRegistration: true,
  });
  if (
    (await readFile(`${opencodeConfig}.rea.backup`, "utf8")) !==
    opencodeOriginal
  )
    throw new Error(
      "packaged OpenCode backup did not preserve the original JSONC",
    );
  await assertAlignedDoctor(cli, environment);
};

const verifySetupFailureRecovery = async ({
  cli,
  environment,
  claudeConfig,
  cursorConfig,
  status,
}) => {
  await writeFile(claudeConfig, "malformed");
  await writeFile(cursorConfig, '{"existing":true}\n');
  const failedExecution = await runWithStatus(
    cli,
    ["setup", "--yes", "--all-detected", "--json"],
    environment,
  );
  const failed = json(failedExecution.stdout);
  if (
    failed.status !== "needs_human" ||
    failedExecution.status !== 1 ||
    Object.keys(failed.clients ?? {}).length !== 0 ||
    failed.appliedActions.length !== 0 ||
    !failed.remediation?.includes("Claude Desktop") ||
    (await readFile(claudeConfig, "utf8")) !== "malformed" ||
    json(await readFile(cursorConfig, "utf8")).existing !== true ||
    json(await readFile(cursorConfig, "utf8")).mcpServers?.rea !== undefined
  )
    throw new Error(
      `packaged setup mutated clients after a preflight failure: ${JSON.stringify(failed)}`,
    );
  await writeFile(claudeConfig, "{}\n");
  const recoveredExecution = await runWithStatus(
    cli,
    ["setup", "--yes", "--all-detected", "--json"],
    environment,
  );
  const recovered = json(recoveredExecution.stdout);
  if (
    recovered.status !== status ||
    recoveredExecution.status !== (status === "ready" ? 0 : 1) ||
    json(await readFile(cursorConfig, "utf8")).mcpServers?.rea?.command !== cli
  )
    throw new Error("packaged setup did not recover");
};

const verifyDanglingSymlink = async ({ cli, environment, home }) => {
  const geminiDir = join(home, ".gemini");
  const geminiConfig = join(geminiDir, "settings.json");
  await mkdir(geminiDir, { recursive: true });
  await symlink(join(home, "missing-gemini.json"), geminiConfig);
  const danglingExecution = await runWithStatus(
    cli,
    ["setup", "--yes", "--client", "gemini_cli", "--json"],
    environment,
  );
  const dangling = json(danglingExecution.stdout);
  if (
    dangling.status !== "needs_human" ||
    danglingExecution.status !== 1 ||
    Object.keys(dangling.clients ?? {}).length !== 0 ||
    dangling.appliedActions.length !== 0 ||
    !dangling.remediation?.includes("Gemini CLI") ||
    !dangling.remediation?.includes("unsafe or unresolved") ||
    !(await lstat(geminiConfig)).isSymbolicLink() ||
    (await pathExists(`${geminiConfig}.rea.backup`))
  )
    throw new Error(
      `packaged setup did not reject a dangling config symlink before mutation: ${JSON.stringify(dangling)}`,
    );
  await rm(geminiDir, { recursive: true });
};

const verifyUninstall = async ({
  cli,
  environment,
  cursorConfig,
  codexConfig,
  cursorTarget,
  codexTarget,
  opencodeConfig,
}) => {
  const openCodeBeforeUninstall = await readFile(opencodeConfig, "utf8");
  const uninstallExecution = await runWithStatus(
    cli,
    ["uninstall", "--json"],
    environment,
  );
  const uninstall = json(uninstallExecution.stdout);
  const cursorAfterUninstall = json(await readFile(cursorTarget, "utf8"));
  const codexAfterUninstall = await readFile(codexTarget, "utf8");
  const openCodeErrors = [];
  const openCodeAfterUninstall = parseJsonc(
    await readFile(opencodeConfig, "utf8"),
    openCodeErrors,
    { allowTrailingComma: true },
  );
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
    openCodeErrors.length !== 0 ||
    openCodeAfterUninstall?.model !== "provider/model" ||
    openCodeAfterUninstall?.mcp?.rea !== undefined ||
    openCodeAfterUninstall?.mcp?.other?.command?.[0] !== "node" ||
    !(await readFile(`${opencodeConfig}.rea.backup`, "utf8")).includes(
      "OpenCode preferences must survive setup",
    ) ||
    !(await readFile(`${opencodeConfig}.rea.backup`, "utf8")).includes(
      "Keep this independently managed server",
    ) ||
    (await readFile(`${opencodeConfig}.rea.backup`, "utf8")) !==
      openCodeBeforeUninstall ||
    !(await readFile(`${cursorConfig}.rea.backup`, "utf8")).includes('"rea"') ||
    !(await readFile(`${codexConfig}.rea.backup`, "utf8")).includes(
      "[mcp_servers.rea]",
    )
  )
    throw new Error(
      `packaged uninstall did not preserve config symlinks: ${JSON.stringify(uninstall)}`,
    );
};

/** Verify setup transactions, skill installation, and uninstall for supported hosts. */
export async function verifyPackageSetup({
  cli,
  packageRunnerCli,
  environment,
  home,
  npxLog,
  claudeConfig,
  codexConfig,
  cursorConfig,
  codexTarget,
  cursorTarget,
  supportedSetupHost,
  hopperSetupSupported,
  root,
}) {
  await verifyMcpAdd({ cli, environment, npxLog });
  const skillPath = join(
    home,
    ".agents/skills/reverse-engineer-anything/SKILL.md",
  );
  const siblingSkillPath = join(home, ".agents/skills/unrelated/SKILL.md");
  if (supportedSetupHost) {
    await mkdir(join(home, ".agents/skills/unrelated"), { recursive: true });
    await writeFile(siblingSkillPath, "unrelated skill\n");
  }
  const opencodeConfig = join(
    environment.XDG_CONFIG_HOME ?? join(home, ".config"),
    "opencode",
    "opencode.json",
  );
  if (supportedSetupHost) {
    await mkdir(join(opencodeConfig, ".."), { recursive: true });
    await writeFile(opencodeConfig, OPENCODE_ORIGINAL);
  }
  const unchangedPaths = [
    claudeConfig,
    cursorConfig,
    codexTarget,
    opencodeConfig,
    skillPath,
  ];
  await verifyInteractiveSetup({
    command: packageRunnerCli,
    environment,
    root,
    unchangedPaths,
  });
  await verifyRedirectedStdoutSetup({
    command: packageRunnerCli,
    environment,
    root,
    unchangedPaths,
  });
  await verifySetupPlan({
    cli,
    environment,
    claudeConfig,
    cursorConfig,
    codexTarget,
    opencodeConfig,
    opencodeOriginal: OPENCODE_ORIGINAL,
    supportedSetupHost,
  });
  const apply = await verifySetupApply({
    cli,
    environment,
    supportedSetupHost,
    hopperSetupSupported,
  });
  if (supportedSetupHost) {
    await verifyAbsentOpenCodeSetup({ cli, environment, home });
    await verifyAbsentClaudeCodeSetup({ cli, environment, home });
    await verifyConfigReadback({
      cli,
      environment,
      claudeConfig,
      cursorConfig,
      codexConfig,
      codexTarget,
      root,
      skillPath,
      siblingSkillPath,
      opencodeConfig,
      opencodeOriginal: OPENCODE_ORIGINAL,
    });
    await verifySetupFailureRecovery({
      cli,
      environment,
      claudeConfig,
      cursorConfig,
      status: apply.status,
    });
    await verifyDanglingSymlink({ cli, environment, home });
    await verifyUninstall({
      cli,
      environment,
      cursorConfig,
      codexConfig,
      cursorTarget,
      codexTarget,
      opencodeConfig,
    });
  } else if (
    apply.first.status !== "needs_human" ||
    apply.aligned.status !== "needs_human" ||
    apply.second.status !== "needs_human"
  ) {
    throw new Error("packaged setup did not reject an unsupported host");
  }
}
