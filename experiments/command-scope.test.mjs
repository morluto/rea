import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  ExperimentCommandCleanupFailure,
  withCommands,
} from "./command-scope.mjs";
import { OwnedCommandFailure } from "../dist/process/OwnedCommand.js";
import { cleanupOwnedProcessGroup } from "../dist/process/ProcessOwnership.js";
import {
  observeProcessStartIdentity,
  observeProcessStartIdentityExit,
} from "../dist/process/ProcessOwnershipObservation.js";

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

test("joins accepted late preparation, preserves controls and seals command admission", async () => {
  let release;
  const prepared = new Promise((resolve) => {
    release = resolve;
  });
  let accepted,
    invocation,
    stopped = 0,
    finished = false;
  const pending = withCommands(
    async (run) => {
      accepted = run;
      void run("selected-tool", ["selected-input"], {
        timeoutMs: 7_311,
        maxBytes: 8_192,
        acceptNonZeroExit: true,
        cwd: "/caller-selected",
        environment: { SELECTED_VALUE: "token=ordinary-input" },
      });
      return "completed observation";
    },
    {
      prepareOwnership: () => prepared,
      runCommand: async (input, limits, options) => {
        invocation = { input, limits };
        options.retainCleanup({
          stop: async () => {
            stopped++;
            return { status: "verified-cleanup" };
          },
        });
        return {
          stdout: { text: "captured" },
          stderr: { text: "" },
          exitCode: 0,
        };
      },
    },
  ).then((value) => {
    finished = true;
    return value;
  });
  try {
    await setImmediate();
    assert.equal(finished, false);
    assert.equal(invocation, undefined);
  } finally {
    release();
  }
  assert.equal(await pending, "completed observation");
  assert.equal(stopped, 1);
  assert.deepEqual(invocation.limits, {
    timeoutMs: 7_311,
    diagnosticBytes: 8_192,
    acceptNonZeroExit: true,
  });
  assert.equal(invocation.input.command, "selected-tool");
  assert.deepEqual(invocation.input.arguments, ["selected-input"]);
  assert.equal(invocation.input.cwd, "/caller-selected");
  assert.deepEqual(invocation.input.hostEnvironment, {
    SELECTED_VALUE: "token=ordinary-input",
  });
  await assert.rejects(
    accepted("too-late", []),
    (error) => error.reason === "cancelled",
  );
});

for (const callbackFails of [false, true])
  test(`retains early child failure ${callbackFails ? "alongside independent callback failure" : "after later callback success"}`, async () => {
    const primary = new Error("independent callback failure");
    let failed;
    const observedFailure = new Promise((resolve) => {
      failed = resolve;
    });
    let commandFailure;
    await assert.rejects(
      withCommands(async (run) => {
        void run(process.execPath, [
          "-e",
          "process.stderr.write('early child refusal');process.exit(9)",
        ]).catch((cause) => {
          commandFailure = cause;
          failed();
        });
        // Synchronize with the failed producer, then finish independent callback
        // work after the pending command has already left the scope's active set.
        await observedFailure;
        await setImmediate();
        assert.equal(
          (
            await run(process.execPath, [
              "-e",
              "process.stdout.write('later success')",
            ])
          ).stdout,
          "later success",
        );
        if (callbackFails) throw primary;
        return "callback succeeded";
      }),
      (error) => {
        assert.equal(commandFailure.reason, "process");
        assert.equal(commandFailure.snapshot.exitCode, 9);
        assert.equal(
          commandFailure.snapshot.stderr.text,
          "early child refusal",
        );
        if (callbackFails) {
          assert(error instanceof AggregateError);
          assert.equal(error.cause, primary);
          assert.deepEqual(error.errors, [primary, commandFailure]);
        } else assert.equal(error, commandFailure);
        return true;
      },
    );
  });

