import { crc32 } from "node:zlib";
import { describe, expect, it, onTestFinished } from "vitest";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { captureWebScreenshotInputSchema } from "../../../src/domain/webScreenshot.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import {
  startFakeCdpBrowser,
  type FakeOptions,
} from "../../fixtures/fakeCdpBrowser.js";
import { frameNavigated } from "./cdpBrowserProvider.support.js";

const captureWithFake = async (options: FakeOptions) => {
  const browser = await startFakeCdpBrowser(options);
  onTestFinished(() => browser.close());
  const result = await new CdpBrowserProvider().captureScreenshot(
    captureWebScreenshotInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
    }),
  );
  return { browser, result };
};

// These wire tests validate PNG headers; actual rendering has its own browser lane.
const screenshotData = (width: number, height: number) => {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
    "base64",
  );
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
  return { data: bytes.toString("base64") };
};

const withCssViewport = (metrics: Readonly<Record<string, unknown>>) => ({
  ...metrics,
  cssVisualViewport: metrics.visualViewport,
});

describe("screenshot authorization during metrics reads", () => {
  it("explains current-document origin refusal without suggesting host installation repair", async () => {
    const { browser, result } = await captureWithFake({
      attachedFrameUrl: "https://outside.example.test/",
    });
    if (result.ok) throw new Error("Expected a scope refusal");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "target_unavailable",
      message: expect.stringContaining(
        "outside the permitted HTTP(S) origin scope",
      ),
      remediation: { action: expect.stringContaining("allowed_origins") },
      details: { reason: "target_not_allowed" },
    });
    expect(
      browser.commands.some(
        ({ method }) => method === "Page.captureScreenshot",
      ),
    ).toBe(false);
  });
  it("stops at either metrics read when navigation invalidates capture", async () => {
    const viewport = {
      pageX: 0,
      pageY: 0,
      clientWidth: 2,
      clientHeight: 2,
      scale: 1,
    };
    const beforeAndAfter = [
      { read: 1, captures: 0 },
      { read: 2, captures: 1 },
    ];
    const foreign = "https://outside.test/";
    const scenarios = [
      ...beforeAndAfter.flatMap((phase) => [
        {
          ...phase,
          url: foreign,
          identity: { id: "frame-main", loaderId: "outside-loader" },
          reason: "target_changed",
        },
        {
          ...phase,
          url: foreign,
          identity: { id: "frame-main" },
          reason: "target_not_allowed",
        },
      ]),
      {
        read: 1,
        captures: 0,
        identity: { id: "frame-main", loaderId: "new-loader" },
        reason: "target_changed",
      },
      {
        read: 1,
        captures: 0,
        identity: { id: "candidate-root", parentId: "candidate-root" },
        reason: "protocol_error",
      },
    ] as const;
    let scenario: (typeof scenarios)[number] | undefined;
    let reads = 0;
    const browser = await startFakeCdpBrowser({
      eventsBeforeReply: ["Page.getLayoutMetrics"],
      commandResult: ({ method }) =>
        method === "Page.getLayoutMetrics"
          ? withCssViewport({ visualViewport: viewport })
          : undefined,
      commandEvents: (command, origin) =>
        command.method === "Page.getLayoutMetrics" &&
        scenario !== undefined &&
        ++reads === scenario.read
          ? [
              frameNavigated(command, {
                ...scenario.identity,
                url:
                  "url" in scenario
                    ? scenario.url
                    : `${origin}/app?token=frame-secret`,
              }),
            ]
          : undefined,
    });
    onTestFinished(() => browser.close());
    const provider = new CdpBrowserProvider();
    const input = captureWebScreenshotInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
    });
    try {
      for (const transition of scenarios) {
        scenario = transition;
        reads = 0;
        const label = `metrics read ${transition.read}: ${JSON.stringify(transition.identity)}`;
        const before = browser.commands.length;
        expect(await provider.captureScreenshot(input), label).toMatchObject({
          ok: false,
          error: { reason: transition.reason },
        });
        expect(
          browser.commands
            .slice(before)
            .filter(({ method }) => method === "Page.captureScreenshot"),
          label,
        ).toHaveLength(transition.captures);
        await expect.poll(() => browser.activeConnectionCount()).toBe(0);
      }
    } finally {
      await provider.close();
    }
  });
});

