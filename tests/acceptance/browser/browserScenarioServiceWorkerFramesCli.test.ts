import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";

import { expect } from "vitest";
import { z } from "zod";

import { waitForBrowserDevtoolsPort } from "../../../src/browser/BrowserProcessStartup.js";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { listBrowserTargetsInputSchema } from "../../../src/domain/browserObservation.js";
import { browserScenarioCaptureSchema } from "../../../src/domain/browserScenarioCapture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  processTest as it,
  waitForExit,
  type TestProcesses,
} from "../../support/process/processFixture.js";

const chromeExecutable = [
  process.env.REA_BROWSER_EXECUTABLE,
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find(
  (candidate): candidate is string =>
    typeof candidate === "string" &&
    candidate.length > 0 &&
    existsSync(candidate),
);

const CHROME_STARTUP_TIMEOUT_MS = 60_000;
const CLI_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = CHROME_STARTUP_TIMEOUT_MS + 2 * CLI_TIMEOUT_MS;

const listen = async (
  route: (path: string) => string,
): Promise<{ readonly server: Server; readonly origin: string }> => {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    response.setHeader(
      "content-type",
      `${path.endsWith(".js") ? "text/javascript" : "text/html"}; charset=utf-8`,
    );
    response.end(route(path));
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Service-worker frame fixture did not bind a TCP port");
  return { server, origin: `http://127.0.0.1:${String(address.port)}` };
};

// Chromium gives about:blank and blob: documents no service-worker container,
// and sandboxed documents without allow-same-origin an opaque origin. None of
// them can be controlled; same-origin descendants share their parent's
// registrations, even through a container-less parent. An about:blank whose
// initiator origin differs from its parent's, or a credentialless frame whose
// nonced partition differs from its same-origin parent's, has no frame that
// can report its registrations.
const startSites = async () => {
  const nested = await listen((path) =>
    path === "/nest"
      ? '<!doctype html><iframe src="/leaf"></iframe><iframe></iframe>'
      : "<!doctype html><p>leaf</p>",
  );
  const selected = await listen((path) => {
    if (path === "/frames")
      return `<!doctype html><p id="state">loading</p>
        <iframe></iframe>
        <iframe src="about:blank"></iframe>
        <iframe srcdoc="<p>srcdoc</p>"></iframe>
        <iframe src="data:text/html,<p>data</p>"></iframe>
        <iframe sandbox src="/child"></iframe>
        <iframe sandbox="allow-scripts" src="/child"></iframe>
        <iframe src="${nested.origin}/nest"></iframe>
        <script>
          const written = document.createElement("iframe");
          document.body.append(written);
          written.contentDocument.write("<p>written</p><iframe></iframe>");
          written.contentDocument.close();
          const blob = document.createElement("iframe");
          blob.src = URL.createObjectURL(
            new Blob(["<p>blob</p>"], { type: "text/html" }),
          );
          document.body.append(blob);
          onload = () => { document.querySelector("#state").dataset.ready = "true"; };
        </script>`;
    if (path === "/cross-initiator")
      return `<!doctype html><p id="state">loading</p>
        <iframe src="${nested.origin}/nest"></iframe>
        <script>
          onload = () => {
            frames[0].frames[0].location.href = "about:blank";
            const ready = () => {
              try {
                if (frames[0].frames[0].location.href === "about:blank") {
                  document.querySelector("#state").dataset.ready = "true";
                  return;
                }
              } catch {}
              setTimeout(ready, 10);
            };
            ready();
          };
        </script>`;
    // Registered before REA attaches, so the scenario policy cannot block it.
    if (path === "/credentialless-registered")
      return `<!doctype html><title>loading</title>
        <iframe credentialless src="/register-then-blank"></iframe>
        <script>
          const registered = () => {
            try {
              if (document.title === "registering" &&
                  frames[0].location.href === "about:blank") {
                document.title = "registered";
                return;
              }
            } catch {}
            setTimeout(registered, 10);
          };
          registered();
        </script>`;
    if (path === "/register-then-blank")
      return `<!doctype html><script>
          navigator.serviceWorker.register("/sw.js")
            .then(() => navigator.serviceWorker.ready)
            .then(() => {
              parent.document.title = "registering";
              location.href = "about:blank";
            });
        </script>`;
    if (path === "/sw.js")
      return 'self.addEventListener("install", () => self.skipWaiting());';
    if (path === "/ready")
      return '<!doctype html><p id="state" data-ready="true">ready</p>';
    return "<!doctype html><p>child</p>";
  });
  return {
    origin: selected.origin,
    close: async () => {
      for (const { server } of [selected, nested]) {
        server.closeAllConnections();
        await new Promise<void>((resolveClose) => {
          server.close(() => resolveClose());
        });
      }
    },
  };
};

const pageTarget = async (
  endpoint: string,
  origin: string,
  attached: { readonly path: string; readonly title?: string },
): Promise<string> => {
  const provider = new CdpBrowserProvider();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const listed = await provider.listTargets(
      listBrowserTargetsInputSchema.parse({
        cdp_endpoint: endpoint,
        allowed_origins: [origin],
      }),
    );
    if (!listed.ok) throw listed.error;
    const match = listed.value.targets.find(
      (target) =>
        target.url.startsWith(`${origin}${attached.path}`) &&
        (attached.title === undefined || target.title === attached.title),
    );
    if (match !== undefined) return match.target_id;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("Headless Chrome did not expose the fixture page");
};

const withAttachedChrome = async (
  processes: TestProcesses,
  executable: string,
  verify: (attached: {
    readonly origin: string;
    readonly capture: (path: string) => Promise<unknown>;
  }) => Promise<void>,
  attached: { readonly path: string; readonly title?: string } = {
    path: "/start",
  },
): Promise<void> => {
  const profile = await createTestTempDirectory("rea-sw-frames-");
  const sites = await startSites();
  let stderr = "";
  const child = processes.spawn(executable, [
    "--headless=new",
    ...(process.env.REA_BROWSER_NO_SANDBOX === "true" ? ["--no-sandbox"] : []),
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
    `${sites.origin}${attached.path}`,
  ]);
  child.stdout.on("data", () => undefined);
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 8_192) stderr += chunk.toString("utf8");
  });
  try {
    const port = await waitForBrowserDevtoolsPort({
      child,
      executable,
      activePortPath: join(profile, "DevToolsActivePort"),
      stderr: () => stderr,
      timeoutMs: CHROME_STARTUP_TIMEOUT_MS,
    });
    const endpoint = `http://127.0.0.1:${String(port)}`;
    const targetId = await pageTarget(endpoint, sites.origin, attached);
    await verify({
      origin: sites.origin,
      capture: async (path) => {
        const result = await processes.run(
          process.execPath,
          [
            resolve("scripts/rea.mjs"),
            "capture-browser-scenario",
            JSON.stringify({
              browser: {
                mode: "connect",
                cdp_endpoint: endpoint,
                target_id: targetId,
              },
              start_url: { url: `${sites.origin}${path}` },
              actions: [
                {
                  step_id: "frames-ready",
                  action: "wait_for",
                  locator: {
                    kind: "css",
                    selector: "#state[data-ready='true']",
                  },
                  state: "visible",
                },
              ],
            }),
            "--json",
          ],
          { timeoutMs: CLI_TIMEOUT_MS },
        );
        return JSON.parse(result.stdout);
      },
    });
  } finally {
    child.kill("SIGTERM");
    if (!(await waitForExit(child, 2_000))) child.kill("SIGKILL");
    await waitForExit(child, 2_000);
    await sites.close();
  }
};

