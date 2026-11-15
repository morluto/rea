import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { basename, dirname } from "node:path";
import { withCommands } from "./command-scope.mjs";

test("unwraps a Windows executable selection before invoking the command owner", async () => {
  const commands = [];
  const result = await withCommands(
    (run) => run("C:\\tools\\adb.exe", ["version"], { environment: {} }),
    {
      platform: "win32",
      prepareOwnership: async () => {},
      runCommand: async (input) => {
        commands.push(input.command);
        return {
          stdout: { text: "selected" },
          stderr: { text: "" },
          exitCode: 0,
        };
      },
    },
  );
  assert.deepEqual(commands, ["C:\\tools\\adb.exe"]);
  assert.equal(result.stdout, "selected");
});

for (const [environment, kind] of [
  [{ PATH: "", PATHEXT: ".EXE" }, "not_found"],
  [{ PATH: "", PATHEXT: ".EXE;C:\\bad" }, "invalid_extension"],
]) {
  test(`refuses Windows ${kind} before preparation or launch`, async () => {
    let preparations = 0;
    let launches = 0;
    await assert.rejects(
      withCommands((run) => run("adb", [], { environment }), {
        platform: "win32",
        prepareOwnership: async () => {
          preparations++;
        },
        runCommand: async () => {
          launches++;
          throw new Error("must not launch");
        },
      }),
      (error) => {
        assert.equal(error.cause.kind, kind);
        assert.match(error.message, /PATH\/PATHEXT/u);
        return true;
      },
    );
    assert.equal(preparations, 0);
    assert.equal(launches, 0);
  });
}

test("resolves bare commands from the captured selected environment", async () => {
  const environment = {
    ...process.env,
    PATH: dirname(process.execPath),
    PATHEXT: ".EXE;.COM",
    REA_EXPERIMENT_ENV: "selected",
  };
  const result = await withCommands((run) => {
    const pending = run(
      basename(process.execPath),
      ["-e", "process.stdout.write(process.env.REA_EXPERIMENT_ENV)"],
      { environment },
    );
    environment.REA_EXPERIMENT_ENV = "changed after admission";
    return pending;
  });
  assert.equal(result.stdout, "selected");
  assert.equal(result.code, 0);
});

test("retains bounded producer diagnostics and a nonzero process outcome", async () => {
  await assert.rejects(
    withCommands((run) =>
      run(process.execPath, [
        "-e",
        "process.stderr.write('fixture refusal');process.exit(9)",
      ]),
    ),
    (error) => {
      assert.equal(error.reason, "process");
      assert.equal(error.snapshot.exitCode, 9);
      assert.equal(error.snapshot.stderr.text, "fixture refusal");
      return true;
    },
  );
});
test("refuses incomplete output instead of accepting a truncated result", async () => {
  await assert.rejects(
    withCommands((run) =>
      run(process.execPath, ["-e", "process.stdout.write('x'.repeat(8192))"], {
        maxBytes: 1024,
      }),
    ),
    (error) => error.reason === "output-limit",
  );
});
test("propagates SIGINT as cancellation without forced termination", async () => {
  const module = new URL("./command-scope.mjs", import.meta.url).href;
  const code = `import {withCommands} from ${JSON.stringify(module)};
import {OwnedCommandFailure} from './dist/process/OwnedCommand.js';
import {isProcessOwnershipInspectionCancellation} from './dist/process/ProcessInspectionCancellation.js';
try { await withCommands(async run => { process.stdout.write('ready\\n'); await run(process.execPath,['-e','setInterval(()=>{},1000)']); }); }
catch (error) {
  const failures = error instanceof AggregateError ? error.errors : [error];
  const cancelled = failures.find(failure => failure instanceof OwnedCommandFailure && failure.reason === 'cancelled');
  const valid = cancelled !== undefined && failures.every(failure => failure === cancelled ||
    (isProcessOwnershipInspectionCancellation(failure) && failure.reason === cancelled.cancellation.reason));
  process.stdout.write(valid ? 'cancelled\\n' : String(error)+'\\n');
  process.exitCode=valid?0:1;
}`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let diagnostic = "";
  child.stderr.on("data", (chunk) => {
    diagnostic += chunk;
  });
  let signalled = false;
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (!signalled && output.includes("ready")) {
      signalled = true;
      child.kill("SIGINT");
    }
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [exit] = await once(child, "close");
    assert.equal(exit, 0, output + diagnostic);
    assert.match(output, /cancelled/u);
  } finally {
    clearTimeout(timeout);
  }
});
