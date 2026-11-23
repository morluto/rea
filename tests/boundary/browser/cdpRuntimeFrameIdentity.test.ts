import { expect, it } from "vitest";
import { CdpWebRuntimeProvider } from "../../../src/browser/execution/CdpWebRuntimeProvider.js";
import { observeWebExecutionInputSchema } from "../../../src/domain/webExecution.js";
import { inspectWebEventListenersInputSchema } from "../../../src/domain/webEventListeners.js";
import { startRuntimeBrowser } from "../../fixtures/webRuntime.js";
import type { FakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";

const actions = ["execution", "listeners"] as const;
const run = async (
  browser: FakeCdpBrowser,
  action: (typeof actions)[number],
) => {
  const provider = new CdpWebRuntimeProvider();
  const input = {
    cdp_endpoint: browser.endpoint,
    target_id: "allowed-page",
    allowed_origins: [browser.allowedOrigin],
  };
  return action === "execution"
    ? provider.observeExecution(
        observeWebExecutionInputSchema.parse({ ...input, observation_ms: 1 }),
      )
    : provider.inspectEventListeners(
        inspectWebEventListenersInputSchema.parse({
          ...input,
          selector: "#selected",
        }),
      );
};

const documentId = "document-1";
const query = "/app?caller=retained";
const frameTree = (url: string, fields: Record<string, unknown> = {}) => ({
  frameTree: {
    frame: { id: "runtime-main", loaderId: documentId, url, ...fields },
  },
});

it.each([
  ["execution", "#details", "#details", documentId, false],
  ["listeners", "", "", undefined, false],
  ["execution", undefined, "#old", undefined, false],
  ["listeners", "#details", "#details", documentId, true],
] as const)(
  "preserves reported %s identity with split fragment %s",
  async (action, splitFragment, fragment, loaderId, credentials) => {
    const browser = await startRuntimeBrowser({
      commandResult: ({ method }, origin) => {
        if (method !== "Page.getFrameTree") return undefined;
        const host = credentials
          ? origin.replace("://", "://user:password@")
          : origin;
        return frameTree(`${host}${query}#old`, {
          loaderId,
          urlFragment: splitFragment,
        });
      },
    });
    trackBrowser(browser);
    const result = await run(browser, action);
    if (!result.ok) throw result.error;
    expect(result.value.target).toMatchObject({
      frame_id: "runtime-main",
      initial_url: `${browser.allowedOrigin}${query}${fragment}`,
      origin: browser.allowedOrigin,
      loader_id: loaderId ?? null,
    });
  },
);

const foreign = { url: "https://foreign.example/app" };
const badFragment = { urlFragment: 7 };
const changedFragment = { urlFragment: "#changed" };
const changedLoader = { loaderId: "replacement" };
const changed = "target_changed";
const refused = "target_not_allowed";
const invalid = "protocol_error";

it.each([
  ["execution", "equivalent inline fragment", false, "inline", null],
  ["listeners", "fragment change, no loader", false, changedFragment, changed],
  ["execution", "fragment change, same loader", true, changedFragment, null],
  ["listeners", "path change, same loader", true, "new-path", null],
  ["listeners", "malformed fragment", true, badFragment, invalid],
  [
    "listeners",
    "malformed foreign",
    true,
    { ...foreign, ...badFragment },
    refused,
  ],
  [
    "execution",
    "foreign with new loader",
    true,
    { ...foreign, ...changedLoader },
    changed,
  ],
  ["execution", "foreign with same loader", true, foreign, refused],
  ["execution", "missing URL", true, { url: undefined }, invalid],
  ["listeners", "different frame", true, { id: "replacement" }, changed],
  ["execution", "different loader", true, changedLoader, changed],
  ["listeners", "unsupported base", false, { url: "about:blank" }, refused],
] as const)(
  "checks %s document with %s",
  async (action, _label, loader, change, reason) => {
    const browser = await startRuntimeBrowser({
      commandResult: ({ method }, origin, reads) => {
        if (method !== "Page.getFrameTree") return undefined;
        const url = `${origin}${query}`;
        const updated =
          change === "inline"
            ? { url: `${url}#details`, urlFragment: undefined }
            : change === "new-path"
              ? { url: `${origin}/new-path?caller=value` }
              : change;
        return frameTree(url, {
          loaderId: loader ? documentId : undefined,
          urlFragment: "#details",
          ...(reads > 1 ? updated : {}),
        });
      },
    });
    trackBrowser(browser);
    const result = await run(browser, action);
    if (reason === null) {
      if (!result.ok) throw result.error;
      expect(result.value.target).toMatchObject({
        initial_url: `${browser.allowedOrigin}${query}#details`,
        loader_id: loader ? documentId : null,
      });
    } else {
      expect(result).toMatchObject({ ok: false, error: { reason } });
    }
    const methods = browser.commands.map(({ method }) => method);
    expect(methods).toContain("Debugger.disable");
    expect(methods).toContain("Target.detachFromTarget");
  },
);

it.each(actions)(
  "refuses a child root after collecting %s evidence",
  async (action) => {
    let sourceRead = false;
    let returnedChild = false;
    const browser = await startRuntimeBrowser({
      commandResult: ({ method }, origin) => {
        if (method === "Debugger.getScriptSource") sourceRead = true;
        if (method !== "Page.getFrameTree" || !sourceRead) return undefined;
        returnedChild = true;
        return frameTree(`${origin}/app`, { parentId: "enclosing-frame" });
      },
    });
    trackBrowser(browser);
    expect(await run(browser, action)).toMatchObject({
      ok: false,
      error: { reason: "protocol_error" },
    });
    expect(returnedChild).toBe(true);
    expect(browser.commands.map(({ method }) => method)).toEqual(
      expect.arrayContaining(["Debugger.disable", "Target.detachFromTarget"]),
    );
  },
);