describe("screenshot initial root identity", () => {
  it("requires a valid root before measuring or capturing even with a readable child", async () => {
    const invalidRoots = [
      { label: "missing ID", identity: {} },
      { label: "wrong ID type", identity: { id: 7 } },
      { label: "empty ID", identity: { id: "" } },
      {
        label: "parented root",
        identity: { id: "frame-main", parentId: "parent" },
      },
      {
        label: "malformed parent",
        identity: { id: "frame-main", parentId: null },
      },
      {
        label: "self parent",
        identity: { id: "frame-main", parentId: "frame-main" },
      },
    ];
    let identity: Readonly<Record<string, unknown>> = {};
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }, origin) =>
        method === "Page.getFrameTree"
          ? {
              frameTree: {
                frame: { ...identity, url: `${origin}/app?token=frame-secret` },
                childFrames: [
                  {
                    frame: {
                      id: "frame-child",
                      parentId: "frame-main",
                      url: `${origin}/child`,
                    },
                  },
                ],
              },
            }
          : undefined,
    });
    onTestFinished(() => browser.close());
    const provider = new CdpBrowserProvider();
    const input = captureWebScreenshotInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
    });
    try {
      for (const invalid of invalidRoots) {
        identity = invalid.identity;
        const before = browser.commands.length;
        const result = await provider.captureScreenshot(input);
        if (result.ok) throw new Error(`Expected refusal for ${invalid.label}`);
        expect(projectAnalysisError(result.error), invalid.label).toMatchObject(
          {
            code: "unreadable_output",
            details: { reason: "protocol_error" },
          },
        );
        const methods = browser.commands
          .slice(before)
          .map(({ method }) => method);
        expect(methods, invalid.label).not.toContain("Page.getLayoutMetrics");
        expect(methods, invalid.label).not.toContain("Page.captureScreenshot");
      }

      identity = { id: "frame-main", loaderId: "loader-main" };
      const valid = await provider.captureScreenshot(input);
      if (!valid.ok) throw valid.error;
      expect(valid.value.target).toMatchObject({
        target_id: "allowed-page",
        url: `${browser.allowedOrigin}/app?token=frame-secret`,
      });
      expect(valid.value.viewport).toEqual({ width: 1, height: 1 });
    } finally {
      await provider.close();
    }
    await expect.poll(() => browser.activeConnectionCount()).toBe(0);
  });

  it("retains a known foreign origin refusal when the root ID is malformed", async () => {
    const { browser, result } = await captureWithFake({
      commandResult: ({ method }) =>
        method === "Page.getFrameTree"
          ? {
              frameTree: {
                frame: { id: 7, url: "https://outside.example/page" },
              },
            }
          : undefined,
    });
    if (result.ok) throw new Error("Expected known origin refusal");
    expect(projectAnalysisError(result.error)).toMatchObject({
      message: expect.stringContaining(
        "outside the permitted HTTP(S) origin scope",
      ),
      remediation: { action: expect.stringContaining("allowed_origins") },
      details: { reason: "target_not_allowed" },
    });
    expect(browser.commands.map(({ method }) => method)).not.toContain(
      "Page.captureScreenshot",
    );
  });
});

