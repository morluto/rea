import { DEFAULT_ASAR_HEADER_ADMISSION } from "../config/asarHeaderAdmission.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

import { fakeCdpEvents } from "../../tests/fixtures/fakeCdpEvents.js";

import {
  fakeCdpSend,
  frameTreeReply,
} from "../../tests/fixtures/fakeCdpSend.js";
import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import type { CdpContextFrameClaim } from "./CdpScriptContextFacts.js";
import {
  captureFrames,
  inspectCdpElectronPage,
} from "./CdpElectronInspection.js";
import {
  receiveCdpEvent,
  type CdpEvent,
  type CdpConnection,
} from "./CdpConnection.js";
import {
  ingestElectronScriptEvent,
  type ElectronScriptDraft,
} from "./CdpElectronScriptEvents.js";
import { CDP_SCRIPT_SOURCE_BYTES_OMISSION_REASON } from "./CdpScriptSourceBudget.js";
import { captureElectronScripts } from "./CdpElectronScripts.js";
import { ElectronFileScope } from "./ElectronFileScope.js";
import { inspectElectronPageInputSchema } from "../domain/javascript/electronObservation.js";
import type { ProgressReporter } from "../ports/ProgressReporter.js";

const inspectRaceConnection = (
  connection: CdpConnection,
  mainUrl: string,
  progress?: ProgressReporter,
) =>
  inspectCdpElectronPage({
    connection,
    ...(progress === undefined ? {} : { progress }),
    sessionId: undefined,
    asarHeaderAdmission: DEFAULT_ASAR_HEADER_ADMISSION,
    files: new ElectronFileScope(),
    discovery: {
      webSocket: { scope: "browser", url: "ws://127.0.0.1:9222" },
      version: {
        product: "fixture",
        protocol_version: "1",
        revision: "",
        user_agent: "fixture",
        js_version: "",
      },
      targets: [],
    },
    target: {
      id: "page",
      type: "page",
      title: "fixture",
      url: mainUrl,
      attached: false,
    },
    input: inspectElectronPageInputSchema.parse({
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "page",
      observation_ms: 0,
    }),
  });

