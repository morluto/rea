import assert from "node:assert/strict";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  observeProcessStartIdentity,
  signalProcessWithStartIdentity,
  systemProcessOwnershipHost,
} from "../../dist/process/ProcessOwnershipObservation.js";
import {
  descendantsOf,
  liveProcesses,
} from "../../dist/process/ProcessOwnershipProcessTree.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../../dist/process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../../dist/process/ProcessOwnership.js";
import { readProcessRunTokens } from "../../dist/process/ProcessRunTokenObservations.js";

/** Hold only cancellation-test workers, through the existing limiter override. */
export async function createEvmVerifierGate(root, environment) {
  const preload = join(root, "worker-gate.mjs");
  const limiter = join(root, "gated-prlimit");
  const armed = join(root, "cancellation.armed");
  await writeFile(armed, "", { flag: "wx", mode: 0o600 });
  await writeFile(
    preload,
    `
    import assert from "node:assert/strict";
    import { access, readFile, writeFile } from "node:fs/promises";
    import { dirname } from "node:path";
    let armed = true;
    try { await access(${JSON.stringify(armed)}); }
    catch (cause) { if (cause.code !== "ENOENT") throw cause; armed = false; }
    if (armed) {
    const requestPath = process.argv.at(-1);
    const request = JSON.parse(await readFile(requestPath, "utf8"));
    for (const path of [request.snapshot_path, request.reply_path, request.failure_marker_path])
      assert.equal(dirname(path), dirname(requestPath));
    // Keep the event loop alive before publishing readiness. Cancellation must
    // terminate this actual worker; it cannot complete between observations.
    setInterval(() => {}, 1000);
    await writeFile(requestPath + ".ready", String(process.pid),
      { flag: "wx", mode: 0o600 });
    await new Promise(() => {});
    }
  `,
    { flag: "wx", mode: 0o600 },
  );
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(
    limiter,
    `#!/bin/sh\nexport NODE_OPTIONS=${quote("--import=" + pathToFileURL(preload).href)}\nexec ${quote(environment.REA_EVM_PRLIMIT_COMMAND ?? "/usr/bin/prlimit")} "$@"\n`,
    { flag: "wx", mode: 0o700 },
  );
  return {
    environment: { ...environment, REA_EVM_PRLIMIT_COMMAND: limiter },
    release: () => rm(armed),
  };
}

/** Always retire the owned CLI, including when identity/readiness checks fail. */
export async function withEvmVerifierCli(arguments_, environment, action) {
  const launched = await spawnOwnedProviderProcess({
    command: process.execPath,
    arguments: arguments_,
    hostEnvironment: environment,
    runId: environment.REA_PROCESS_RUN_ID,
  });
  const owner = new ProviderProcessSupervisor(
    {
      ...launched,
      ownsProcessLifetime: true,
      cleanup:
        launched.cleanup ??
        (() => cleanupOwnedProcessGroup(launched.ownership)),
    },
    { maxDiagnosticBytes: 1024 * 1024 },
  );
  const completed = new Promise((resolve) =>
    launched.process.once("close", resolve),
  );
  const waitForClose = async (ms) => {
    const timeout = new AbortController();
    try {
      return await Promise.race([
        completed.then(() => true),
        delay(ms, false, { signal: timeout.signal }),
      ]);
    } finally {
      timeout.abort();
    }
  };
  let result, failure, identity;
  const cleanupFailures = [];
  try {
    identity = await observeProcessStartIdentity(
      launched.process.pid,
      systemProcessOwnershipHost,
      launched.ownership.runId,
    );
    assert.equal(identity?.state, "readable");
    result = await action(launched.process.pid, owner);
  } catch (cause) {
    failure = cause;
  } finally {
    try {
      // Let the CLI retire its independently owned worker before group cleanup.
      if (
        owner.observedExit() === undefined &&
        identity?.state === "readable"
      ) {
        await signalProcessWithStartIdentity(
          launched.process.pid,
          identity.identity,
          "SIGINT",
        );
        await waitForClose(10_000);
      }
    } catch (cause) {
      cleanupFailures.push(cause);
    }
    try {
      const stopped = await owner.stop();
      assert.notEqual(stopped.status, "incomplete", JSON.stringify(stopped));
      assert.equal(await waitForClose(1000), true, "CLI output remained open");
    } catch (cause) {
      cleanupFailures.push(cause);
    }
  }
  if (cleanupFailures.length > 0) {
    const error = new AggregateError(
      [...(failure === undefined ? [] : [failure]), ...cleanupFailures],
      "CLI verifier cleanup failed",
    );
    Object.defineProperty(error, "cleanupOwner", { value: owner });
    throw error;
  }
  if (failure !== undefined) throw failure;
  return result;
}

/** Observe an admitted real worker within this verifier's selected child tree. */
export async function waitForEvmVerifierWorker(parentPid, settled) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const descendants = descendantsOf(
      [parentPid],
      liveProcesses(await systemProcessOwnershipHost.listProcesses()),
    );
    for (const process of descendants) {
      let args;
      try {
        args = (await readFile(`/proc/${process.pid}/cmdline`, "utf8"))
          .split("\0")
          .filter(Boolean);
      } catch (cause) {
        if (cause.code === "ENOENT" || cause.code === "ESRCH") continue;
        throw cause;
      }
      if (
        !args.some((argument) => argument.endsWith("/EvmoleInterfaceWorker.js"))
      )
        continue;
      let token;
      for await (const { observation } of readProcessRunTokens(
        systemProcessOwnershipHost,
        [process],
      ))
        token = observation;
      if (
        token?.state !== "readable" ||
        !token.runId?.startsWith("rea-evm-interface-")
      )
        continue;
      const identity = await observeProcessStartIdentity(
        process.pid,
        systemProcessOwnershipHost,
        token.runId,
      );
      if (identity?.state !== "readable") continue;
      const requestPath = args.at(-1);
      let request;
      try {
        const ready = await readFile(requestPath + ".ready", "utf8");
        assert.equal(ready, String(process.pid));
        request = JSON.parse(await readFile(requestPath, "utf8"));
      } catch (cause) {
        if (cause.code === "ENOENT") continue;
        throw cause;
      }
      assert.equal(dirname(request.snapshot_path), dirname(requestPath));
      return {
        pid: process.pid,
        identity: identity.identity,
        runId: token.runId,
        root: dirname(requestPath),
      };
    }
    assert.equal(
      settled(),
      false,
      "Operation completed before worker observation",
    );
    await delay(5);
  }
  throw new Error("Real EVM worker admission was not observed");
}

/** Distinguish exit/PID reuse from unknown identity, and require root cleanup. */
export async function assertEvmVerifierWorkerReleased(worker) {
  const current = await observeProcessStartIdentity(worker.pid);
  if (current !== undefined) {
    assert.equal(current.state, "readable", "Worker exit identity is unknown");
    assert.notEqual(
      current.identity,
      worker.identity,
      "Owned worker remains live",
    );
  }
  await assert.rejects(access(worker.root), { code: "ENOENT" });
}