describe("screenshot viewport freshness", () => {
  it.each([
    { phase: "normal capture", imageSize: 4 },
    { phase: "before recovery", imageSize: 1 },
  ])("rejects scrolling $phase without retrying", async ({ imageSize }) => {
    let reads = 0;
    const { browser, result } = await captureWithFake({
      commandResult: ({ method }) =>
        method === "Page.getLayoutMetrics"
          ? withCssViewport({
              visualViewport: {
                pageX: 0,
                pageY: ++reads === 1 ? 0 : 50,
                clientWidth: 4,
                clientHeight: 4,
                scale: 1,
              },
            })
          : method === "Page.captureScreenshot"
            ? screenshotData(imageSize, imageSize)
            : undefined,
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        reason: "target_changed",
        detail: expect.stringContaining("visual viewport changed"),
      },
    });
    expect(
      browser.commands.filter(
        ({ method }) => method === "Page.captureScreenshot",
      ),
    ).toHaveLength(1);
  });

  it("rejects independently changed CSS size, zoom, and pixel dimensions during recovery", async () => {
    const base = {
      pageX: 0,
      pageY: 0,
      clientWidth: 4,
      clientHeight: 4,
      scale: 1,
    };
    const changes = [
      { label: "CSS width", css: { clientWidth: 8 }, pixels: {} },
      { label: "page zoom", css: { scale: 2 }, pixels: { scale: 2 } },
      { label: "pixel width", css: {}, pixels: { clientWidth: 8 } },
      { label: "pixel height", css: {}, pixels: { clientHeight: 8 } },
    ];
    let change: (typeof changes)[number] | undefined;
    let metricsReads = 0;
    let captures = 0;
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) => {
        if (method === "Page.getLayoutMetrics") {
          const current = ++metricsReads >= 3 ? change : undefined;
          return {
            cssVisualViewport: { ...base, ...current?.css },
            visualViewport: { ...base, ...current?.pixels },
          };
        }
        if (method === "Page.captureScreenshot")
          return ++captures === 1
            ? screenshotData(1, 1)
            : screenshotData(16, 16);
        return undefined;
      },
    });
    onTestFinished(() => browser.close());
    const input = captureWebScreenshotInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
    });
    const provider = new CdpBrowserProvider();
    try {
      for (const scenario of changes) {
        change = scenario;
        metricsReads = 0;
        captures = 0;
        expect(
          await provider.captureScreenshot(input),
          scenario.label,
        ).toMatchObject({
          ok: false,
          error: {
            reason: "target_changed",
            detail: expect.stringContaining("visual viewport changed"),
          },
        });
        expect(captures, scenario.label).toBe(2);
      }
    } finally {
      await provider.close();
    }
  });

  it("reports a malformed screenshot reply at the data field and detaches", async () => {
    const { browser, result } = await captureWithFake({
      commandResult: ({ method }) =>
        method === "Page.captureScreenshot" ? { data: 5 } : undefined,
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        reason: "protocol_error",
        command: "Page.captureScreenshot",
        pointer: "/data",
      },
    });
    await expect.poll(() => browser.activeConnectionCount()).toBe(0);
  });
});

it("uses CSS clip coordinates and scaled device-pixel dimensions for clipped recovery", async () => {
  let captures = 0;
  const recovered = screenshotData(2560, 1440);
  const { browser, result } = await captureWithFake({
    commandResult: ({ method }) =>
      method === "Page.getLayoutMetrics"
        ? {
            cssVisualViewport: {
              pageX: 12,
              pageY: 34,
              clientWidth: 640,
              clientHeight: 360,
              scale: 2,
            },
            visualViewport: {
              pageX: 24,
              pageY: 68,
              clientWidth: 1280,
              clientHeight: 720,
              scale: 2,
            },
          }
        : method === "Page.captureScreenshot"
          ? ++captures === 1
            ? screenshotData(1280, 720)
            : recovered
          : undefined,
  });
  if (!result.ok) throw result.error;
  const screenshots = browser.commands.filter(
    ({ method }) => method === "Page.captureScreenshot",
  );
  expect(screenshots).toHaveLength(2);
  expect(screenshots[0]?.params).toMatchObject({
    captureBeyondViewport: false,
  });
  expect(screenshots[0]?.params).not.toHaveProperty("clip");
  expect(screenshots[1]?.params).toMatchObject({
    fromSurface: true,
    captureBeyondViewport: true,
    clip: { x: 12, y: 34, width: 640, height: 360, scale: 2 },
  });
  expect(result.value.viewport).toEqual({ width: 2560, height: 1440 });
  expect(result.value.artifact.data_base64).toBe(recovered.data);
});