it.each([
  "initial",
  "refreshed",
  "final",
  "ancestor",
  "opaque-ancestor",
  "stable",
])(
  "binds frame authorization to the tree read across file checks: %s",
  async (stage) => {
    const isAncestor = stage.endsWith("ancestor");
    const root = await createTestTempDirectory("rea-frame-generation-race-");
    const main = join(root, "main.html"),
      child = join(root, "child.html"),
      script = join(root, "app.js");
    await Promise.all([
      writeFile(main, "main"),
      writeFile(child, "child"),
      writeFile(script, "void 0;"),
    ]);
    const mainUrl = pathToFileURL(main).href,
      childUrl = pathToFileURL(child).href;
    const events = fakeCdpEvents();
    const listener = events.emit;
    let reads = 0,
      fired = false;
    const emitScript = () => {
      listener({
        method: "Runtime.executionContextCreated",
        params: { context: { id: 7, auxData: { frameId: "child" } } },
      });
      listener({
        method: "Debugger.scriptParsed",
        params: {
          scriptId: "new-document-script",
          url: pathToFileURL(script).href,
          executionContextId: 7,
          hash: "new-document",
        },
      });
    };
    const inject = () => {
      listener({
        method: "Page.frameNavigated",
        params: {
          frame: {
            id: isAncestor ? "parent" : "child",
            parentId: "main",
            url: "https://foreign.test/new-document",
          },
        },
      });
      if (stage !== "initial") emitScript();
    };
    const connection = {
      onEvent: events.onEvent,
      send: fakeCdpSend(async (method) => {
        if (method === "Page.getFrameTree") {
          reads++;
          const shouldInject =
            (stage === "initial" && reads === 1) ||
            (stage === "refreshed" && reads === 2) ||
            (isAncestor && reads === 2) ||
            (stage === "final" && reads === 3);
          return {
            frameTree: {
              frame: { id: "main", url: mainUrl },
              childFrames:
                (stage === "initial" && reads > 1) ||
                (stage === "refreshed" && reads !== 2) ||
                (isAncestor && reads !== 2) ||
                (stage === "final" && reads === 1)
                  ? []
                  : [
                      {
                        frame: {
                          id: isAncestor ? "parent" : "child",
                          parentId: "main",
                          get url() {
                            if (shouldInject && !isAncestor && !fired) {
                              fired = true;
                              queueMicrotask(inject);
                            }
                            return stage === "opaque-ancestor"
                              ? "about:blank"
                              : childUrl;
                          },
                        },
                        ...(isAncestor
                          ? {
                              childFrames: [
                                {
                                  frame: {
                                    id: "child",
                                    parentId: "parent",
                                    get url() {
                                      if (shouldInject && !fired) {
                                        fired = true;
                                        queueMicrotask(inject);
                                      }
                                      return childUrl;
                                    },
                                  },
                                },
                              ],
                            }
                          : {}),
                      },
                    ],
            },
          };
        }
        if (method === "Debugger.enable" && stage === "initial") emitScript();
        if (method === "Debugger.enable" && stage === "stable") {
          listener({
            method: "Runtime.executionContextCreated",
            params: { context: { id: 7, auxData: { frameId: "child" } } },
          });
          listener({
            method: "Debugger.scriptParsed",
            params: {
              scriptId: "stable-script",
              url: pathToFileURL(script).href,
              executionContextId: 7,
              hash: "stable",
            },
          });
        }
        if (method === "Page.getResourceTree")
          return {
            frameTree: { frame: { id: "main", url: mainUrl }, resources: [] },
          };
        if (method === "DOMSnapshot.captureSnapshot")
          return { strings: [], documents: [] };
        if (method === "Target.getTargets") return { targetInfos: [] };
        return {};
      }),
    } as unknown as CdpConnection;
    const result = await inspectRaceConnection(connection, mainUrl);
    if (stage === "stable")
      expect(result.scripts.items).toContainEqual(
        expect.objectContaining({ frame_id: "child", cdp_hash: "stable" }),
      );
    else {
      expect(fired).toBe(true);
      if (stage !== "final")
        expect(result.scripts.items).toContainEqual(
          expect.objectContaining({
            frame_id: "child",
            frame_scope: "unknown",
            cdp_hash: "new-document",
          }),
        );
      expect(result.completeness.attach_limited_sections).toContain("frames");
    }
  },
);

/** Raw lifecycle messages exercised by the final file-validation race. */
const documentIdentityEvent = (
  kind: string,
  mainUrl: string,
  childUrl: string,
): { readonly event: CdpEvent; readonly isMain: boolean } => {
  const isMain =
    kind.startsWith("late-main") ||
    kind === "duplicate-main" ||
    kind === "duplicate-initial";
  if (kind === "attached-child-with-id-alias")
    return {
      isMain,
      event: {
        method: "Page.frameAttached",
        params: { frameId: "child", parentFrameId: "main", id: "main" },
      },
    };
  const id = isMain ? "main" : "child";
  const malformedAlias = kind === "malformed-child-id-alias";
  return {
    isMain,
    event: {
      method: "Page.frameNavigated",
      params: {
        frame: {
          id: malformedAlias ? null : id,
          ...(malformedAlias ? { frameId: "child" } : {}),
          ...(isMain ? {} : { parentId: "main" }),
          url: isMain ? mainUrl : childUrl,
          ...(kind === "unknown-child"
            ? {}
            : {
                loaderId:
                  kind.startsWith("late-main") ||
                  kind === "replacement-child" ||
                  malformedAlias
                    ? "replacement-loader"
                    : `loader-${id}`,
              }),
        },
      },
    },
  };
};

