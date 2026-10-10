import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { expect } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { waitForBrowserDevtoolsPort } from "../../../src/browser/BrowserProcessStartup.js";
import {
  inspectWebPageInputSchema,
  listBrowserTargetsInputSchema,
} from "../../../src/domain/browserObservation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  processTest as it,
  waitForExit,
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

// Issue 1586's page, plus the HTML, image, use, and foreign-origin cases the
// real snapshot must distinguish. The test is skipped when no Chrome-family
// executable is installed.
const pageHtml = `<!doctype html><title>x</title>
<svg width="10" height="10">
  <a id="s2" xlink:href="/xl-s2h"><text>s2</text></a>
  <a id="both" xlink:href="/xlink-loses" href="/href-wins"><text>both</text></a>
  <image id="img" xlink:href="/xl-image" />
  <use id="use" xlink:href="/xl-use" />
  <a id="out" xlink:href="https://cdn.example.test/out"><text>out</text></a>
</svg>
<a id="html" xlink:href="/xl-html">html</a>
`;

it.skipIf(chromeExecutable === undefined)(
  "reports the issue page SVG xlink:href links through headless Chrome",
  async ({ processes }) => {
    const executable = chromeExecutable;
    if (executable === undefined) return;
    const profile = await createTestTempDirectory("rea-svg-xlink-");
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(pageHtml);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("SVG fixture server did not bind a TCP port");
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const pageUrl = `${origin}/x.html`;
    let stderr = "";
    const child = processes.spawn(executable, [
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
      "--metrics-recording-only",
      pageUrl,
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
        timeoutMs: 20_000,
      });
      const endpoint = `http://127.0.0.1:${String(port)}`;
      const provider = new CdpBrowserProvider();
      const targetId = await pageTarget(provider, endpoint, origin, pageUrl);
      const result = await provider.inspectPage(
        inspectWebPageInputSchema.parse({
          cdp_endpoint: endpoint,
          allowed_origins: [origin],
          target_id: targetId,
          observation_ms: 0,
        }),
      );
      if (!result.ok) throw result.error;
      const urls = result.value.metadata.dom_urls;
      const html = result.value.dom.nodes.find(
        (node) =>
          node.node_name === "A" && node.attribute_names.includes("xlink:href"),
      );
      expect(html).toBeDefined();
      expect(urls.some((url) => url.node_index === html?.index)).toBe(false);
      expect(urls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            attribute: "href",
            url: `${origin}/xl-s2h`,
            destination_scope: "approved",
          }),
          expect.objectContaining({
            attribute: "href",
            url: `${origin}/href-wins`,
            destination_scope: "approved",
          }),
          expect.objectContaining({
            attribute: "href",
            url: `${origin}/xl-image`,
            destination_scope: "approved",
          }),
          expect.objectContaining({
            attribute: "href",
            url: `${origin}/xl-use`,
            destination_scope: "approved",
          }),
          expect.objectContaining({
            attribute: "href",
            url: null,
            destination_scope: "outside_policy",
          }),
        ]),
      );
      expect(
        urls.some(
          (url) =>
            url.url?.endsWith("/xl-html") === true ||
            url.url?.endsWith("/xlink-loses") === true,
        ),
      ).toBe(false);
      expect(urls.every((url) => url.attribute === "href")).toBe(true);
      expect(urls).toHaveLength(5);
    } finally {
      child.kill("SIGTERM");
      if (!(await waitForExit(child, 2_000))) child.kill("SIGKILL");
      await waitForExit(child, 2_000);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  },
);

const pageTarget = async (
  provider: CdpBrowserProvider,
  endpoint: string,
  origin: string,
  pageUrl: string,
): Promise<string> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const listed = await provider.listTargets(
      listBrowserTargetsInputSchema.parse({
        cdp_endpoint: endpoint,
        allowed_origins: [origin],
      }),
    );
    if (!listed.ok) throw listed.error;
    const match = listed.value.targets.find((target) =>
      target.url.startsWith(pageUrl),
    );
    if (match !== undefined) return match.target_id;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Headless Chrome did not expose the SVG fixture page");
};
