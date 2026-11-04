import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { PassThrough, Writable } from "node:stream";

import {
  OwnedCommandFailure,
  prepareOwnedCommand,
  runOwnedCommand,
} from "../../dist/process/OwnedCommand.js";
import { ArtifactResourceScope } from "../../dist/artifacts/ArtifactResourceScope.js";
import { AnalysisCleanupLease } from "../../dist/artifacts/AnalysisCleanupLease.js";
import { retainOwnedCommandCleanup } from "../../dist/providers/OwnedCommandCleanup.js";

/** Keep command ownership through failure and join cleanup before removing a run. */
export function createAgentEvaluationCommands({
  codex,
  claude = process.env.REA_AGENT_EVAL_CLAUDE_COMMAND ?? "claude",
  gemini = process.env.REA_AGENT_EVAL_GEMINI_COMMAND ?? "gemini",
  evaluationRoot,
  evaluationEnvironment,
  optionalModel,
  timeoutMs,
  repositoryRoot,
}) {
  const resources = new ArtifactResourceScope();
  const resourceOwner = {
    retain(owner, resource) {
      resources.retain({
        kind: "lease",
        resource,
        lease: AnalysisCleanupLease.forCloseOwner(owner, resource),
      });
    },
    run: (work) => resources.run(work),
  };
  const diagnosticBytes = 32_768;
  const launchGemini = (arguments_) =>
    /\.(?:c|m)?js$/iu.test(gemini)
      ? [process.execPath, [gemini, ...arguments_]]
      : [gemini, arguments_];

  async function execute(
    command,
    arguments_,
    cwd,
    env,
    limits,
    timeoutMessage,
  ) {
    return resourceOwner.run(async () => {
      try {
        // Fresh Darwin helper compilation has its own bounded deadline.
        await prepareOwnedCommand();
        return await runOwnedCommand(
          {
            command,
            arguments: arguments_,
            // CLI shims may execute through a shebang interpreter. Ownership
            // still uses the launch generation and token, not an argv prefix.
            expectedCommand: null,
            cwd,
            hostEnvironment: env,
            runId: randomUUID(),
            sweepTokenOwnedProcesses: true,
          },
          { diagnosticBytes, acceptNonZeroExit: true, ...limits },
        );
      } catch (cause) {
        retainOwnedCommandCleanup(
          cause,
          resourceOwner,
          "agent-evaluation",
          command,
        );
        if (cause instanceof OwnedCommandFailure && cause.reason === "timeout")
          throw new Error(timeoutMessage, { cause });
        throw cause;
      }
    });
  }

  async function executeJsonLines(
    command,
    arguments_,
    cwd,
    env,
    timeoutMessage,
  ) {
    const events = [];
    const nonJson = [];
    let nonJsonBytes = 0;
    const stdout = new PassThrough();
    const lines = createInterface({ input: stdout });
    const linesClosed = new Promise((resolve) =>
      lines.once("close", resolve),
    );
    let lineError;
    lines.on("error", (cause) => {
      lineError = cause;
      lines.close();
    });
    lines.on("line", (line) => {
      try {
        events.push(JSON.parse(line));
      } catch {
        if (nonJsonBytes >= diagnosticBytes) return;
        const bytes = Buffer.from(
          `non-json stdout: ${line.slice(0, diagnosticBytes - nonJsonBytes)}`,
        );
        const retained = bytes.subarray(0, diagnosticBytes - nonJsonBytes);
        if (retained.length > 0) nonJson.push(retained);
        nonJsonBytes += retained.length;
      }
    });
    try {
      const result = await execute(
        command,
        arguments_,
        cwd,
        env,
        { timeoutMs, stdout },
        timeoutMessage,
      );
      await linesClosed;
      if (lineError !== undefined) throw lineError;
      return {
        events,
        exitCode: result.exitCode ?? 1,
        stderr: Buffer.concat([...nonJson, Buffer.from(result.stderr.text)])
          .subarray(0, diagnosticBytes)
          .toString("utf8"),
      };
    } finally {
      stdout.destroy();
      lines.close();
      await linesClosed;
    }
  }

  return {
    async runCodex(prompt, approvedTools) {
      const arguments_ = [
        "--no-daemon",
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--json",
        "--color",
        "never",
        "-C",
        evaluationRoot,
        "-c",
        'approval_policy="never"',
        ...approvedTools.flatMap((name) => [
          "-c",
          `mcp_servers.rea.tools.${name}.approval_mode="approve"`,
        ]),
        ...(optionalModel === undefined ? [] : ["--model", optionalModel]),
        prompt,
      ];
      return executeJsonLines(
        codex,
        arguments_,
        evaluationRoot,
        evaluationEnvironment,
        `Codex evaluation timed out after ${String(timeoutMs)}ms`,
      );
    },

    async runClaude(prompt) {
      return executeJsonLines(
        claude,
        [
          "--print",
          "--output-format",
          "stream-json",
          "--verbose",
          "--no-session-persistence",
          "--permission-mode",
          "dontAsk",
          "--settings",
          JSON.stringify({
            permissions: {
              allow: ["Skill", "WaitForMcpServers", "mcp__rea__*"],
            },
          }),
          ...(optionalModel === undefined ? [] : ["--model", optionalModel]),
          "--",
          prompt,
        ],
        evaluationRoot,
        evaluationEnvironment,
        `Claude Code evaluation timed out after ${String(timeoutMs)}ms`,
      );
    },

    async runGemini(prompt) {
      const [command, arguments_] = launchGemini([
        "--approval-mode",
        "yolo",
        "--allowed-mcp-server-names",
        "rea",
        "--output-format",
        "stream-json",
        ...(optionalModel === undefined ? [] : ["--model", optionalModel]),
        "-p",
        prompt,
      ]);
      return executeJsonLines(
        command,
        arguments_,
        evaluationRoot,
        evaluationEnvironment,
        `Gemini CLI evaluation timed out after ${String(timeoutMs)}ms`,
      );
    },

    async runProcess(command, arguments_, cwd, timeout, env = process.env) {
      const result = await execute(
        command,
        arguments_,
        cwd,
        env,
        {
          timeoutMs: timeout,
          stdout: new Writable({ write: (_chunk, _encoding, done) => done() }),
        },
        `${command} timed out`,
      );
      if (result.exitCode !== 0)
        throw new Error(
          `${command} failed with ${String(result.exitCode)}: ${result.stderr.text}`,
        );
    },

    async readCommandVersion(command, env = process.env) {
      const result = await execute(
        command,
        ["--version"],
        repositoryRoot,
        env,
        { timeoutMs: 10_000, diagnosticBytes: 8192 },
        `${command} --version timed out`,
      );
      if (result.exitCode !== 0)
        throw new Error(
          `${command} --version failed with ${String(result.exitCode)}: ${result.stderr.text}`,
        );
      const version = result.stdout.text.trim();
      if (version.length === 0)
        throw new Error(`${command} --version returned empty output`);
      return version;
    },

    async readAgentVersion(client, env = evaluationEnvironment) {
      const [command, arguments_] =
        client === "gemini-cli"
          ? launchGemini(["--version"])
          : [client === "claude-code" ? claude : codex, ["--version"]];
      const result = await execute(
        command,
        arguments_,
        repositoryRoot,
        env,
        { timeoutMs: 10_000, diagnosticBytes: 8192 },
        `${client} --version timed out`,
      );
      if (result.exitCode !== 0)
        throw new Error(
          `${client} --version failed with ${String(result.exitCode)}: ${result.stderr.text}`,
        );
      const version = result.stdout.text.trim();
      if (version.length === 0)
        throw new Error(`${client} --version returned empty output`);
      return version;
    },

    close: () => resources.close(),
  };
}