it.each([
  "late-main",
  "late-main-progress",
  "duplicate-initial",
  "duplicate-main",
  "duplicate-child",
  "replacement-child",
  "unknown-child",
  "malformed-child-id-alias",
  "attached-child-with-id-alias",
])(
  "preserves document identity through final file validation: %s",
  async (kind) => {
    const root = await createTestTempDirectory(
      "rea-electron-document-identity-",
    );
    const main = join(root, "main.html"),
      child = join(root, "child.html"),
      script = join(root, "app.js");
    await Promise.all([
      writeFile(main, "main"),
      writeFile(child, "child"),
      writeFile(script, "void 0;"),
    ]);
    const mainUrl = pathToFileURL(main).href,
      childUrl = pathToFileURL(child).href;
    const events = fakeCdpEvents();
    const listener = events.emit;
    let reads = 0,
      fired = false;
    const inject = () => {
      const { event, isMain } = documentIdentityEvent(kind, mainUrl, childUrl);
      listener(event);
      if (!isMain) {
        listener({
          method: "Runtime.executionContextCreated",
          params: { context: { id: 7, auxData: { frameId: "child" } } },
        });
        listener({
          method: "Debugger.scriptParsed",
          params: {
            scriptId: "observed",
            url: pathToFileURL(script).href,
            executionContextId: 7,
            hash: "observed",
          },
        });
      }
    };
    const connection = {
      onEvent: events.onEvent,
      send: fakeCdpSend(async (method) => {
        if (method === "Page.getFrameTree") {
          reads++;
          const trigger =
            kind === "late-main-progress"
              ? false
              : kind === "duplicate-initial"
                ? reads === 1
                : kind === "late-main"
                  ? reads === 3
                  : reads === 2;
          if (trigger && !fired) {
            fired = true;
            // The reply is parsed and its documents seeded in microtasks;
            // inject during the later asynchronous file checks.
            setImmediate(inject);
          }
          return {
            frameTree: {
              frame: { id: "main", url: mainUrl, loaderId: "loader-main" },
              childFrames: [
                {
                  frame: {
                    id: "child",
                    parentId: "main",
                    loaderId: "loader-child",
                    url: childUrl,
                  },
                },
              ],
            },
          };
        }
        if (method === "Page.getResourceTree")
          return {
            frameTree: { frame: { id: "main", url: mainUrl }, resources: [] },
          };
        if (method === "DOMSnapshot.captureSnapshot")
          return { strings: [], documents: [] };
        if (method === "Target.getTargets") return { targetInfos: [] };
        return {};
      }),
    } as unknown as CdpConnection;
    const result = inspectRaceConnection(connection, mainUrl, {
      report: async (update) => {
        if (kind === "late-main-progress" && update.completed === 3) {
          fired = true;
          inject();
        }
      },
    });
    if (kind.startsWith("late-main"))
      await expect(result).rejects.toMatchObject({ reason: "target_changed" });
    else {
      const captured = await result;
      expect(fired).toBe(true);
      if (kind.startsWith("duplicate") || kind === "malformed-child-id-alias")
        expect(captured.completeness.attach_limited_sections).not.toContain(
          "frames",
        );
      if (kind !== "duplicate-main" && kind !== "duplicate-initial")
        expect(captured.scripts.items).toContainEqual(
          expect.objectContaining({
            cdp_hash: "observed",
            frame_id: "child",
            frame_scope:
              kind === "duplicate-child" || kind === "malformed-child-id-alias"
                ? "authorized"
                : "unknown",
          }),
        );
    }
  },
);

it.each([7, null, "", "claimed-parent"])(
  "does not promote children when the enclosing root has a parent: %s",
  async (parentId) => {
    const root = await createTestTempDirectory("rea-electron-root-role-");
    const main = join(root, "index.html");
    await writeFile(main, "main");
    const completeness = new CdpCaptureCompleteness();
    const { frames } = await captureFrames(
      frameTreeReply({
        frameTree: {
          frame: { id: "main", url: pathToFileURL(main).href, parentId },
          childFrames: [
            {
              frame: {
                id: "child",
                parentId: "main",
                url: pathToFileURL(main).href,
              },
            },
          ],
        },
      }),
      completeness,
      DEFAULT_ASAR_HEADER_ADMISSION,
    );
    expect(frames).toEqual([]);
    expect(completeness.snapshot().excluded).toContainEqual({
      section: "frames",
      reason: "invalid_protocol_value",
      count: 2,
    });
    expect(completeness.snapshot().policy_filtered_sections).toEqual([]);
  },
);