describe("screenshot surface compatibility", () => {
  it("preserves an original high-density surface including pixels outside the visual viewport", async () => {
    const image = screenshotData(1295, 735);
    const cssViewport = {
      pageX: 0,
      pageY: 0,
      clientWidth: 640,
      clientHeight: 360,
      scale: 1,
    };
    const { browser, result } = await captureWithFake({
      commandResult: ({ method }) =>
        method === "Page.getLayoutMetrics"
          ? {
              cssVisualViewport: cssViewport,
              visualViewport: {
                ...cssViewport,
                clientWidth: 1280,
                clientHeight: 720,
              },
            }
          : method === "Page.captureScreenshot"
            ? image
            : undefined,
    });
    if (!result.ok) throw result.error;
    expect(result.value.viewport).toEqual({ width: 1295, height: 735 });
    expect(result.value.artifact.data_base64).toBe(image.data);
    expect(
      browser.commands.filter(
        ({ method }) => method === "Page.captureScreenshot",
      ),
    ).toHaveLength(1);
  });

  it("refuses a clipped recovery that still omits visible content", async () => {
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "Page.getLayoutMetrics"
          ? withCssViewport({
              visualViewport: {
                pageX: 0,
                pageY: 0,
                clientWidth: 2,
                clientHeight: 2,
                scale: 1,
              },
            })
          : undefined,
    });
    onTestFinished(() => browser.close());
    const result = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { reason: "protocol_error" },
    });
    expect(
      browser.commands.filter(
        ({ method }) => method === "Page.captureScreenshot",
      ),
    ).toHaveLength(2);
  });

  it("does not retry a cropped surface after the target leaves scope", async () => {
    const browser = await startFakeCdpBrowser({
      navigateDuringScreenshotUrl: "https://outside.test/",
      commandResult: ({ method }) =>
        method === "Page.getLayoutMetrics"
          ? withCssViewport({
              visualViewport: {
                pageX: 0,
                pageY: 0,
                clientWidth: 2,
                clientHeight: 2,
                scale: 1,
              },
            })
          : undefined,
    });
    onTestFinished(() => browser.close());
    const result = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { reason: "target_not_allowed" },
    });
    expect(
      browser.commands.filter(
        ({ method }) => method === "Page.captureScreenshot",
      ),
    ).toHaveLength(1);
  });
});

