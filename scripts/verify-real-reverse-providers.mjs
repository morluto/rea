#!/usr/bin/env node
/**
 * Real-provider verification for the caller-supplied reverse-engineering tools.
 *
 * Verifies objdump, Rizin and GDB against the installed binaries through the
 * public CLI and MCP surfaces, records observed versions and cleanup, and fails
 * when a claim cannot be established. `docs/testing.md` requires this lane for
 * engine adapters; an injected provider does not establish real-provider
 * behavior.
 *
 * Usage: node scripts/verify-real-reverse-providers.mjs [objdump] [rizin] [gdb]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { openInferiorTty, closeInferiorTty } from "./verify-inferior-tty.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const requested = process.argv
  .slice(2)
  .filter((value) => !value.startsWith("-"));
const providers =
  requested.length === 0 ? ["objdump", "rizin", "gdb"] : requested;
const skippedProviders = process.argv
  .slice(2)
  .filter((value) => value.startsWith("--skipped="))
  .map((value) => value.slice("--skipped=".length));
const receiptPath = join(root, "reverse-providers-real.json");
const receipt = {
  ran_at_utc: new Date().toISOString(),
  host: {
    platform: process.platform,
    arch: process.arch,
    kernel: null,
    locale: null,
  },
  providers: {},
  assertions: [],
  cleaned_up: {},
  unknowns: [],
};

let failures = 0;
const check = (name, passed, detail) => {
  receipt.assertions.push({ name, passed: passed === true, detail });
  if (passed !== true) {
    failures += 1;
    console.error(`FAIL ${name}: ${detail}`);
  } else {
    console.log(`ok   ${name}`);
  }
};

const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", ...options.env },
    ...options,
  }).trim();

const firstLine = (command, args) => {
  try {
    return run(command, args).split("\n")[0] ?? null;
  } catch {
    return null;
  }
};

const digest = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const processSnapshot = () =>
  run("ps", ["-eo", "pid=,ppid=,comm=,lstart="])
    .split("\n")
    .flatMap((line) => {
      const match = /^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(line.trim());
      return match === null
        ? []
        : [
            {
              pid: Number(match[1]),
              parentPid: Number(match[2]),
              command: match[3],
              startedAt: match[4],
            },
          ];
    });

const descendantsOf = (rootPid, processes) => {
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      if (descendants.has(process.parentPid) && !descendants.has(process.pid)) {
        descendants.add(process.pid);
        changed = true;
      }
    }
  }
  return descendants;
};

const ownedGdbProcesses = (mcpPid) => {
  const processes = processSnapshot();
  const descendants = descendantsOf(mcpPid, processes);
  return processes.filter(
    (process) =>
      descendants.has(process.pid) && /^gdb(?:-|$)/iu.test(process.command),
  );
};

const cli = (args) =>
  JSON.parse(
    run(process.execPath, [
      join(root, "scripts/rea.mjs"),
      ...args,
      "--format",
      "json",
    ]),
  );

const cliFailure = (args) => {
  try {
    run(process.execPath, [
      join(root, "scripts/rea.mjs"),
      ...args,
      "--format",
      "json",
    ]);
    return null;
  } catch (cause) {
    return String(cause.stdout ?? cause.message ?? cause).slice(0, 400);
  }
};

const verifyObjdump = async (fixture, expectedDigest) => {
  const observed = {
    version: firstLine("objdump", ["--version"]),
    operations: {},
  };
  receipt.providers.objdump = observed;
  for (const operation of [
    "file_headers",
    "section_headers",
    "symbols",
    "relocations",
    "dwarf",
    "disassemble",
    "disassemble_all",
  ]) {
    const evidence = cli(["inspect-with-objdump", fixture, operation]);
    const result = evidence.normalized_result ?? {};
    observed.operations[operation] = {
      exit_code: result.exit_code,
      stdout_bytes:
        typeof result.stdout === "string" ? result.stdout.length : 0,
      artifact_changed: result.artifact_changed,
      completion_status: result.completion_status,
    };
    check(
      `objdump ${operation} ran against the installed binary`,
      result.exit_code === 0 &&
        result.completion_status === "complete" &&
        typeof result.stdout === "string" &&
        result.stdout.length > 0,
      JSON.stringify(observed.operations[operation]),
    );
    check(
      `objdump ${operation} preserved artifact identity`,
      result.artifact_changed === false &&
        result.artifact_sha256_after === expectedDigest,
      `after=${result.artifact_sha256_after} changed=${result.artifact_changed}`,
    );
    check(
      `objdump ${operation} recorded the caller operation and provider executable`,
      evidence.parameters?.operation === operation &&
        evidence.parameters?.provider_executable !== undefined,
      JSON.stringify(evidence.parameters),
    );
  }
  const architectures =
    cli(["list-objdump-architectures"]).normalized_result ?? {};
  observed.architectures = {
    exit_code: architectures.exit_code,
    completion_status: architectures.completion_status,
    stdout_bytes:
      typeof architectures.stdout === "string"
        ? architectures.stdout.length
        : 0,
  };
  check(
    "objdump reported its architectures through the pathless CLI command",
    architectures.exit_code === 0 &&
      architectures.completion_status === "complete" &&
      typeof architectures.stdout === "string" &&
      architectures.stdout.length > 0,
    JSON.stringify(observed.architectures),
  );
};

const verifyRizin = async (fixture, expectedDigest) => {
  const observed = { version: firstLine("rizin", ["-v"]) };
  receipt.providers.rizin = observed;
  const evidence = cli(["execute-rizin-command", fixture, "iI"]);
  const result = evidence.normalized_result ?? {};
  observed.operation = {
    exit_code: result.exit_code,
    stdout_head: String(result.stdout ?? "")
      .split("\n")
      .slice(0, 2),
    artifact_changed: result.artifact_changed,
  };
  check(
    "rizin ran the caller-selected command",
    result.exit_code === 0 && String(result.stdout ?? "").includes("arch"),
    JSON.stringify(observed.operation),
  );
  check(
    "rizin Evidence keeps the caller command and separates the provider executable",
    evidence.parameters?.command === "iI" &&
      typeof evidence.parameters?.provider_executable === "string" &&
      evidence.parameters.provider_executable.includes("rizin"),
    JSON.stringify(evidence.parameters),
  );
  check(
    "rizin preserved artifact identity",
    result.artifact_changed === false &&
      result.artifact_sha256_after === expectedDigest,
    `after=${result.artifact_sha256_after} changed=${result.artifact_changed}`,
  );
};

const callTool = async (client, name, args) => {
  const response = await client.callTool({ name, arguments: args });
  return response;
};

const structured = (response) => response.structuredContent ?? {};

const verifyGdb = async (fixture, expectedDigest) => {
  const observed = { version: firstLine("gdb", ["--version"]) };
  receipt.providers.gdb = observed;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "scripts/rea.mjs"), "mcp"],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", REA_LOG_LEVEL: "silent" },
    stderr: "pipe",
  });
  const client = new Client({ name: "rea-real-reverse-tools", version: "1" });
  let helper;
  let inferiorTty;
  let ownedProcesses = [];
  try {
    await client.connect(transport);
    const terminal = await openInferiorTty();
    helper = terminal.helper;
    inferiorTty = terminal.path;
    observed.inferior_tty = inferiorTty;
    const started = structured(
      await callTool(client, "start_gdb_session", {
        inferior_tty: inferiorTty,
      }),
    );
    observed.mi_version = started.mi_version;
    check(
      "gdb started a persistent MI session",
      typeof started.session_id === "string" &&
        (started.mi_version === "mi3" || started.mi_version === "mi2"),
      JSON.stringify(started),
    );
    const sessionId = started.session_id;
    if (typeof sessionId !== "string") {
      receipt.unknowns.push(
        "gdb did not return a session identifier; this lane closed no session",
      );
      return;
    }
    const mcpPid = transport._process?.pid;
    if (typeof mcpPid === "number") {
      ownedProcesses = ownedGdbProcesses(mcpPid);
      observed.owned_debugger_processes = ownedProcesses;
    }

    const expectations = [
      { command: "set mi-async on", terminal: /^\d+\^done(?:,|$)/u },
      { command: `file ${fixture}`, terminal: /^\d+\^done(?:,|$)/u },
      { command: "break main", terminal: /^\d+\^done(?:,|$)/u },
      { command: "run", terminal: /^\d+\^running(?:,|$)/u },
      { command: "info registers rip", terminal: /^\d+\^done(?:,|$)/u },
    ];
    observed.commands = {};
    for (const { command, terminal } of expectations) {
      const response = await callTool(client, "gdb_console", {
        session_id: sessionId,
        command,
      });
      const result = structured(response).normalized_result ?? {};
      observed.commands[command] = {
        mi: result.mi,
        completion_status: result.completion_status,
        output_truncated: result.output_truncated,
      };
      check(
        `gdb console resolved ${JSON.stringify(command)} with the expected MI class`,
        response.isError !== true &&
          typeof result.mi === "string" &&
          terminal.test(result.mi) &&
          !/^\d+\^error(?:,|$)/u.test(result.mi) &&
          result.completion_status === "complete" &&
          result.output_truncated === false,
        JSON.stringify(observed.commands[command]),
      );
      if (command === "run")
        check(
          "gdb reported the interrupted inferior after run",
          Array.isArray(result.records) &&
            result.records.some((line) => String(line).startsWith("*stopped")),
          JSON.stringify((result.records ?? []).slice(-4)),
        );
    }

    // Real asynchronous execution must not hold the control path behind run.
    for (const command of ["set confirm off", "set args wait", "run"]) {
      const configured = await callTool(client, "gdb_console", {
        session_id: sessionId,
        command,
      });
      check(
        `gdb prepared asynchronous interrupt with ${command}`,
        configured.isError !== true &&
          structured(configured).normalized_result?.completion_status ===
            "complete" &&
          !/^\d+\^error(?:,|$)/u.test(
            structured(configured).normalized_result?.mi ?? "",
          ),
        JSON.stringify(structured(configured).normalized_result),
      );
    }
    const continuing = callTool(client, "gdb_console", {
      session_id: sessionId,
      command: "continue",
    });
    // Poll the bounded status owner for the newly observed running target.
    let runningObserved = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = structured(
        await callTool(client, "gdb_session_status", { session_id: sessionId }),
      );
      const recent = current.recent_mi_records ?? [];
      const lastRunning = recent.findLastIndex((line) =>
        String(line).startsWith("*running"),
      );
      const lastStopped = recent.findLastIndex((line) =>
        String(line).startsWith("*stopped"),
      );
      if (lastRunning > lastStopped) {
        runningObserved = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    check(
      "gdb observed a running inferior before interrupt",
      runningObserved,
      "bounded status readback",
    );
    const interrupted = await callTool(client, "gdb_console", {
      session_id: sessionId,
      command: "interrupt",
    });
    check(
      "gdb interrupt reached the running command",
      interrupted.isError !== true &&
        structured(interrupted).normalized_result?.completion_status ===
          "complete",
      JSON.stringify(structured(interrupted).normalized_result),
    );
    const continued = await continuing;
    const continuedResult = structured(continued).normalized_result ?? {};
    check(
      "gdb continued command settled on the interrupt stop",
      continued.isError !== true &&
        continuedResult.completion_status === "complete" &&
        continuedResult.records?.some(
          (line) =>
            String(line).startsWith('*stopped,reason="signal-received"') &&
            String(line).includes('signal-name="SIGINT"'),
        ),
      JSON.stringify(continuedResult),
    );
    // Explicitly end the owned fixture so closing does not leave a sleeper.
    const terminated = await callTool(client, "gdb_console", {
      session_id: sessionId,
      command: "kill",
    });
    check(
      "gdb terminated the selected fixture before close",
      terminated.isError !== true &&
        /^\d+\^done(?:,|$)/u.test(
          structured(terminated).normalized_result?.mi ?? "",
        ),
      JSON.stringify(structured(terminated).normalized_result),
    );

    const rejected = await callTool(client, "gdb_console", {
      session_id: sessionId,
      command: "rea-verification-unknown-command",
    });
    const rejectedResult = structured(rejected).normalized_result ?? {};
    observed.negative_control = {
      mi: rejectedResult.mi,
      completion_status: rejectedResult.completion_status,
    };
    check(
      "gdb reported an unknown console command as an MI error record",
      /^\d+\^error(?:,|$)/u.test(String(rejectedResult.mi ?? "")) &&
        rejectedResult.completion_status === "complete",
      JSON.stringify(observed.negative_control),
    );

    const status = structured(
      await callTool(client, "gdb_session_status", { session_id: sessionId }),
    );
    observed.status = {
      state: status.state,
      mi_version: status.mi_version,
      inferior_tty: status.inferior_tty,
      inferior_tty_verified: status.inferior_tty_verified,
    };
    check(
      "gdb verified the caller-selected inferior TTY against the running debugger",
      status.state === "ready" && status.inferior_tty_verified === true,
      JSON.stringify(observed.status),
    );

    const closed = structured(
      await callTool(client, "close_gdb_session", { session_id: sessionId }),
    );
    observed.close = closed;
    check(
      "gdb closed the session with an explicit target state",
      closed.target_state === "none_observed" ||
        closed.target_state === "unknown",
      JSON.stringify(closed),
    );
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    if (helper !== undefined) await closeInferiorTty(helper);
  }

  await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  const remaining = processSnapshot().filter((process) =>
    ownedProcesses.some(
      (owned) =>
        process.pid === owned.pid && process.startedAt === owned.startedAt,
    ),
  );
  receipt.cleaned_up.gdb_processes = {
    owned: ownedProcesses,
    remaining,
  };
  check(
    "gdb stopped every debugger process owned by this verification session",
    ownedProcesses.length > 0 && remaining.length === 0,
    `owned=${ownedProcesses.length} remaining=${remaining.length}`,
  );
  check(
    "the verified inferior did not change the artifact",
    digest(fixture) === expectedDigest,
    `digest=${digest(fixture).slice(0, 12)}`,
  );

  const controlTty = await openInferiorTty();
  observed.one_shot = {};
  try {
    const accepted = cli([
      "debug-with-gdb",
      "info files",
      "--inferior-tty",
      controlTty.path,
    ]);
    observed.one_shot.accepted = (
      accepted.normalized_result ?? {}
    ).completion_status;
    check(
      "gdb one-shot accepted an ordinary console command",
      typeof accepted.evidence_id === "string",
      JSON.stringify(observed.one_shot.accepted),
    );
    for (const command of [
      "shell echo contained",
      "!echo contained",
      "info files &",
    ]) {
      const failure = cliFailure([
        "debug-with-gdb",
        command,
        "--inferior-tty",
        controlTty.path,
      ]);
      observed.one_shot[command] = failure === null ? "accepted" : "rejected";
      check(
        `gdb one-shot rejected ${JSON.stringify(command)}`,
        failure !== null,
        observed.one_shot[command],
      );
    }
  } finally {
    await closeInferiorTty(controlTty.helper);
  }
};

const buildFixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "rea-real-reverse-providers-"));
  const source = join(directory, "target.c");
  const binary = join(directory, "target.bin");
  writeFileSync(
    source,
    [
      "#include <stdio.h>",
      "#include <unistd.h>",
      "static int step(int value) { return value * 3 + 1; }",
      "int main(int argc, char **argv) {",
      "  if (argc > 1) sleep(30);",
      "  int accumulated = 0;",
      "  for (int index = 0; index < 4; index += 1) accumulated += step(index);",
      '  printf("%d\\n", accumulated);',
      "  return accumulated > 0 ? 0 : 1;",
      "}",
      "",
    ].join("\n"),
  );
  run("cc", ["-g", "-O0", "-o", binary, source]);
  return { directory, binary };
};

receipt.host.kernel = firstLine("uname", ["-sr"]);
receipt.host.locale = process.env.LC_ALL ?? process.env.LANG ?? null;

let fixtureDirectory;
try {
  const { directory, binary } = buildFixture();
  fixtureDirectory = directory;
  const expectedDigest = digest(binary);
  receipt.fixture = { path: binary, sha256: expectedDigest };

  for (const provider of providers) {
    if (provider === "objdump") await verifyObjdump(binary, expectedDigest);
    else if (provider === "rizin") await verifyRizin(binary, expectedDigest);
    else if (provider === "gdb") await verifyGdb(binary, expectedDigest);
    else {
      receipt.unknowns.push(`unknown provider argument ${provider}`);
      failures += 1;
    }
  }

  // A provider the host cannot supply stays visible as an explicit unknown: an
  // absent entry must never read as verified behaviour.
  for (const entry of skippedProviders) {
    const [provider, ...reason] = entry.split(":");
    const explanation = reason.join(":") || "not installed on this host";
    receipt.providers[provider] = {
      status: "skipped",
      reason: explanation,
      version: null,
    };
    receipt.unknowns.push(`${provider}: ${explanation}`);
  }
} catch (cause) {
  receipt.unknowns.push(
    `lane failure: ${cause instanceof Error ? cause.message : String(cause)}`,
  );
  failures += 1;
} finally {
  if (fixtureDirectory !== undefined)
    rmSync(fixtureDirectory, { recursive: true, force: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`\nreceipt: ${receiptPath}`);
  console.log(
    `providers=${providers.join(",")} assertions=${receipt.assertions.length} failed=${failures}`,
  );
  if (receipt.unknowns.length > 0)
    console.log(`unknowns: ${receipt.unknowns.join(" | ")}`);
  process.exitCode = failures === 0 ? 0 : 1;
}