test("preserves primary and late cancellation while retrying only unresolved cleanup owners", async () => {
  const primary = new Error("original verification failure");
  const counts = [0, 0, 0];
  const recovered = [true, false, false];
  let selectedSignal;
  const owners = counts.map((_, index) => ({
    stop: async () => {
      counts[index]++;
      if (index === 1 && !recovered[index]) process.emit("SIGINT");
      return recovered[index]
        ? { status: "verified-cleanup" }
        : { status: "incomplete", reason: `controlled denial ${index}` };
    },
  }));
  const outcome = await withCommands(
    async (run, signal) => {
      selectedSignal = signal;
      await run("controlled-owner", []);
      throw primary;
    },
    {
      prepareOwnership: async () => {},
      runCommand: async (_input, _limits, options) => {
        owners.forEach(options.retainCleanup);
        return {
          stdout: { text: "completed observation" },
          stderr: { text: "" },
          exitCode: 0,
        };
      },
    },
  ).then(
    () => {
      throw new Error("Expected retained cleanup failure");
    },
    (error) => error,
  );
  assert(outcome instanceof AggregateError);
  assert.equal(outcome.cause, primary);
  assert.equal(outcome.errors[0], primary);
  const cancellation = outcome.errors.find(
    (error) => error instanceof OwnedCommandFailure,
  );
  assert.equal(cancellation.reason, "cancelled");
  assert.equal(cancellation.cause, selectedSignal.reason);
  assert.equal(cancellation.cancellation.reason, selectedSignal.reason);
  assert.equal(
    outcome.errors.filter(
      (error) => error instanceof ExperimentCommandCleanupFailure,
    ).length,
    2,
  );
  assert.deepEqual([...outcome.cleanupOwners], owners.slice(1));
  recovered[1] = true;
  await assert.rejects(
    outcome.retryCleanup(),
    (error) => error.cleanupOwners.size === 1,
  );
  assert.deepEqual([...outcome.cleanupOwners], [owners[2]]);
  recovered[2] = true;
  await outcome.retryCleanup();
  await outcome.retryCleanup();
  assert.equal(outcome.cleanupOwners.size, 0);
  assert.deepEqual(counts, [1, 2, 3]);
});