it("preserves script records across context teardown and ID reuse", async () => {
  const root = await createTestTempDirectory("rea-electron-script-frame-");
  const scriptPath = join(root, "app.js");
  await writeFile(scriptPath, "export const app = true;");
  const scripts: ElectronScriptDraft[] = [];
  const executionContextFrames = new Map<string, CdpContextFrameClaim>();
  const retention = { bytes: 2 };
  const completeness = new CdpCaptureCompleteness();
  const ingest = (method: string, params: unknown): void =>
    ingestElectronScriptEvent({
      event: receiveCdpEvent({ method, params }),
      scripts,
      executionContextFrames,
      retention,
      completeness,
    });
  const context = (frameId: string) => ({
    context: { id: 7, auxData: { frameId } },
  });
  const parsed = (
    scriptId: string,
    hash: string,
    url = pathToFileURL(scriptPath).href,
  ) => ({
    scriptId,
    url,
    hash,
    executionContextId: 7,
  });

  ingest("Runtime.executionContextCreated", context("frame-old"));
  ingest("Debugger.scriptParsed", parsed("script-old", "shared"));
  ingest("Runtime.executionContextDestroyed", { executionContextId: 7 });
  ingest("Runtime.executionContextCreated", context("frame-new"));
  ingest("Debugger.scriptParsed", parsed("script-new", "shared"));
  ingest("Runtime.executionContextsCleared", {});
  ingest("Debugger.scriptParsed", parsed("script-unknown", "unknown"));
  ingest("Runtime.executionContextCreated", context("frame-outside"));
  ingest("Debugger.scriptParsed", parsed("script-outside", "outside"));
  ingest(
    "Debugger.scriptParsed",
    parsed(
      "script-out-of-scope",
      "out-of-scope",
      "https://example.test/app.js",
    ),
  );

  const capture = await captureElectronScripts({
    connection: {
      send: async () => {
        throw new Error("Source capture must remain disabled in this test");
      },
    } as unknown as CdpConnection,
    sessionId: undefined,
    request: inspectElectronPageInputSchema.parse({
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "page-1",
      observation_ms: 0,
      include_script_sources: false,
    }),
    scripts,
    frameScopeForScript: (script) =>
      script.frameId !== null &&
      new Set(["frame-old", "frame-new"]).has(script.frameId)
        ? { state: "authorized", frameId: script.frameId }
        : { state: "unknown", frameId: script.frameId },
    completeness,
    asarHeaderAdmission: DEFAULT_ASAR_HEADER_ADMISSION,
  });

  expect(capture.total).toBe(4);
  const sharedScripts = capture.items.filter(
    (item) => item.cdp_hash === "shared",
  );
  expect(new Set(sharedScripts.map((item) => item.frame_id))).toEqual(
    new Set(["frame-old", "frame-new"]),
  );
  expect(new Set(sharedScripts.map((item) => item.script_key)).size).toBe(2);
  expect(
    Object.fromEntries(
      capture.items
        .filter((item) => item.cdp_hash !== "shared")
        .map((item) => [item.cdp_hash, item.frame_id]),
    ),
  ).toEqual({
    unknown: null,
    outside: "frame-outside",
  });
  expect(completeness.snapshot().excluded).toContainEqual({
    section: "scripts",
    reason: "out_of_target_scope",
    count: 1,
  });
});

