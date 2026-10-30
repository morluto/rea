import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../../dist/process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../../dist/process/ProcessOwnership.js";
import { ArtifactResourceScope } from "../../dist/artifacts/ArtifactResourceScope.js";
import { AnalysisCleanupLease } from "../../dist/artifacts/AnalysisCleanupLease.js";
import { withVerifierCleanup } from "./verifier-cleanup.mjs";
import { CdpConnection } from "../../dist/browser/CdpConnection.js";
import { importVerifierSource } from "./verifier-source-loader.mjs";

import { requireOrdinaryWindowsVerifierCaller } from "./windows-ordinary-user-verifier.mjs";

const { BROWSER_DEVTOOLS_STARTUP_TIMEOUT_MS, waitForBrowserDevtoolsPort } =
  await importVerifierSource(
    new URL("./browser-process-startup.mts", import.meta.url).href,
    import.meta.url,
  );

/** Launch the verifier browser and await CDP in its own verified process group. */
export async function startRuntimeFixtureBrowser(executable, initialUrl) {
  await requireOrdinaryWindowsVerifierCaller();
  const profile = await mkdtemp(join(tmpdir(), "rea-real-web-runtime-"));
  let supervisor;
  let stopOwnedBrowser;
  const resources = new ArtifactResourceScope();
  const cleanup = async () => {
    if (stopOwnedBrowser !== undefined) await stopOwnedBrowser();
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  };
  resources.retain({
    kind: "lease",
    resource: profile,
    lease: AnalysisCleanupLease.forCloseOwner({ close: cleanup }, profile),
  });
  const close = () => resources.close();
  try {
    const owned = await spawnOwnedProviderProcess({
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
        "--metrics-recording-only",
        initialUrl,
      ],
      runId: randomUUID(),
      // Installed Chrome launch scripts exec another binary; do not require an argv prefix.
      expectedCommand: null,
    });
    supervisor = new ProviderProcessSupervisor(
      {
        ...owned,
        ownsProcessLifetime: true,
        cleanup:
          owned.cleanup ?? (() => cleanupOwnedProcessGroup(owned.ownership)),
      },
      {
        maxDiagnosticBytes: { stdout: 0, stderr: 65_536 },
        onDiagnostic: (event) => {
          if (event.type === "error")
            process.stderr.write(
              `Browser verifier process error: ${event.message}\n`,
            );
        },
      },
    );
    stopOwnedBrowser = createOwnedBrowserStop(supervisor, profile);
    const port = await waitForBrowserDevtoolsPort({
      child: owned.process,
      executable,
      activePortPath: join(profile, "DevToolsActivePort"),
      stderr: () => supervisor.snapshot().stderr.text,
      // Match the broader real-browser verifier's allowance for cold Chrome
      // startup on shared runners; early process failures still reject at once.
      timeoutMs: BROWSER_DEVTOOLS_STARTUP_TIMEOUT_MS,
    });
    return { port, profile, process: owned.process, close };
  } catch (cause) {
    return withVerifierCleanup(async () => {
      throw cause;
    }, [close]);
  }
}

function createOwnedBrowserStop(supervisor, profile) {
  let connection;
  return async () => {
    const child = supervisor.launch.process;
    try {
      if (
        connection === undefined &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        try {
          const [port, browserPath] = (
            await readFile(join(profile, "DevToolsActivePort"), "utf8")
          )
            .trim()
            .split("\n");
          assert.match(port, /^\d+$/);
          assert.match(browserPath, /^\/devtools\/browser\/[^\s]+$/);
          const signal = AbortSignal.timeout(2_000);
          await CdpConnection.connect(
            `ws://127.0.0.1:${port}${browserPath}`,
            "inspect_web_page",
            signal,
            undefined,
            (opened) => {
              connection = opened;
            },
          );
          await connection.send("Browser.close", {}, undefined, signal);
        } catch {
          // CDP may be unavailable or already closing. The supervisor still owns
          // verified process-tree termination, including descendants and retries.
        }
      }
    } finally {
      await withVerifierCleanup(async () => {
        const stopped = await supervisor.stop();
        assert.notEqual(stopped.status, "incomplete", JSON.stringify(stopped));
      }, [
        async () => {
          await connection?.close();
          connection = undefined;
        },
      ]);
    }
  };
}
