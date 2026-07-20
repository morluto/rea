import {
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { spawn } from "@lydell/node-pty";

import { TOOL_CONTRACTS } from "../dist/contracts/toolContracts.js";
import { PRODUCT_IDENTITY } from "../dist/identity.js";
import {
  json,
  pathExists,
  run,
  runWithStatus,
} from "./lib/verify-package-core.mjs";

const verifyMcpAdd = async ({ cli, environment, npxLog }) => {
  await run(cli, ["mcp", "add"], environment);
  const mcpRegistration = await readFile(npxLog, "utf8");
  const expected = `add-mcp npx -y ${PRODUCT_IDENTITY.registrationPackageSpecifier} mcp --name rea`;
  if (!mcpRegistration.includes(expected))
    throw new Error("Incur mcp add did not register the pinned npx command");
};

const verifyInteractiveSetup = async ({ command, environment, root }) =>
  new Promise((resolvePromise, reject) => {
    let output = "";
    let cancelled = false;
    let settled = false;
    const terminal = spawn(command, ["setup"], {
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
      if (!cancelled && output.includes("What should REA set up?")) {
        cancelled = true;
        terminal.write("\u0003");
      }
    });
    terminal.onExit(() => {
      if (!cancelled || !output.includes("No changes were made.")) {
        finish(
          new Error(
            `packaged rea-agents setup did not open and cancel the wizard: ${output}`,
          ),
        );
        return;
      }
      finish();
    });
  });

const verifySetupPlan = async ({
  cli,
  environment,
  claudeConfig,
  cursorConfig,
  codexTarget,
  supportedSetupHost,
}) => {
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
    if (
      planned.status !== "needs_confirmation" ||
      plannedExecution.status !== 1 ||
      planned.appliedActions.length !== 0 ||
      !planned.plannedActions.some(({ kind }) => kind === "configure_client") ||
      !planned.plannedActions.some(({ kind }) => kind === "install_skill") ||
      plannedClaudeConfig !== '{"existing":true}\n' ||
      plannedCodexConfig !== 'model = "gpt-5"\n' ||
      plannedCursorConfig !== '{"existing":true}\n'
    )
      throw new Error(
        `packaged setup plan was not read-only: ${JSON.stringify({ status: planned.status, exitCode: plannedExecution.status, plannedKinds: planned.plannedActions.map(({ kind }) => kind), appliedKinds: planned.appliedActions.map(({ kind }) => kind), claudeConfig: plannedClaudeConfig, codexConfig: plannedCodexConfig, cursorConfig: plannedCursorConfig })}`,
      );
  }
  return { planned };
};

const verifySetupApply = async ({ cli, environment, supportedSetupHost }) => {
  const status = process.platform === "linux" ? "needs_human" : "ready";
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
  const installedReference = await readFile(
    join(skillPath, "..", "references/javascript-applications.md"),
    "utf8",
  );
  const canonicalReference = await readFile(
    join(
      root,
      "skills/reverse-engineer-anything/references/javascript-applications.md",
    ),
    "utf8",
  );
  if (installedReference !== canonicalReference)
    throw new Error("packaged skill references did not match canonical source");
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
    ["setup", "--yes", "--json"],
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
    ["setup", "--yes", "--json"],
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
    ["setup", "--yes", "--json"],
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
}) => {
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
  root,
}) {
  await verifyInteractiveSetup({
    command: packageRunnerCli,
    environment,
    root,
  });
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
  await verifySetupPlan({
    cli,
    environment,
    claudeConfig,
    cursorConfig,
    codexTarget,
    supportedSetupHost,
  });
  const apply = await verifySetupApply({
    cli,
    environment,
    supportedSetupHost,
  });
  if (supportedSetupHost) {
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
    });
  } else if (
    apply.first.status !== "needs_human" ||
    apply.aligned.status !== "needs_human" ||
    apply.second.status !== "needs_human"
  ) {
    throw new Error("packaged setup did not reject an unsupported host");
  }
}