it("admits a prefix and fitting suffix around an oversized Electron source", async () => {
  const root = await createTestTempDirectory("rea-electron-source-budget-");
  const paths = await Promise.all(
    ["prefix.js", "oversized.js", "suffix.js"].map(async (name) => {
      const path = join(root, name);
      await writeFile(path, "metadata");
      return path;
    }),
  );
  const sourceById = {
    prefix: "p".repeat(16 * 1024 * 1024),
    oversized: "o".repeat(17 * 1024 * 1024),
    suffix: "s".repeat(1024 * 1024),
  };
  const scripts: ElectronScriptDraft[] = paths.map((path, index) => {
    const scriptId = ["prefix", "oversized", "suffix"][index];
    if (scriptId === undefined) throw new Error("Missing script identity");
    return {
      scriptId,
      rawUrl: pathToFileURL(path).href,
      hash: scriptId,
      length: null,
      isModule: false,
      language: "JavaScript",
      frameId: null,
      hasSourceUrl: null,
      frameClaims: {},
    };
  });
  const completeness = new CdpCaptureCompleteness();
  const capture = await captureElectronScripts({
    connection: {
      send: async (
        _method: string,
        params: Readonly<Record<string, unknown>>,
      ) => ({
        scriptSource:
          sourceById[
            (params as { scriptId: keyof typeof sourceById }).scriptId
          ],
      }),
    } as unknown as CdpConnection,
    sessionId: undefined,
    request: inspectElectronPageInputSchema.parse({
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "page-1",
      observation_ms: 0,
      include_script_sources: true,
    }),
    scripts,
    frameScopeForScript: () => ({ state: "unknown", frameId: null }),
    completeness,
    asarHeaderAdmission: DEFAULT_ASAR_HEADER_ADMISSION,
  });
  const byHash = new Map(
    capture.items.map((item) => [item.cdp_hash, item.source]),
  );

  expect(capture.total).toBe(3);
  expect([...byHash.keys()].sort()).toEqual(["oversized", "prefix", "suffix"]);
  expect(byHash.get("prefix")?.included).toBe(true);
  expect(byHash.get("oversized")).toEqual({
    included: false,
    reason: CDP_SCRIPT_SOURCE_BYTES_OMISSION_REASON,
  });
  expect(byHash.get("suffix")?.included).toBe(true);
  expect(completeness.snapshot().excluded).toContainEqual({
    section: "script_sources",
    reason: "resource_budget_exhausted",
    count: 1,
  });
});