test(
  "owns repeated signals through final retained-owner cleanup",
  {
    skip:
      process.platform === "win32" ? "POSIX signal delivery control" : false,
    timeout: 20_000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-command-finalize-"));
    const cleanup = join(root, "cleanup.ready");
    const cancelled = join(root, "cancelled.json");
    const checkpoint = join(root, "checkpoint");
    const alive = join(root, "cleanup.still-owned");
    const release = join(root, "release");
    const module = new URL("./command-scope.mjs", import.meta.url).href;
    const code = `import {existsSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {withCommands} from ${JSON.stringify(module)};
let firstReason,stops=0;
const owner={stop:async()=>{
  stops++; writeFileSync(${JSON.stringify(cleanup)},'ready');
  while(!existsSync(${JSON.stringify(release)})) {
    if(existsSync(${JSON.stringify(checkpoint)})) writeFileSync(${JSON.stringify(alive)},'held');
    await delay(10);
  }
  return {status:'verified-cleanup'};
}};
try {
  await withCommands(async(run,signal)=>{
    signal.addEventListener('abort',()=>{firstReason=signal.reason;writeFileSync(${JSON.stringify(cancelled)},JSON.stringify({reason:firstReason.message}));},{once:true});
    return run('controlled-owner',[]);
  },{
    prepareOwnership:async()=>{},
    runCommand:async(_input,_limits,options)=>{options.retainCleanup(owner);return {stdout:{text:'completed observation'},stderr:{text:''},exitCode:0};},
  });
  throw new Error('Finalization cancellation was reported as success');
} catch(error) {
  process.stdout.write(JSON.stringify({reason:error.reason,cause_matches:error.cause===firstReason,cancellation_matches:error.cancellation?.reason===firstReason,stops,listeners:[process.listenerCount('SIGINT'),process.listenerCount('SIGTERM')]})+'\\n');
  process.exitCode=error.reason==='cancelled'?0:1;
}`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      diagnostic = "",
      ended = false;
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      diagnostic += chunk;
    });
    child.once("close", () => {
      ended = true;
    });
    const closed = once(child, "close");
    void closed.catch(() => {});
    const waitFor = async (path) => {
      const deadline = Date.now() + 10_000;
      while (!existsSync(path)) {
        assert.equal(ended, false, output + diagnostic);
        assert(Date.now() < deadline, `Missing lifecycle marker ${path}`);
        await delay(20);
      }
    };
    try {
      await waitFor(cleanup);
      assert.equal(child.kill("SIGINT"), true);
      await waitFor(cancelled);
      assert.equal(child.kill("SIGINT"), true);
      assert.equal(child.kill("SIGTERM"), true);
      await writeFile(checkpoint, "observe continued cleanup");
      await waitFor(alive);
      await writeFile(release, "release");
      const [exit, signal] = await closed;
      assert.equal(exit, 0, output + diagnostic);
      assert.equal(signal, null, output + diagnostic);
      assert.deepEqual(JSON.parse(output), {
        reason: "cancelled",
        cause_matches: true,
        cancellation_matches: true,
        stops: 1,
        listeners: [0, 0],
      });
    } finally {
      await writeFile(release, "release");
      if (!ended) child.kill("SIGKILL");
      await closed.catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "cancels a ready owned child and verifies its exact process has exited",
  {
    skip:
      process.platform === "win32"
        ? "POSIX process-group signal verification"
        : false,
  },
  async () => {
    const scope = await mkdtemp(join(tmpdir(), "rea-command-scope-"));
    const marker = join(scope, "child.ready");
    // The marker is written by the owned long-running child itself, so the
    // parent only signals once cancellation must interrupt an active child
    // rather than ownership preparation.
    const grandchild = `import {writeFileSync,renameSync} from 'node:fs';
writeFileSync(${JSON.stringify(marker + ".tmp")}, JSON.stringify({pid:process.pid,runId:process.env.REA_PROCESS_RUN_ID}), {flag:'wx'});
renameSync(${JSON.stringify(marker + ".tmp")}, ${JSON.stringify(marker)});
setInterval(()=>{},1000);`;
    const module = new URL("./command-scope.mjs", import.meta.url).href;
    const code = `import {withCommands} from ${JSON.stringify(module)};
try { await withCommands(async run => { await run(process.execPath,['-e',${JSON.stringify(grandchild)}]); }); }
catch (error) { process.stdout.write(error.reason+'\\n'); process.exitCode=error.reason==='cancelled'?0:1; }`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let diagnostic = "";
    child.stderr.on("data", (chunk) => {
      diagnostic += chunk;
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    const closed = once(child, "close");
    void closed.catch(() => {});
    let wrapperClosed = false;
    child.once("close", () => {
      wrapperClosed = true;
    });
    const timeout = setTimeout(() => {
      if (!wrapperClosed) child.kill("SIGKILL");
    }, 10_000);
    let ownership;
    let childIdentity;
    const readOwnership = async () => {
      const ready = JSON.parse(await readFile(marker, "utf8"));
      assert(Number.isSafeInteger(ready.pid) && ready.pid > 0);
      assert.equal(typeof ready.runId, "string");
      assert(ready.runId.length > 0);
      return {
        runId: ready.runId,
        leaderPid: ready.pid,
        processGroupId: ready.pid,
      };
    };
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(marker)) {
        assert.equal(wrapperClosed, false, output + diagnostic);
        if (Date.now() > deadline)
          throw new Error("owned child never started", { cause: output });
        await delay(50);
      }
      ownership = await readOwnership();
      const identity = await observeProcessStartIdentity(
        ownership.leaderPid,
        undefined,
        ownership.runId,
      );
      assert.equal(
        identity?.state,
        "readable",
        "The actual child must be live and token-owned before cancellation",
      );
      childIdentity = identity.identity;
      assert.equal(
        await observeProcessStartIdentityExit(
          ownership.leaderPid,
          identity.identity,
        ),
        "present",
      );
      assert.equal(child.kill("SIGINT"), true);
      const [exit, signal] = await closed;
      assert.equal(exit, 0, output + diagnostic);
      assert.equal(signal, null, output + diagnostic);
      assert.match(output, /cancelled/u);
      assert.equal(
        await observeProcessStartIdentityExit(
          ownership.leaderPid,
          identity.identity,
        ),
        "exited",
        "Reporting cancellation must not leave the actual owned child alive",
      );
    } finally {
      clearTimeout(timeout);
      if (!wrapperClosed) child.kill("SIGKILL");
      await closed.catch(() => {});
      // Preserve safe fallback cleanup even if readiness or the exit oracle fails.
      // This runs after the assertion, so it cannot turn leaked work into a pass.
      if (ownership === undefined && existsSync(marker))
        ownership = await readOwnership();
      if (ownership !== undefined) {
        const cleanup = await cleanupOwnedProcessGroup(ownership);
        assert.equal(cleanup.cleaned, true, JSON.stringify(cleanup));
        if (childIdentity !== undefined) {
          const deadline = Date.now() + 5000;
          let exit = await observeProcessStartIdentityExit(
            ownership.leaderPid,
            childIdentity,
          );
          while (exit === "present" && Date.now() < deadline) {
            await delay(25);
            exit = await observeProcessStartIdentityExit(
              ownership.leaderPid,
              childIdentity,
            );
          }
          assert.equal(
            exit,
            "exited",
            "Fallback cleanup must confirm the same child's exit",
          );
        }
      }
      await rm(scope, { recursive: true, force: true });
    }
  },
);