it("rejects malformed viewport metrics at the relevant field before capture can proceed", async () => {
  const viewport = {
    pageX: 0,
    pageY: 0,
    clientWidth: 2,
    clientHeight: 2,
    scale: 1,
  };
  const valid = withCssViewport({ visualViewport: viewport });
  const scenarios = [
    { read: 1, reply: {}, pointer: "/visualViewport", captures: 0 },
    {
      read: 1,
      reply: { ...valid, cssVisualViewport: { ...viewport, pageX: null } },
      pointer: "/cssVisualViewport/pageX",
      captures: 0,
    },
    {
      read: 1,
      reply: { ...valid, visualViewport: { ...viewport, clientWidth: 0 } },
      pointer: "/visualViewport/clientWidth",
      captures: 0,
    },
    {
      read: 1,
      reply: { ...valid, cssVisualViewport: { ...viewport, scale: 0 } },
      pointer: "/cssVisualViewport/scale",
      captures: 0,
    },
    {
      read: 2,
      reply: { visualViewport: viewport },
      pointer: "/cssVisualViewport",
      captures: 1,
    },
    {
      read: 3,
      reply: { ...valid, visualViewport: { ...viewport, scale: null } },
      pointer: "/visualViewport/scale",
      captures: 2,
    },
  ] as const;
  let scenario: (typeof scenarios)[number] = scenarios[0];
  let reads = 0;
  const browser = await startFakeCdpBrowser({
    commandResult: ({ method, params }) => {
      if (method === "Page.getLayoutMetrics")
        return ++reads === scenario.read ? scenario.reply : valid;
      if (method === "Page.captureScreenshot") {
        const size = params.clip === undefined ? 1 : 2;
        return screenshotData(size, size);
      }
      return undefined;
    },
  });
  onTestFinished(() => browser.close());
  const provider = new CdpBrowserProvider();
  const input = captureWebScreenshotInputSchema.parse({
    cdp_endpoint: browser.endpoint,
    allowed_origins: [browser.allowedOrigin],
    target_id: "allowed-page",
  });
  const screenshotCount = () =>
    browser.commands.filter(({ method }) => method === "Page.captureScreenshot")
      .length;
  try {
    for (const invalid of scenarios) {
      scenario = invalid;
      reads = 0;
      const before = screenshotCount();
      const label = `metrics reply ${invalid.read} at ${invalid.pointer}`;
      expect(await provider.captureScreenshot(input), label).toMatchObject({
        ok: false,
        error: {
          reason: "protocol_error",
          command: "Page.getLayoutMetrics",
          pointer: invalid.pointer,
        },
      });
      expect(screenshotCount() - before, label).toBe(invalid.captures);
      await expect.poll(() => browser.activeConnectionCount()).toBe(0);
    }
  } finally {
    await provider.close();
  }
});

it("rejects an unidentifiable navigation and releases the screenshot connection", async () => {
  const { browser, result } = await captureWithFake({
    commandEvents: (command) =>
      command.method === "Page.captureScreenshot"
        ? [
            {
              method: "Page.frameNavigated",
              ...(command.sessionId === undefined
                ? {}
                : { sessionId: command.sessionId }),
              params: undefined,
            },
          ]
        : undefined,
  });
  expect(result).toMatchObject({
    ok: false,
    error: { reason: "protocol_error" },
  });
  await expect.poll(() => browser.activeConnectionCount()).toBe(0);
});

describe("screenshot frame identity transitions", () => {
  it("rejects a self-parented root candidate and detaches without retrying the cropped screenshot", async () => {
    const { browser, result } = await captureWithFake({
      commandResult: ({ method }) =>
        method === "Page.getLayoutMetrics"
          ? withCssViewport({
              visualViewport: {
                pageX: 0,
                pageY: 0,
                clientWidth: 2,
                clientHeight: 2,
                scale: 1,
              },
            })
          : undefined,
      commandEvents: (command, origin) =>
        command.method === "Page.captureScreenshot"
          ? [
              frameNavigated(command, {
                id: "candidate-root",
                parentId: "candidate-root",
                url: `${origin}/app`,
              }),
            ]
          : undefined,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { reason: "protocol_error" },
    });
    expect(
      browser.commands.filter(
        ({ method }) => method === "Page.captureScreenshot",
      ),
    ).toHaveLength(1);
    await expect.poll(() => browser.activeConnectionCount()).toBe(0);
  });
});