it.each([
  ...[
    ...[2, 3].flatMap((stage) =>
      [false, true].map((lateEvent) => ({
        scope: "main",
        stage,
        lateEvent,
        changed: true,
      })),
    ),
    ...[false, true].map((lateEvent) => ({
      scope: "child",
      stage: 2,
      lateEvent,
      changed: true,
    })),
    ...["main", "child"].map((scope) => ({
      scope,
      stage: 2,
      lateEvent: true,
      changed: false,
    })),
  ].map((item) => ({ ...item, urlChange: "", fullReplay: false })),
  ...["#next", "?route=next"].flatMap((urlChange) =>
    [false, true].map((lateEvent) => ({
      scope: "child",
      stage: 2,
      lateEvent,
      changed: false,
      urlChange,
      fullReplay: false,
    })),
  ),
  {
    scope: "child",
    stage: 2,
    lateEvent: true,
    changed: false,
    urlChange: "#next",
    fullReplay: true,
  },
  ...[2, 3].map((stage) => ({
    scope: "main",
    stage,
    lateEvent: false,
    changed: false,
    urlChange: "#next",
    fullReplay: false,
  })),
])(
  "detects tree-first document replacement $scope/read$stage/late=$lateEvent/changed=$changed/url=$urlChange/full=$fullReplay",
  async ({ scope, stage, lateEvent, changed, urlChange, fullReplay }) => {
    const root = await createTestTempDirectory("rea-tree-first-document-");
    const main = join(root, "main.html"),
      child = join(root, "child.html"),
      script = join(root, "app.js");
    await Promise.all([
      writeFile(main, "main"),
      writeFile(child, "child"),
      writeFile(script, "void 0;"),
    ]);
    const mainUrl = pathToFileURL(main).href,
      childUrl = pathToFileURL(child).href;
    const events = fakeCdpEvents();
    const listener = events.emit;
    let reads = 0;
    let replayed = false;
    const emitScript = (hash: string, frameId: string, contextId: number) => {
      listener({
        method: "Runtime.executionContextCreated",
        params: { context: { id: contextId, auxData: { frameId } } },
      });
      listener({
        method: "Debugger.scriptParsed",
        params: {
          scriptId: hash,
          url: pathToFileURL(script).href,
          executionContextId: contextId,
          hash,
        },
      });
    };
    const document = (id: string) => ({
      id,
      ...(id === "main" ? {} : { parentId: id === "child" ? "main" : "child" }),
      url:
        (id === "main" ? mainUrl : childUrl) +
        (reads >= stage && id === scope ? urlChange : ""),
      loaderId:
        changed && reads >= stage && id === scope
          ? "replacement"
          : `loader-${id}`,
    });
    const replay = () => {
      if (replayed || reads < stage) return;
      replayed = true;
      if (lateEvent)
        listener(
          urlChange && !fullReplay
            ? {
                method: "Page.navigatedWithinDocument",
                params: { frameId: scope, url: document(scope).url },
              }
            : {
                method: "Page.frameNavigated",
                params: { frame: document(scope) },
              },
        );
      emitScript("after-child", "child", 10);
      emitScript("after-grandchild", "grandchild", 11);
    };
    const connection = {
      onEvent: events.onEvent,
      send: fakeCdpSend(async (method) => {
        if (method === "Page.getFrameTree") {
          reads++;
          return {
            frameTree: {
              frame: document("main"),
              childFrames: [
                {
                  frame: document("child"),
                  childFrames: [{ frame: document("grandchild") }],
                },
              ],
            },
          };
        }
        if (method === "Debugger.enable") {
          emitScript("before-child", "child", 7);
          emitScript("before-grandchild", "grandchild", 8);
        }
        if (method === "Page.getResourceTree") {
          replay();
          return {
            frameTree: { frame: { id: "main", url: mainUrl }, resources: [] },
          };
        }
        if (method === "DOMSnapshot.captureSnapshot")
          return { strings: [], documents: [] };
        if (method === "Target.getTargets") return { targetInfos: [] };
        return {};
      }),
    } as unknown as CdpConnection;
    const result = inspectRaceConnection(connection, mainUrl, {
      report: async (update) => {
        if (update.completed === 3) replay();
      },
    });
    if (scope === "main" && (changed || urlChange))
      await expect(result).rejects.toMatchObject({ reason: "target_changed" });
    else {
      const captured = await result;
      for (const id of ["child", "grandchild"]) {
        expect(captured.scripts.items).toContainEqual(
          expect.objectContaining({ cdp_hash: `before-${id}`, frame_id: id }),
        );
        expect(captured.scripts.items).toContainEqual(
          expect.objectContaining({
            cdp_hash: `after-${id}`,
            frame_id: id,
            frame_scope: changed ? "unknown" : "authorized",
          }),
        );
      }
      expect(
        captured.completeness.attach_limited_sections.includes("frames"),
      ).toBe(changed);
    }
  },
);

it.each([2, 3])(
  "refuses a tree-first main frame identity replacement at read %s",
  async (stage) => {
    const root = await createTestTempDirectory("rea-electron-root-identity-");
    const main = join(root, "main.html");
    await writeFile(main, "main");
    const mainUrl = pathToFileURL(main).href;
    let reads = 0;
    const connection = {
      onEvent: () => () => {},
      send: fakeCdpSend(async (method) => {
        if (method === "Page.getFrameTree") {
          reads += 1;
          return {
            frameTree: {
              frame: {
                id: reads >= stage ? "replacement-main" : "initial-main",
                url: mainUrl,
                loaderId: "same-url-document",
              },
            },
          };
        }
        if (method === "Page.getResourceTree")
          return { frameTree: { resources: [] } };
        if (method === "DOMSnapshot.captureSnapshot")
          return { strings: [], documents: [] };
        if (method === "Target.getTargets") return { targetInfos: [] };
        return {};
      }),
    } as unknown as CdpConnection;
    await expect(
      inspectRaceConnection(connection, mainUrl),
    ).rejects.toMatchObject({
      _tag: "BrowserObservationError",
      operation: "inspect_electron_page",
      reason: "target_changed",
    });
  },
);

