import { expect, it } from "vitest";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { CdpWebRuntimeProvider } from "../../../src/browser/execution/CdpWebRuntimeProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { observeWebSessionInputSchema } from "../../../src/domain/browserSession.js";
import { observeWebExecutionInputSchema } from "../../../src/domain/webExecution.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { startRuntimeBrowser } from "../../fixtures/webRuntime.js";
import type { FakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";

const operations = ["inspect", "session", "runtime"] as const;
type Operation = (typeof operations)[number];
const run = async (
  browser: FakeCdpBrowser,
  operation: Operation,
  signal?: AbortSignal,
) => {
  const input = {
    cdp_endpoint: browser.endpoint,
    target_id: "allowed-page",
    allowed_origins: [browser.allowedOrigin],
    observation_ms: 1,
  };
  const options = signal === undefined ? {} : { signal };
  switch (operation) {
    case "inspect":
      return new CdpBrowserProvider().inspectPage(
        inspectWebPageInputSchema.parse(input),
        options,
      );
    case "session":
      return new CdpBrowserProvider().observeSession(
        observeWebSessionInputSchema.parse(input),
        options,
      );
    case "runtime":
      return new CdpWebRuntimeProvider().observeExecution(
        observeWebExecutionInputSchema.parse(input),
        options,
      );
  }
};

const frameReads = (browser: FakeCdpBrowser) =>
  browser.commands.filter(({ method }) => method === "Page.getFrameTree");

const protectedDomain = {
  inspect: "Network.enable",
  session: "Network.enable",
  runtime: "Debugger.enable",
} satisfies Record<Operation, string>;

const selectedFrame = (url: string, fields: Record<string, unknown> = {}) => ({
  frameTree: {
    frame: { id: "runtime-main", loaderId: "document-1", url, ...fields },
  },
});

const startFrameBrowser = async (
  reply: (origin: string, reads: number) => Record<string, unknown> | undefined,
) => {
  const browser = await startRuntimeBrowser({
    commandResult: ({ method }, origin, reads) =>
      method === "Page.getFrameTree" ? reply(origin, reads) : undefined,
  });
  trackBrowser(browser);
  return browser;
};

it.each(operations)(
  "authorizes %s only after the main frame is readable",
  async (operation) => {
    const startupFrames = [
      { id: "runtime-main" },
      { id: "runtime-main", url: "about:blank" },
      { id: "runtime-main", url: "about:srcdoc", urlFragment: 7 },
      {
        id: "runtime-main",
        url: "file:///local.html",
        urlFragment: "bad-fragment",
      },
      { id: "runtime-main", url: "not a URL", urlFragment: 7 },
    ];
    let readsAtEnable: number | undefined;
    const browser = await startRuntimeBrowser({
      commandResult: ({ method }, _origin, reads) => {
        if (method === protectedDomain[operation]) readsAtEnable ??= reads;
        if (method !== "Page.getFrameTree") return undefined;
        const frame = startupFrames[reads - 1];
        if (frame !== undefined) return { frameTree: { frame } };
        return undefined;
      },
    });
    trackBrowser(browser);
    const result = await run(browser, operation);
    if (!result.ok) throw result.error;
    expect(result.value.target).toMatchObject({
      target_id: "allowed-page",
      [operation === "inspect" ? "url" : "initial_url"]:
        `${browser.allowedOrigin}/app`,
    });
    expect(readsAtEnable).toBe(startupFrames.length + 1);
  },
);

it.each([
  { operation: "inspect", fragment: undefined },
  { operation: "session", fragment: 7 },
  { operation: "runtime", fragment: "bad-fragment" },
] as const)(
  "refuses outside-policy $operation before enabling capture",
  async ({ operation, fragment }) => {
    const browser = await startFrameBrowser(() =>
      selectedFrame("https://foreign.example/page", { urlFragment: fragment }),
    );
    const result = await run(browser, operation);
    if (result.ok) throw new Error("Expected origin scope refusal");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "target_unavailable",
      remediation: { action: expect.stringContaining("allowed_origins") },
      details: { reason: "target_not_allowed" },
    });
    expect(frameReads(browser)).toHaveLength(1);
    expect(browser.commands.map(({ method }) => method)).not.toContain(
      protectedDomain[operation],
    );
  },
);

const child = { parentId: "enclosing-frame" };

it.each([
  {
    operation: "inspect",
    defect: "numeric fragment",
    fields: { urlFragment: 7 },
  },
  {
    operation: "runtime",
    defect: "fragment missing delimiter",
    fields: { urlFragment: "bad-fragment" },
  },
  ...operations.map((operation) => ({
    operation,
    defect: "parent on root",
    fields: child,
  })),
] as const)(
  "refuses $operation before capture for $defect",
  async ({ operation, fields }) => {
    const browser = await startFrameBrowser((origin) =>
      selectedFrame(`${origin}/app`, fields),
    );
    expect(await run(browser, operation)).toMatchObject({
      ok: false,
      error: { reason: "protocol_error" },
    });
    expect(frameReads(browser)).toHaveLength(1);
    expect(browser.commands.map(({ method }) => method)).not.toContain(
      protectedDomain[operation],
    );
  },
);

it.each([
  { operation: "inspect", reply: {} },
  { operation: "session", reply: { frameTree: null } },
  { operation: "runtime", reply: { frameTree: [] } },
] as const)(
  "rejects a malformed frame tree reply once for $operation",
  async ({ operation, reply }) => {
    const browser = await startFrameBrowser(() => reply);
    expect(await run(browser, operation)).toMatchObject({
      ok: false,
      error: {
        reason: "protocol_error",
        command: "Page.getFrameTree",
        pointer: "/frameTree",
      },
    });
    expect(frameReads(browser)).toHaveLength(1);
  },
);

it("withholds the final session URL when the proposed root has a parent", async () => {
  const browser = await startFrameBrowser((origin, reads) =>
    reads > 1 ? selectedFrame(`${origin}/child`, child) : undefined,
  );
  const result = await run(browser, "session");
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    target: { initial_url: `${browser.allowedOrigin}/app`, final_url: null },
    window: { end_reason: "window_elapsed" },
    completeness: { unavailable_sections: ["timeline"] },
  });
  expect(frameReads(browser)).toHaveLength(2);
});

it("bounds unsupported malformed frame retries without authorizing execution", async () => {
  const browser = await startFrameBrowser(() =>
    selectedFrame("about:blank", { urlFragment: 7 }),
  );
  const result = await run(browser, "runtime");
  expect(result).toMatchObject({
    ok: false,
    error: { reason: "target_not_allowed" },
  });
  if (result.ok) throw new Error("Expected unresolved frame refusal");
  expect(JSON.stringify(projectAnalysisError(result.error))).not.toContain(
    "outside the permitted HTTP(S) origin scope",
  );
  expect(frameReads(browser)).toHaveLength(80);
  expect(browser.commands.map(({ method }) => method)).not.toContain(
    "Debugger.enable",
  );
});

it("preserves cancellation while an unsupported malformed frame awaits authorization", async () => {
  const controller = new AbortController();
  const browser = await startFrameBrowser(() => {
    setTimeout(() => controller.abort("caller stopped authorization"), 5);
    return selectedFrame("about:blank", { urlFragment: 7 });
  });
  expect(await run(browser, "inspect", controller.signal)).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCancelledError",
      cause: "caller stopped authorization",
    },
  });
  expect(frameReads(browser)).toHaveLength(1);
});
