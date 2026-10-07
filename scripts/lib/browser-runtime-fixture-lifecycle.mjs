import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnOwnedProviderProcess } from "../../dist/process/ProviderProcess.js";
import { createSystemProcessOwnershipHost } from "../../dist/process/ProcessOwnershipObservation.js";
import { liveProcesses } from "../../dist/process/ProcessOwnershipProcessTree.js";
import { CdpConnection } from "../../dist/browser/CdpConnection.js";

/** Launch only the synthetic fixture browser in its own verified process group. */
export async function startRuntimeFixtureBrowser(executable, origin) {
  const profile = await mkdtemp(join(tmpdir(), "rea-real-web-runtime-"));
  let owned;
  try {
    owned = await spawnOwnedProviderProcess({
      command: executable,
      arguments: [
        "--headless=new",
        ...(process.env.REA_BROWSER_NO_SANDBOX === "true"
          ? ["--no-sandbox"]
          : []),
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-dev-shm-usage",
        "--disable-sync",
        origin,
      ],
      runId: randomUUID(),
      // Installed Chrome launch scripts exec another binary; do not require an argv prefix.
      expectedCommand: null,
    });
    owned.process.stdout?.resume();
    return {
      browser: owned.process,
      profile,
      close: async () => {
        await stopOwnedBrowser(owned, profile);
        await rm(profile, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      },
    };
  } catch (cause) {
    if (owned !== undefined) await stopOwnedBrowser(owned, profile);
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    throw cause;
  }
}

async function stopOwnedBrowser(owned, profile) {
  const child = owned.process;
  const exited =
    child.exitCode === null && child.signalCode === null
      ? once(child, "exit")
      : Promise.resolve();
  void exited.catch(() => undefined);
  let connection;
  let timer;
  const escalation = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }, 2_000);
  try {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        const [port, browserPath] = (
          await readFile(join(profile, "DevToolsActivePort"), "utf8")
        )
          .trim()
          .split("\n");
        assert.match(port, /^\d+$/);
        assert.match(browserPath, /^\/devtools\/browser\/[^\s]+$/);
        const signal = AbortSignal.timeout(2_000);
        connection = await CdpConnection.connect(
          `ws://127.0.0.1:${port}${browserPath}`,
          "inspect_web_page",
          signal,
        );
        // This browser belongs to the verifier; public REA operations never close it.
        await connection.send("Browser.close", {}, undefined, signal);
      } catch {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGTERM");
      }
    }
    if (owned.cleanup !== undefined) {
      const result = await owned.cleanup();
      assert.equal(result.cleaned, true, JSON.stringify(result));
    }
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("Owned fixture browser did not exit after shutdown"),
            ),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(escalation);
    clearTimeout(timer);
    await connection?.close();
  }
  if (process.platform === "win32") return;
  const host = createSystemProcessOwnershipHost();
  const deadline = Date.now() + 5_000;
  while (true) {
    const members = liveProcesses(await host.listProcesses()).filter(
      (member) => member.processGroupId === owned.ownership.processGroupId,
    );
    if (members.length === 0) return;
    if (Date.now() >= deadline)
      throw new Error(
        `Owned fixture group remains: ${JSON.stringify(members.map(({ pid }) => pid))}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Attempt every owned cleanup and retain the original verification failure if cleanup also fails. */
export async function closeRuntimeFixtureResources(tasks, primaryError) {
  const failures = [];
  for (const task of tasks) {
    try {
      await task();
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(
      primaryError === undefined ? failures : [primaryError, ...failures],
      "Runtime fixture cleanup failed",
    );
}