it.each([
  { stage: 1, loader: "" },
  { stage: 2, loader: undefined },
  { stage: 3, loader: undefined },
  { stage: 0, loader: undefined },
])(
  "retains uncertainty when the main loader is missing at read $stage",
  async ({ stage, loader }) => {
    const root = await createTestTempDirectory("rea-electron-missing-loader-");
    const main = join(root, "main.html");
    const child = join(root, "child.html");
    await Promise.all([writeFile(main, "main"), writeFile(child, "child")]);
    const mainUrl = pathToFileURL(main).href;
    const childUrl = pathToFileURL(child).href;
    let reads = 0;
    const events = fakeCdpEvents();
    const listener = events.emit;
    const emitScript = (hash: string, id: number, frameId: string) => {
      listener({
        method: "Runtime.executionContextCreated",
        params: { context: { id, auxData: { frameId } } },
      });
      listener({
        method: "Debugger.scriptParsed",
        params: { scriptId: hash, url: mainUrl, executionContextId: id, hash },
      });
    };
    const connection = {
      onEvent: events.onEvent,
      send: fakeCdpSend(async (method) => {
        if (method === "Page.getFrameTree") {
          reads++;
          return {
            frameTree: {
              childFrames: [
                {
                  frame: {
                    id: "child",
                    parentId: "main",
                    url: childUrl,
                    loaderId: "loader-child",
                  },
                },
              ],
              frame: {
                id: "main",
                url: mainUrl,
                ...(reads === stage
                  ? loader === undefined
                    ? {}
                    : { loaderId: loader }
                  : { loaderId: "loader-main" }),
              },
            },
          };
        }
        if (method === "Debugger.enable") {
          emitScript("before", 7, "main");
          emitScript("child-before", 9, "child");
        }
        if (method === "Page.getResourceTree") {
          emitScript("after", 8, "main");
          emitScript("child-after", 10, "child");
          return { frameTree: { resources: [] } };
        }
        if (method === "DOMSnapshot.captureSnapshot")
          return { strings: [], documents: [] };
        if (method === "Target.getTargets") return { targetInfos: [] };
        return {};
      }),
    } as unknown as CdpConnection;
    const result = await inspectRaceConnection(connection, mainUrl);
    for (const section of ["frames", "scripts", "workers"] as const)
      expect(
        result.completeness.attach_limited_sections.includes(section),
      ).toBe(stage !== 0);
    expect(result.scripts.items).toContainEqual(
      expect.objectContaining({
        cdp_hash: "before",
        frame_scope: stage === 1 ? "unknown" : "authorized",
      }),
    );
    expect(result.scripts.items).toContainEqual(
      expect.objectContaining({
        cdp_hash: "after",
        frame_scope: stage === 1 || stage === 2 ? "unknown" : "authorized",
      }),
    );
    expect(result.scripts.items).toContainEqual(
      expect.objectContaining({
        cdp_hash: "child-before",
        frame_scope: stage === 1 ? "unknown" : "authorized",
      }),
    );
    expect(result.scripts.items).toContainEqual(
      expect.objectContaining({
        cdp_hash: "child-after",
        frame_scope: stage === 1 || stage === 2 ? "unknown" : "authorized",
      }),
    );
  },
);

it.each([
  { loaders: ["loader-a", undefined, "loader-b"], changed: true },
  { loaders: ["loader-a", undefined, "loader-a"], changed: false },
  { loaders: [undefined, undefined, "loader-b"], changed: false },
])(
  "compares later root identity with the last proven loader: $loaders",
  async ({ loaders, changed }) => {
    const root = await createTestTempDirectory("rea-electron-loader-history-");
    const main = join(root, "main.html");
    await writeFile(main, "main");
    const mainUrl = pathToFileURL(main).href;
    let reads = 0;
    const connection = {
      onEvent: () => () => {},
      send: fakeCdpSend(async (method) => {
        if (method === "Page.getFrameTree") {
          const loaderId = loaders[reads++];
          return {
            frameTree: {
              frame: {
                id: "main",
                url: mainUrl,
                ...(loaderId === undefined ? {} : { loaderId }),
              },
            },
          };
        }
        if (method === "Page.getResourceTree")
          return { frameTree: { resources: [] } };
        if (method === "DOMSnapshot.captureSnapshot")
          return { strings: [], documents: [] };
        if (method === "Target.getTargets") return { targetInfos: [] };
        return {};
      }),
    } as unknown as CdpConnection;
    const result = inspectRaceConnection(connection, mainUrl);
    if (changed)
      await expect(result).rejects.toMatchObject({ reason: "target_changed" });
    else {
      const value = await result;
      if (loaders[0] !== undefined)
        expect(value.completeness.attach_limited_sections).toContain("frames");
    }
  },
);