it("preserves the screenshot when navigation events leave the selected document unchanged", async () => {
  const image = screenshotData(1, 1);
  const { result } = await captureWithFake({
    extraCollections: true,
    eventsBeforeReply: ["Page.captureScreenshot"],
    commandResult: ({ method }) =>
      method === "Page.captureScreenshot" ? image : undefined,
    commandEvents: (command, origin) => {
      if (command.method !== "Page.captureScreenshot") return undefined;
      const sessionId = command.sessionId;
      const selectedUrl = `${origin}/app?token=frame-secret`;
      const outside = "https://outside.invalid/";
      return [
        ...["frame-main", "frame-child"].map((frameId) => ({
          method: "Page.frameRequestedNavigation",
          sessionId,
          params: {
            frameId,
            url: outside,
            reason: "scriptInitiated",
            disposition: "currentTab",
          },
        })),
        {
          method: "Page.navigatedWithinDocument",
          sessionId,
          params: {
            frameId: "frame-main",
            url: selectedUrl,
            navigationType: "historyApi",
          },
        },
        {
          method: "Page.navigatedWithinDocument",
          sessionId,
          params: {
            frameId: "frame-child",
            url: `${outside}child`,
            navigationType: "historyApi",
          },
        },
        frameNavigated(command, {
          id: "frame-main",
          loaderId: "loader-main",
          url: selectedUrl,
        }),
        {
          method: "Runtime.consoleAPICalled",
          sessionId,
          params: {
            type: "log",
            args: [],
            executionContextId: 1,
            timestamp: 1,
          },
        },
        {
          method: "Page.lifecycleEvent",
          sessionId,
          params: {
            frameId: "frame-main",
            loaderId: "loader-main",
            name: "DOMContentLoaded",
            timestamp: 1,
          },
        },
        {
          method: "Runtime.consoleAPICalled",
          sessionId,
          params: { frameId: "frame-main", args: "not-an-array" },
        },
        frameNavigated(command, {
          id: 7,
          parentId: "frame-main",
          url: `${outside}malformed-child`,
        }),
      ];
    },
  });
  if (!result.ok) throw result.error;
  expect(result.value.artifact.data_base64).toBe(image.data);
  expect(result.value.completeness.excluded).toEqual([
    { section: "screenshot", reason: "invalid_protocol_value", count: 1 },
  ]);
  expect(result.value.completeness.attach_limited_sections).toEqual([]);
});

it("rejects a changed root frame or loader even when the screenshot URL is unchanged", async () => {
  const replacements = [
    { id: "replacement-main", loaderId: "loader-main" },
    { id: "frame-main", loaderId: "loader-reloaded" },
  ] as const;
  let replacement: (typeof replacements)[number] = replacements[0];
  const browser = await startFakeCdpBrowser({
    eventsBeforeReply: ["Page.captureScreenshot"],
    commandEvents: (command, origin) =>
      command.method === "Page.captureScreenshot"
        ? [
            frameNavigated(command, {
              ...replacement,
              url: `${origin}/app?token=frame-secret`,
            }),
          ]
        : undefined,
  });
  onTestFinished(() => browser.close());
  const provider = new CdpBrowserProvider();
  const input = captureWebScreenshotInputSchema.parse({
    cdp_endpoint: browser.endpoint,
    allowed_origins: [browser.allowedOrigin],
    target_id: "allowed-page",
  });
  try {
    for (const changed of replacements) {
      replacement = changed;
      const before = browser.commands.length;
      expect(
        await provider.captureScreenshot(input),
        JSON.stringify(changed),
      ).toMatchObject({
        ok: false,
        error: { reason: "target_changed" },
      });
      expect(
        browser.commands
          .slice(before)
          .filter(({ method }) => method === "Page.getFrameTree"),
      ).toHaveLength(1);
      await expect.poll(() => browser.activeConnectionCount()).toBe(0);
    }
  } finally {
    await provider.close();
  }
});

