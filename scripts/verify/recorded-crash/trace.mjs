import assert from "node:assert/strict";
import { readdir, readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve } from "node:path";
import { runOwnedCommand } from "../../../dist/process/OwnedCommand.js";

/** Check attempted syscalls, including failed attempts, on a recorded PID that collides with an owned live sentinel. */
export async function verifyCoreInspectionTrace({
  root,
  environment,
  entrypoint,
  core,
  sentinel,
  runId,
}) {
  const gdb = await realpath(environment.REA_PWNDBG_GDB);
  const python = await realpath(environment.REA_PWNTOOLS_PYTHON);
  const plugin = resolve(environment.REA_PWNDBG_GDBINIT, "..");
  const helperPaths = (name) =>
    new Set([
      join(environment.REA_PWNDBG_VENV_PATH, "bin", name),
      ...(environment.PATH ?? "")
        .split(":")
        .filter(isAbsolute)
        .map((directory) => join(directory, name)),
    ]);
  const psPaths = helperPaths("ps");
  const iconvPaths = helperPaths("iconv");
  const gitPaths = helperPaths("git");
  const observations = [];
  for (const mode of ["cli", "mcp"]) {
    sentinel.assertAlive();
    const prefix = join(root, `inspection-${mode}.trace`);
    const invocation =
      mode === "cli"
        ? [
            entrypoint,
            "inspect-recorded-crash",
            core,
            "--debugger-context",
            "--json",
          ]
        : [
            fileURLToPath(new URL("./trace-client.mjs", import.meta.url)),
            entrypoint,
            core,
          ];
    await runOwnedCommand(
      {
        command: environment.REA_VERIFY_STRACE_COMMAND,
        arguments: [
          "-ff",
          "-qq",
          "-s",
          "8192",
          "-e",
          "trace=%process,%network,%file,ptrace,process_vm_readv,process_vm_writev",
          "-o",
          prefix,
          process.execPath,
          ...invocation,
        ],
        cwd: root,
        hostEnvironment: environment,
        expectedCommand: null,
        runId,
      },
      { timeoutMs: 90_000, diagnosticBytes: 1024 * 1024 },
    );
    const executions = [];
    const ownershipReads = [];
    let gdbObserved = false;
    for (const file of await readdir(root)) {
      if (!file.startsWith(`inspection-${mode}.trace.`)) continue;
      const text = await readFile(join(root, file), "utf8");
      const ownershipTrace = text
        .split("\n")
        .some(
          (line) =>
            /^execve\("\/(?:usr\/)?bin\/ps",/u.test(line) &&
            line.includes(
              '["ps", "-axo", "pid=,ppid=,pgid=,uid=,stat=,command="]',
            ) &&
            line.endsWith(" = 0"),
        );
      const pidReads = text
        .split("\n")
        .filter((line) => line.includes(`/proc/${sentinel.pid}/`));
      if (ownershipTrace) {
        for (const line of pidReads) {
          assert.ok(
            new RegExp(
              `/proc/${sentinel.pid}/(?:stat|status|cmdline|wchan|environ)"`,
              "u",
            ).test(line),
            `Unexpected ownership observation of the sentinel: ${line}`,
          );
          ownershipReads.push(line);
        }
      } else
        assert.deepEqual(
          pidReads,
          [],
          `Historical PID caused a provider lookup in ${file}: ${pidReads.join("\n")}`,
        );
      assert.ok(
        !/\bptrace\(/u.test(text),
        `Inspection attempted ptrace: ${file}`,
      );
      assert.ok(
        !/\bprocess_vm_(?:readv|writev)\(/u.test(text),
        `Inspection attempted process memory access: ${file}`,
      );
      assert.ok(
        !/\b(?:socket|connect|sendto|sendmsg)\([^\n]*(?:AF_INET|AF_INET6)/u.test(
          text,
        ),
        `Inspection attempted an Internet socket: ${file}`,
      );
      for (const line of text.split("\n")) {
        if (!/execve(?:at)?\(/u.test(line)) continue;
        const match = /^execve\("([^"]+)"/u.exec(line);
        assert.notEqual(match, null, `Unresolved executable identity: ${line}`);
        assert.ok(
          / = (?:0|-1 [A-Z]+)/u.test(line),
          `Incomplete execution observation: ${line}`,
        );
        const executable = await realpath(match[1]).catch(() => match[1]);
        const ownership =
          psPaths.has(match[1]) &&
          line.includes(
            '["ps", "-axo", "pid=,ppid=,pgid=,uid=,stat=,command="]',
          );
        const iconv =
          iconvPaths.has(match[1]) && line.includes('["iconv", "-l"]');
        const version =
          gitPaths.has(match[1]) &&
          line.includes(
            "[" +
              [
                "git",
                "--git-dir",
                join(plugin, ".git"),
                "rev-parse",
                "--short",
                "HEAD",
              ]
                .map((argument) => JSON.stringify(argument))
                .join(", ") +
              "]",
          );
        assert.ok(
          [process.execPath, python, gdb].includes(executable) ||
            ownership ||
            iconv ||
            version,
          `Unexpected attempted host execution: ${line}`,
        );
        if (executable === gdb) gdbObserved = true;
        executions.push(executable);
      }
    }
    assert.ok(gdbObserved, "Trace must include the actual core-only GDB stage");
    assert.ok(executions.includes(python));
    sentinel.assertAlive();
    observations.push({
      mode,
      executions,
      historical_pid: sentinel.pid,
      sentinel: "still-alive",
      ownership_process_table_reads: ownershipReads,
    });
  }
  return observations;
}
