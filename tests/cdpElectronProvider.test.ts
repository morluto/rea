import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { CdpElectronProvider } from "../src/browser/CdpElectronProvider.js";
import {
  inspectElectronPageInputSchema,
  listElectronTargetsInputSchema,
} from "../src/domain/electronObservation.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "./fixtures/fakeCdpBrowser.js";

describe("CdpElectronProvider", () => {
  const browsers: FakeCdpBrowser[] = [];
  const temporary: string[] = [];

  afterEach(async () => {
    await Promise.all(
      browsers.splice(0).map(async (browser) => browser.close()),
    );
    await Promise.all(
      temporary
        .splice(0)
        .map(async (path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("lists and inspects only canonical file targets beneath approved roots", async () => {
    const root = await electronFixture();
    const index = join(root, "index.html");
    const browser = await startFakeCdpBrowser({
      electronFileUrl: pathToFileURL(index).href,
      duplicateElectronInventory: true,
    });
    browsers.push(browser);
    const provider = new CdpElectronProvider();
    const listed = await provider.listTargets(
      listElectronTargetsInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_file_roots: [root],
        approved: true,
      }),
    );
    if (!listed.ok) throw listed.error;
    expect(listed.value.targets.items).toEqual([
      expect.objectContaining({
        target_id: "electron-page",
        file_path: index,
      }),
    ]);
    expect(listed.value.excluded).toEqual({
      outside_root: 0,
      unsupported_url: 3,
      non_page: 1,
    });

    const inspected = await provider.inspectPage(
      inspectElectronPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_file_roots: [root],
        target_id: "electron-page",
        approved: true,
        observation_ms: 0,
      }),
    );
    if (!inspected.ok) throw inspected.error;
    expect(inspected.value.target.file_path).toBe(index);
    expect(inspected.value.frames).toEqual([
      expect.objectContaining({ file_path: index }),
    ]);
    expect(inspected.value.dom).toMatchObject({ total_nodes: 2 });
    expect(inspected.value.scripts).toMatchObject({
      total: 1,
      items: [
        expect.objectContaining({
          file_path: join(root, "app.js"),
          source: {
            included: false,
            reason: "source capture was not approved",
          },
        }),
      ],
    });
    expect(inspected.value.resources).toEqual([
      expect.objectContaining({ file_path: join(root, "app.js") }),
    ]);
    const methods = browser.commands.map(({ method }) => method);
    expect(methods).not.toContain("Runtime.evaluate");
    expect(methods).not.toContain("Network.enable");
    expect(methods).not.toContain("Debugger.getScriptSource");
    expect(methods).toContain("Target.detachFromTarget");

    const missing = await provider.inspectPage(
      inspectElectronPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_file_roots: [root],
        target_id: "missing",
        approved: true,
        observation_ms: 0,
      }),
    );
    expect(missing).toMatchObject({
      ok: false,
      error: {
        _tag: "BrowserObservationError",
        operation: "inspect_electron_page",
        reason: "target_not_found",
      },
    });
  });

  it("captures Electron script source only after separate approval", async () => {
    const root = await electronFixture();
    const browser = await startFakeCdpBrowser({
      electronFileUrl: pathToFileURL(join(root, "index.html")).href,
    });
    browsers.push(browser);
    const result = await new CdpElectronProvider().inspectPage(
      inspectElectronPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_file_roots: [root],
        target_id: "electron-page",
        approved: true,
        observation_ms: 0,
        include_script_sources: true,
        source_capture_approved: true,
      }),
    );
    if (!result.ok) throw result.error;
    expect(result.value.scripts.items[0]?.source).toMatchObject({
      included: true,
      artifact: { text: "export const observed = 'source-secret';" },
    });
    expect(browser.commands.map(({ method }) => method)).toContain(
      "Debugger.getScriptSource",
    );
  });

  it("rebases DOM parent indexes across allowed file documents", async () => {
    const root = await electronFixture();
    const browser = await startFakeCdpBrowser({
      electronFileUrl: pathToFileURL(join(root, "index.html")).href,
      extraCollections: true,
    });
    browsers.push(browser);
    const result = await new CdpElectronProvider().inspectPage(
      inspectElectronPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_file_roots: [root],
        target_id: "electron-page",
        approved: true,
        observation_ms: 0,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.dom).toMatchObject({
      total_nodes: 4,
      nodes: [
        { index: 0, parent_index: -1 },
        { index: 1, parent_index: 0 },
        { index: 2, parent_index: -1 },
        { index: 3, parent_index: 2 },
      ],
    });
  });

  it("rejects mixed Electron evidence when the main frame navigates", async () => {
    const root = await electronFixture();
    const page = join(root, "index.html");
    const next = join(root, "next.html");
    await writeFile(next, "<html>next</html>");
    const browser = await startFakeCdpBrowser({
      electronFileUrl: pathToFileURL(page).href,
      navigateDuringCaptureUrl: pathToFileURL(next).href,
    });
    browsers.push(browser);
    const result = await new CdpElectronProvider().inspectPage(
      inspectElectronPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_file_roots: [root],
        target_id: "electron-page",
        approved: true,
        observation_ms: 0,
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "BrowserObservationError",
        operation: "inspect_electron_page",
        reason: "target_changed",
      },
    });
  });

  const electronFixture = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "rea-electron-provider-"));
    temporary.push(root);
    await writeFile(join(root, "index.html"), "<script src='app.js'></script>");
    await writeFile(join(root, "app.js"), "export const app = true;");
    await writeFile(join(root, "child.html"), "<div>child</div>");
    return root;
  };
});