it("captures only the scripts parsed before script capture starts", async () => {
  const directory = await createTestTempDirectory("rea-electron-snapshot-");
  const first = join(directory, "first.js");
  await writeFile(first, "1");
  const scripts: ElectronScriptDraft[] = [];
  const retention = { bytes: 2 };
  const ingestCompleteness = new CdpCaptureCompleteness();
  const executionContextFrames = new Map<string, CdpContextFrameClaim>();
  const draft = (path: string, id: string): ElectronScriptDraft => {
    const drafts: ElectronScriptDraft[] = [];
    ingestElectronScriptEvent({
      event: receiveCdpEvent({
        method: "Debugger.scriptParsed",
        params: { scriptId: id, url: pathToFileURL(path).href, hash: id },
      }),
      scripts: drafts,
      executionContextFrames,
      retention,
      completeness: ingestCompleteness,
    });
    const created = drafts[0];
    if (created === undefined) throw new Error("fixture script not ingested");
    return created;
  };
  scripts.push(draft(first, "1"));
  const captured = await captureElectronScripts({
    connection: {} as CdpConnection,
    sessionId: undefined,
    request: inspectElectronPageInputSchema.parse({
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "page",
    }),
    scripts,
    frameScopeForScript: (script) => {
      // A script parsed while capture awaits must not join this capture.
      if (scripts.length === 1) scripts.push(draft(first, "2"));
      return { state: "unknown", frameId: script.frameId };
    },
    completeness: new CdpCaptureCompleteness(["scripts", "script_sources"]),
    asarHeaderAdmission: DEFAULT_ASAR_HEADER_ADMISSION,
    files: new ElectronFileScope(),
  });
  expect(captured.total).toBe(1);
});

it("reports scripts parsed after script capture as omitted, not silently absent", async () => {
  const root = await createTestTempDirectory("rea-electron-late-script-");
  const main = join(root, "index.html");
  const early = join(root, "early.js");
  const late = join(root, "late.js");
  await Promise.all([
    writeFile(main, "main"),
    writeFile(early, "void 0;"),
    writeFile(late, "void 1;"),
  ]);
  const mainUrl = pathToFileURL(main).href;
  const events = fakeCdpEvents();
  const parsed = (scriptId: string, path: string) =>
    events.emit({
      method: "Debugger.scriptParsed",
      params: { scriptId, url: pathToFileURL(path).href, hash: scriptId },
    });
  const connection = {
    onEvent: events.onEvent,
    send: fakeCdpSend(async (method) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "main", url: mainUrl } } };
      if (method === "Debugger.enable") parsed("early", early);
      if (method === "Page.getResourceTree")
        return {
          frameTree: { frame: { id: "main", url: mainUrl }, resources: [] },
        };
      if (method === "DOMSnapshot.captureSnapshot")
        return { strings: [], documents: [] };
      // Worker capture runs after scripts were captured; the page keeps
      // loading code meanwhile.
      if (method === "Target.getTargets") {
        parsed("late", late);
        return { targetInfos: [] };
      }
      return {};
    }),
  } as unknown as CdpConnection;
  const result = await inspectRaceConnection(connection, mainUrl);
  expect(result.scripts.items.map(({ cdp_hash }) => cdp_hash)).toEqual([
    "early",
  ]);
  expect(result.scripts.total).toBe(2);
  expect(result.completeness.dropped_events.scripts).toBe(1);
});
