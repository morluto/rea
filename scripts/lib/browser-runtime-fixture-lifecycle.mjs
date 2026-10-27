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
import { importVerifierSource } from "./verifier-source-loader.mjs";

import { requireOrdinaryWindowsVerifierCaller } from "./windows-ordinary-user-verifier.mjs";

const { BROWSER_DEVTOOLS_STARTUP_TIMEOUT_MS, waitForBrowserDevtoolsPort } =
  await importVerifierSource(
    new URL("./browser-process-startup.mts", import.meta.url).href,
    import.meta.url,
  );

/** Launch the synthetic fixture browser and await CDP in its own verified process group. */
export async function startRuntimeFixtureBrowser(executable, origin) {
  await requireOrdinaryWindowsVerifierCaller();
  const profile = await mkdtemp(join(tmpdir(), "rea-real-web-runtime-"));
  let owned;
  try {
    owned = await spawnOwnedProviderProcess({
      command: executable,
      arguments: [
        "--headless=new",
        "--password-store=basic",
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
    let stderr = "";
    owned.process.stderr?.on("data", (chunk) => {
      if (stderr.length < 65536) stderr += chunk;
    });
    const port = await waitForBrowserDevtoolsPort({
      child: owned.process,
      executable,
      activePortPath: join(profile, "DevToolsActivePort"),
      stderr: () => stderr,
      // Match the broader real-browser verifier's allowance for cold Chrome
      // startup on shared runners; early process failures still reject at once.
      timeoutMs: BROWSER_DEVTOOLS_STARTUP_TIMEOUT_MS,
    });
    return {
      port,
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