it.skipIf(chromeExecutable === undefined)(
  "captures attached pages whose frames cannot be service-worker clients",
  async ({ processes }) => {
    const executable = chromeExecutable;
    if (executable === undefined) return;
    await withAttachedChrome(processes, executable, async ({ capture }) => {
      const document = await capture("/frames");
      const succeeded = z
        .object({ normalized_result: z.unknown() })
        .safeParse(document);
      expect(succeeded.success, JSON.stringify(document)).toBe(true);
      const result = browserScenarioCaptureSchema.parse(
        succeeded.data?.normalized_result,
      );
      expect(result.steps.map(({ status }) => status)).toEqual([
        "completed",
        "completed",
      ]);
      expect(result.browser.cleanup).toBe("disconnected-external");
    });
  },
  TEST_TIMEOUT_MS,
);

it.skipIf(chromeExecutable === undefined)(
  "names unresolved frame service-worker state instead of a generic failure",
  async ({ processes }) => {
    const executable = chromeExecutable;
    if (executable === undefined) return;
    await withAttachedChrome(processes, executable, async ({ capture }) => {
      const document = await capture("/cross-initiator");
      expect(document).toMatchObject({
        error: "Browser scenario capture failed",
        code: "target_unavailable",
        category: "unavailable",
        message: expect.stringContaining("could not determine"),
        remediation: {
          action: expect.stringContaining(
            "environment.service_workers to allow",
          ),
        },
        details: {
          operation: "capture_browser_scenario",
          reason: "service_worker_state_unknown",
          diagnostics: { frame_state: "no_same_partition_container" },
          partial_observation: {
            kind: "browser-scenario-observation",
          },
        },
      });
    });
  },
  TEST_TIMEOUT_MS,
);

it.skipIf(chromeExecutable === undefined)(
  "keeps a credentialless frame's partition unknown despite a same-origin parent",
  async ({ processes }) => {
    const executable = chromeExecutable;
    if (executable === undefined) return;
    await withAttachedChrome(
      processes,
      executable,
      async ({ capture }) => {
        // The attached page's credentialless frame registered a worker in its
        // nonced partition, then became about:blank; its parent sees none.
        const document = await capture("/ready");
        expect(document).toMatchObject({
          error: "Browser scenario capture failed",
          code: "target_unavailable",
          details: {
            operation: "capture_browser_scenario",
            reason: "service_worker_state_unknown",
            diagnostics: { frame_state: "no_same_partition_container" },
          },
        });
      },
      { path: "/credentialless-registered", title: "registered" },
    );
  },
  TEST_TIMEOUT_MS,
);