it("separates unreadable screenshot document URLs from known scope loss at each capture phase", async () => {
  const phases = [
    { phase: "initial", captures: 0 },
    { phase: "event", captures: 1 },
    { phase: "final", captures: 1 },
  ] as const;
  const invalidDocuments = [
    { source: "allowed", fragment: 7, reason: "protocol_error" },
    { source: "foreign", fragment: 7, reason: "target_not_allowed" },
    { source: "missing", reason: "protocol_error" },
  ] as const;
  const scenarios = [
    ...phases.flatMap((phase) =>
      invalidDocuments.map((document) => ({
        ...phase,
        ...document,
        loader: "loader-main",
      })),
    ),
    {
      phase: "event",
      captures: 1,
      source: "foreign",
      fragment: 7,
      reason: "target_changed",
      loader: "new-loader",
    },
  ] as const;
  let scenario: (typeof scenarios)[number] | undefined;
  let treeReads = 0;
  const frame = (origin: string) => {
    if (scenario === undefined) throw new Error("Missing screenshot scenario");
    return {
      id: "frame-main",
      loaderId: scenario.loader,
      ...(scenario.source === "missing"
        ? {}
        : {
            url:
              scenario.source === "foreign"
                ? "https://foreign.test/"
                : `${origin}/app?token=frame-secret`,
            urlFragment: scenario.fragment,
          }),
    };
  };
  const browser = await startFakeCdpBrowser({
    eventsBeforeReply: ["Page.captureScreenshot"],
    commandResult: ({ method }, origin) => {
      if (method !== "Page.getFrameTree") return undefined;
      treeReads += 1;
      return (scenario?.phase === "initial" && treeReads === 1) ||
        (scenario?.phase === "final" && treeReads === 2)
        ? { frameTree: { frame: frame(origin) } }
        : undefined;
    },
    commandEvents: (command, origin) =>
      scenario?.phase === "event" && command.method === "Page.captureScreenshot"
        ? [frameNavigated(command, frame(origin))]
        : undefined,
  });
  onTestFinished(() => browser.close());
  const provider = new CdpBrowserProvider();
  const input = captureWebScreenshotInputSchema.parse({
    cdp_endpoint: browser.endpoint,
    allowed_origins: [browser.allowedOrigin],
    target_id: "allowed-page",
  });
  try {
    for (const invalid of scenarios) {
      scenario = invalid;
      treeReads = 0;
      const before = browser.commands.length;
      const label = `${invalid.phase}/${invalid.source}/${invalid.loader}`;
      expect(await provider.captureScreenshot(input), label).toMatchObject({
        ok: false,
        error: { reason: invalid.reason },
      });
      expect(
        browser.commands
          .slice(before)
          .filter(({ method }) => method === "Page.captureScreenshot"),
        label,
      ).toHaveLength(invalid.captures);
      await expect.poll(() => browser.activeConnectionCount()).toBe(0);
    }
  } finally {
    await provider.close();
  }
});

it("rejects noncanonical base64 and unreadable PNG without attempting a clipped capture", async () => {
  let data = "";
  const browser = await startFakeCdpBrowser({
    commandResult: ({ method }) =>
      method === "Page.captureScreenshot" ? { data } : undefined,
  });
  onTestFinished(() => browser.close());
  const provider = new CdpBrowserProvider();
  const input = captureWebScreenshotInputSchema.parse({
    cdp_endpoint: browser.endpoint,
    allowed_origins: [browser.allowedOrigin],
    target_id: "allowed-page",
  });
  const png = screenshotData(1, 1).data;
  const invalidHeader = Buffer.from(png, "base64");
  invalidHeader[0] = 0;
  const screenshotCount = () =>
    browser.commands.filter(({ method }) => method === "Page.captureScreenshot")
      .length;
  try {
    // Keep the length divisible by four so the first reply reaches the canonical byte check.
    for (const invalid of [`    ${png}`, invalidHeader.toString("base64")]) {
      data = invalid;
      const before = screenshotCount();
      expect(await provider.captureScreenshot(input)).toMatchObject({
        ok: false,
        error: { reason: "protocol_error" },
      });
      expect(screenshotCount() - before).toBe(1);
      await expect.poll(() => browser.activeConnectionCount()).toBe(0);
    }
  } finally {
    await provider.close();
  }
});
