import { expect, it } from "vitest";

import { contextBridgeMemberVisitLimit } from "./electronStaticAnalysisValues.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import {
  analyzeJavaScriptStaticSource,
  analyzeParsedJavaScriptStaticSource,
} from "./javascriptStaticAnalysis.js";

it("resolves hoisted const, Object.freeze, nested const, DAGs, and TS wrappers in main and isolated worlds", () => {
  const analysis = analyzeJavaScriptStaticSource(`
      import { contextBridge, ipcRenderer } from "electron";

      const sharedLeaf = { ping: () => ipcRenderer.invoke("leaf:ping") };
      const nestedFrozen = Object.freeze({
        notify: (payload: string) => ipcRenderer.send("nested:notify", payload),
        first: sharedLeaf,
        second: sharedLeaf,
      } as const);

      const mainApi = Object.freeze({
        invokeUpload: async (item: unknown) => ipcRenderer.invoke("items:upload", item),
        sub: nestedFrozen,
      } satisfies Record<string, unknown>);

      const preFrozenApi = {
        check: () => ipcRenderer.invoke("items:check"),
      };
      Object.freeze(preFrozenApi);

      contextBridge.exposeInMainWorld("MainApi", (mainApi!));
      contextBridge.exposeInIsolatedWorld(
        1004,
        "IsolatedApi",
        Object.freeze({
          fromPreFrozen: preFrozenApi,
          inlineSub: ({ flag: true } as const),
        }),
      );
      contextBridge.exposeInMainWorld("InlineApi", ({ direct: 1 } as const));
    `);

  expect(analysis.parse_status).toBe("complete");
  expect(analysis.electron.context_bridge_apis).toMatchObject([
    {
      world: "main",
      world_id: null,
      api_key: "MainApi",
      api_key_expression: null,
      api_status: "object-literal",
      members: [
        "invokeUpload",
        "sub",
        "sub.first",
        "sub.first.ping",
        "sub.notify",
        "sub.second",
        "sub.second.ping",
      ],
      unknown_members: 0,
      resolution_sources: [
        expect.objectContaining({
          start: expect.objectContaining({ line: 11 }),
        }),
        expect.objectContaining({
          start: expect.objectContaining({ line: 5 }),
        }),
        expect.objectContaining({
          start: expect.objectContaining({ line: 4 }),
        }),
      ],
    },
    {
      world: "isolated",
      world_id: { status: "literal", value: 1004, expression: null },
      api_key: "IsolatedApi",
      api_key_expression: null,
      api_status: "object-literal",
      members: [
        "fromPreFrozen",
        "fromPreFrozen.check",
        "inlineSub",
        "inlineSub.flag",
      ],
      unknown_members: 0,
      resolution_sources: [
        expect.objectContaining({
          start: expect.objectContaining({ line: 25 }),
        }),
        expect.objectContaining({
          start: expect.objectContaining({ line: 16 }),
        }),
      ],
    },
    {
      world: "main",
      world_id: null,
      api_key: "InlineApi",
      api_key_expression: null,
      api_status: "object-literal",
      members: ["direct"],
      unknown_members: 0,
    },
  ]);
  expect(analysis.electron.context_bridge_apis[2]).not.toHaveProperty(
    "resolution_sources",
  );
  expect(analysis.electron.context_bridge_apis[0]).not.toHaveProperty(
    "resolution_basis",
  );

  expect(analysis.electron.call_paths).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        entry_kind: "bridge-member",
        entry: "MainApi.invokeUpload",
        entry_path: ["MainApi", "invokeUpload"],
        channel: "items:upload",
        terminal: "electron.ipcRenderer.invoke",
      }),
      expect.objectContaining({
        entry_kind: "bridge-member",
        entry: "MainApi.sub.notify",
        entry_path: ["MainApi", "sub", "notify"],
        channel: "nested:notify",
        terminal: "electron.ipcRenderer.send",
      }),
      expect.objectContaining({
        entry_kind: "bridge-member",
        entry: "MainApi.sub.first.ping",
        channel: "leaf:ping",
        terminal: "electron.ipcRenderer.invoke",
      }),
      expect.objectContaining({
        entry_kind: "bridge-member",
        entry: "IsolatedApi.fromPreFrozen.check",
        channel: "items:check",
        terminal: "electron.ipcRenderer.invoke",
      }),
    ]),
  );
});

it("resolves direct inline, const, frozen, and declared function exposures and forwards IPC call paths", () => {
  const analysis = analyzeJavaScriptStaticSource(`
      import { contextBridge, ipcRenderer } from "electron";

      const uploadConst = async (payload: unknown) =>
        ipcRenderer.invoke("bridge:upload", payload);
      const uploadAlias = uploadConst;

      function syncDeclared(note: string) {
        return ipcRenderer.send("bridge:sync", note);
      }

      contextBridge.exposeInMainWorld(
        "inlineInvoke",
        (id: string) => ipcRenderer.invoke("bridge:inline", id),
      );
      contextBridge.exposeInMainWorld("constUpload", uploadAlias);
      contextBridge.exposeInIsolatedWorld(
        7,
        "frozenFn",
        Object.freeze(function namedCallable(data: unknown) {
          return ipcRenderer.send("bridge:frozen", data);
        }),
      );
      contextBridge.exposeInMainWorld("declaredSync", syncDeclared);
    `);

  expect(analysis.parse_status).toBe("complete");
  expect(analysis.electron.context_bridge_apis).toMatchObject([
    {
      world: "main",
      api_key: "inlineInvoke",
      api_status: "function",
      members: [],
      unknown_members: 0,
    },
    {
      world: "main",
      api_key: "constUpload",
      api_status: "function",
      members: [],
      unknown_members: 0,
      resolution_sources: [expect.any(Object)],
    },
    {
      world: "isolated",
      world_id: { status: "literal", value: 7, expression: null },
      api_key: "frozenFn",
      api_status: "function",
      members: [],
      unknown_members: 0,
      resolution_sources: [expect.any(Object)],
    },
    {
      world: "main",
      api_key: "declaredSync",
      api_status: "function",
      members: [],
      unknown_members: 0,
      resolution_sources: [expect.any(Object)],
    },
  ]);
  expect(analysis.electron.context_bridge_apis[0]).not.toHaveProperty(
    "resolution_sources",
  );

  expect(analysis.electron.call_paths).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        entry_kind: "bridge-member",
        entry: "inlineInvoke",
        entry_path: ["inlineInvoke"],
        channel: "bridge:inline",
        terminal: "electron.ipcRenderer.invoke",
      }),
      expect.objectContaining({
        entry_kind: "bridge-member",
        entry: "constUpload",
        entry_path: ["constUpload"],
        channel: "bridge:upload",
        terminal: "electron.ipcRenderer.invoke",
      }),
      expect.objectContaining({
        entry_kind: "bridge-member",
        entry: "frozenFn",
        entry_path: ["frozenFn"],
        channel: "bridge:frozen",
        terminal: "electron.ipcRenderer.send",
      }),
      expect.objectContaining({
        entry_kind: "bridge-member",
        entry: "declaredSync",
        entry_path: ["declaredSync"],
        channel: "bridge:sync",
        terminal: "electron.ipcRenderer.send",
      }),
    ]),
  );
});

it("preserves source order when mixing inline, deferred constant, and dynamic contextBridge exposures", () => {
  const analysis = analyzeJavaScriptStaticSource(
    [
      'const { contextBridge } = require("electron");',
      "const hoisted = { alpha: 1 };",
      'contextBridge.exposeInMainWorld("first", { inline: true });',
      'contextBridge.exposeInMainWorld("second", hoisted);',
      'contextBridge.exposeInMainWorld("third", buildDynamic());',
      'contextBridge.exposeInMainWorld("fourth", () => 1);',
    ].join("\n"),
  );

  expect(
    analysis.electron.context_bridge_apis.map(({ api_key, api_status }) => [
      api_key,
      api_status,
    ]),
  ).toEqual([
    ["first", "object-literal"],
    ["second", "object-literal"],
    ["third", "dynamic"],
    ["fourth", "function"],
  ]);
});

it.each([
  ["reassigned binding", "let api = { a: 1 }; api = { b: 2 };"],
  ["direct property mutation", "const api = { a: 1 }; api.extra = 2;"],
  ["mutated callable", "const api = () => {}; api.extra = 1;"],
  [
    "shadowed Object.freeze",
    "const Object = { freeze: (x) => wrap(x) }; const api = Object.freeze({ a: 1 });",
  ],
  [
    "overwritten global Object.freeze",
    "Object.freeze = customFreeze; const api = Object.freeze({ a: 1 });",
  ],
  ["cyclic const aliases", "const a = b; const b = a; const api = a;"],
  ["unknown external identifier", "const api = externalApi;"],
])("keeps %s dynamic with an explicit unknown count", (_label, declaration) => {
  const analysis = analyzeJavaScriptStaticSource(`
        const { contextBridge } = require("electron");
        ${declaration}
        contextBridge.exposeInMainWorld("AppApi", api);
      `);

  expect(analysis.parse_status).toBe("partial");
  expect(analysis.electron.context_bridge_apis).toMatchObject([
    {
      api_key: "AppApi",
      api_status: "dynamic",
      members: [],
      unknown_members: 1,
    },
  ]);
  expect(analysis.electron.context_bridge_apis[0]).not.toHaveProperty(
    "resolution_sources",
  );
});

it.each([
  ["mutable let object", "let api = { send: () => {} };", ["send"]],
  ["mutable var object", "var api = { send: () => {} };", ["send"]],
  ["escaped binding", "const api = { a: 1 }; mutate(api);", ["a"]],
  [
    "Object.assign mutation",
    "const api = { a: 1 }; Object.assign(api, extra);",
    ["a"],
  ],
])(
  "refuses to promote %s to object-literal while allowing candidate substitution",
  (_label, declaration, expectedMembers) => {
    const analysis = analyzeJavaScriptStaticSource(`
        const { contextBridge } = require("electron");
        ${declaration}
        contextBridge.exposeInMainWorld("AppApi", api);
      `);

    expect(analysis.parse_status).toBe("partial");
    expect(analysis.electron.context_bridge_apis).toMatchObject([
      {
        api_key: "AppApi",
        api_status: "dynamic",
        resolution_basis: "wrapper-substitution",
        members: expectedMembers,
      },
    ]);
    expect(analysis.electron.context_bridge_apis[0]).not.toHaveProperty(
      "resolution_sources",
    );
  },
);

it.each([
  [
    "nested const mutated after parent construction",
    "const sub = { a: 1 }; const api = { sub }; sub.extra = 2;",
    true,
  ],
  [
    "nested mutation through shallow Object.freeze",
    "const sub = { a: 1 }; const api = Object.freeze({ sub }); api.sub.extra = 2;",
    false,
  ],
  [
    "escaped shallow Object.freeze with nested object",
    "const sub = { a: 1 }; const api = Object.freeze({ sub }); mutate(api);",
    false,
  ],
  [
    "mutable nested let object",
    "let sub = { a: 1 }; const api = { sub };",
    true,
  ],
  ["self-referential const object", "const api = { self: api };", true],
  [
    "mutually referencing const objects",
    "const a = { next: b }; const b = { prev: a }; const api = a;",
    true,
  ],
])(
  "keeps nested unsoundness %s partial and dynamic while retaining proven outer resolution sources",
  (_label, setup, expectsOuterSource) => {
    const analysis = analyzeJavaScriptStaticSource(`
        const { contextBridge } = require("electron");
        ${setup}
        contextBridge.exposeInMainWorld("AppApi", api);
      `);

    expect(analysis.parse_status).toBe("partial");
    const [finding] = analysis.electron.context_bridge_apis;
    expect(finding?.api_status).toBe("dynamic");
    if (expectsOuterSource) {
      expect(finding?.resolution_sources?.length).toBeGreaterThan(0);
    } else {
      expect(finding).not.toHaveProperty("resolution_sources");
    }
  },
);

it("preserves symbolic member and world-ID recovery alongside resolved API shapes", () => {
  const analysis = analyzeJavaScriptStaticSource(`
      import { contextBridge, ipcRenderer } from "electron";

      const bag = {
        api: {
          ping: () => ipcRenderer.invoke("bag:ping"),
        },
      };
      const shared = {
        notify: () => ipcRenderer.send("shared:notify"),
      };
      const worldId = 7;
      const isolatedObj = Object.freeze({ ok: true });

      contextBridge.exposeInMainWorld("memberApi", bag.api);
      contextBridge.exposeInMainWorld("spreadApi", { ...shared });
      contextBridge.exposeInIsolatedWorld(
        worldId,
        "isolatedCallable",
        () => ipcRenderer.invoke("isolated:call"),
      );
      contextBridge.exposeInIsolatedWorld(worldId, "isolatedObject", isolatedObj);
    `);

  expect(analysis.electron.context_bridge_apis).toMatchObject([
    {
      world: "main",
      api_key: "memberApi",
      api_status: "dynamic",
      resolution_basis: "wrapper-substitution",
      members: ["ping"],
      unknown_members: 0,
    },
    {
      world: "main",
      api_key: "spreadApi",
      api_status: "dynamic",
      resolution_basis: "wrapper-substitution",
      members: ["notify"],
      unknown_members: 0,
    },
    {
      world: "isolated",
      world_id: { status: "literal", value: 7, expression: null },
      api_key: "isolatedCallable",
      api_status: "function",
      resolution_basis: "wrapper-substitution",
      members: [],
      unknown_members: 0,
    },
    {
      world: "isolated",
      world_id: { status: "literal", value: 7, expression: null },
      api_key: "isolatedObject",
      api_status: "object-literal",
      resolution_basis: "wrapper-substitution",
      members: ["ok"],
      unknown_members: 0,
      resolution_sources: [expect.any(Object)],
    },
  ]);

  expect(analysis.electron.call_paths).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        entry_kind: "bridge-member",
        entry: "memberApi.ping",
        channel: "bag:ping",
        terminal: "electron.ipcRenderer.invoke",
      }),
      expect.objectContaining({
        entry_kind: "bridge-member",
        entry: "spreadApi.notify",
        channel: "shared:notify",
        terminal: "electron.ipcRenderer.send",
      }),
      expect.objectContaining({
        entry_kind: "bridge-member",
        entry: "isolatedCallable",
        entry_path: ["isolatedCallable"],
        channel: "isolated:call",
        terminal: "electron.ipcRenderer.invoke",
      }),
    ]),
  );
});

it("bounds exponential shared const sub-object DAGs and records truncated branches as unknown", () => {
  const keys = Array.from({ length: 20 }, (_, i) => `k${String(i)}`);
  const leafEntries = keys.map((key) => `${key}: 1`).join(", ");
  const levels = [`const l7 = { ${leafEntries} };`];
  for (let depth = 6; depth >= 0; depth -= 1) {
    const entries = keys
      .map((key) => `${key}: l${String(depth + 1)}`)
      .join(", ");
    levels.push(`const l${String(depth)} = { ${entries} };`);
  }
  const callableLeaf = keys
    .map((key) => `${key}: () => ipcRenderer.send("dag:leaf")`)
    .join(", ");
  const callableLevels = [`const c7 = { ${callableLeaf} };`];
  for (let depth = 6; depth >= 0; depth -= 1) {
    const entries = keys
      .map((key) => `${key}: c${String(depth + 1)}`)
      .join(", ");
    callableLevels.push(`const c${String(depth)} = { ${entries} };`);
  }

  const analysis = analyzeJavaScriptStaticSource(`
      import { contextBridge, ipcRenderer } from "electron";
      ${levels.join("\n")}
      ${callableLevels.join("\n")}
      contextBridge.exposeInMainWorld("DataDag", l0);
      contextBridge.exposeInMainWorld("CallableDag", c0);
    `);

  expect(analysis.parse_status).toBe("partial");
  expect(analysis.electron.context_bridge_apis).toHaveLength(2);
  expect(
    analysis.electron.context_bridge_apis[0]?.resolution_sources?.length,
  ).toBeGreaterThan(0);
  for (const finding of analysis.electron.context_bridge_apis) {
    expect(finding.api_status).toBe("dynamic");
    expect(finding.unknown_members).toBeGreaterThan(0);
    expect(finding.members.length).toBeLessThanOrEqual(
      contextBridgeMemberVisitLimit,
    );
  }
});

it("rejects TDZ read-before-init, uninvoked parameters, shadowed bindings, and classic-script global function overwrites", () => {
  const tdz = analyzeJavaScriptStaticSource(`
      const { contextBridge } = require("electron");
      contextBridge.exposeInMainWorld("EarlyApi", early);
      const early = { ok: true };
    `);
  expect(tdz.parse_status).toBe("partial");
  expect(tdz.electron.context_bridge_apis).toMatchObject([
    { api_key: "EarlyApi", api_status: "dynamic", unknown_members: 1 },
  ]);

  const paramAndShadow = analyzeJavaScriptStaticSource(`
      const { contextBridge } = require("electron");
      const outer = { ok: true };
      function registerUninvoked(candidate) {
        contextBridge.exposeInMainWorld("ParamApi", candidate);
      }
      {
        const outer = unknownReplacement();
        contextBridge.exposeInMainWorld("ShadowedApi", outer);
      }
    `);
  expect(paramAndShadow.parse_status).toBe("partial");
  expect(paramAndShadow.electron.context_bridge_apis).toMatchObject([
    { api_key: "ParamApi", api_status: "dynamic", unknown_members: 1 },
    { api_key: "ShadowedApi", api_status: "dynamic", unknown_members: 1 },
  ]);

  const classicGlobalFn = analyzeJavaScriptStaticSource(`
      const { contextBridge, ipcRenderer } = require("electron");
      function bridgeFn() { ipcRenderer.send("classic:fn"); }
      function bridgeObj() { ipcRenderer.send("classic:obj"); }
      globalThis.bridgeFn = replacement;
      globalThis.bridgeObj = replacement;
      contextBridge.exposeInMainWorld("ClassicFn", bridgeFn);
      contextBridge.exposeInMainWorld("ClassicObj", { bridgeObj });
    `);
  expect(classicGlobalFn.parse_status).toBe("partial");
  expect(classicGlobalFn.electron.context_bridge_apis).toMatchObject([
    { api_key: "ClassicFn", api_status: "dynamic", unknown_members: 1 },
    {
      api_key: "ClassicObj",
      api_status: "dynamic",
      members: ["bridgeObj"],
      unknown_members: 1,
    },
  ]);
  expect(
    (classicGlobalFn.electron.call_paths ?? []).filter(
      ({ entry_kind }) => entry_kind === "bridge-member",
    ),
  ).toEqual([]);

  const commonJsSource = `
      const { contextBridge, ipcRenderer } = require("electron");
      function forwardObj() { ipcRenderer.send("cjs:obj"); }
      function forwardFn() { ipcRenderer.send("cjs:fn"); }
      globalThis.forwardObj = replacement;
      globalThis.forwardFn = replacement;
      contextBridge.exposeInMainWorld("CjsApi", { forwardObj });
      contextBridge.exposeInMainWorld("CjsFn", forwardFn);
    `;
  for (const parsed of [
    parseJavaScriptSource(commonJsSource, "preload.cjs"),
    parseJavaScriptSource(commonJsSource, "preload.js", "commonjs"),
  ]) {
    if (parsed === null) throw new Error("Expected CommonJS parse");
    const cjsAnalysis = analyzeParsedJavaScriptStaticSource(
      commonJsSource,
      parsed,
    );
    expect(cjsAnalysis.parse_status).toBe("complete");
    expect(cjsAnalysis.electron.context_bridge_apis).toMatchObject([
      {
        api_key: "CjsApi",
        api_status: "object-literal",
        members: ["forwardObj"],
        unknown_members: 0,
      },
      {
        api_key: "CjsFn",
        api_status: "function",
        members: [],
        unknown_members: 0,
      },
    ]);
    expect(cjsAnalysis.electron.call_paths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entry_kind: "bridge-member",
          entry: "CjsApi.forwardObj",
          channel: "cjs:obj",
          terminal: "electron.ipcRenderer.send",
        }),
        expect.objectContaining({
          entry_kind: "bridge-member",
          entry: "CjsFn",
          channel: "cjs:fn",
          terminal: "electron.ipcRenderer.send",
        }),
      ]),
    );
  }
});

it("preserves shared expose(key, obj) helper behavior across multiple object and callable invocations", () => {
  const analysis = analyzeJavaScriptStaticSource(`
      const { contextBridge, ipcRenderer } = require("electron");
      function expose(key, value) {
        contextBridge.exposeInMainWorld(key, value);
      }
      const filesApi = Object.freeze({
        open: (target) => ipcRenderer.invoke("files:open", target),
        nested: { close: () => ipcRenderer.send("files:close") },
      });
      const quickPing = () => ipcRenderer.invoke("quick:ping");

      expose("files", filesApi);
      expose("ping", quickPing);
    `);

  expect(analysis.parse_status).toBe("partial");
  expect(analysis.electron.context_bridge_apis).toMatchObject([
    {
      api_key: "files",
      api_status: "dynamic",
      resolution_basis: "wrapper-substitution",
      members: ["nested", "nested.close", "open"],
      unknown_members: 0,
    },
    {
      api_key: "ping",
      api_status: "dynamic",
      resolution_basis: "wrapper-substitution",
      members: [],
      unknown_members: 0,
    },
  ]);
  expect(analysis.electron.call_paths).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        entry_kind: "bridge-member",
        entry: "files.open",
        channel: "files:open",
      }),
      expect.objectContaining({
        entry_kind: "bridge-member",
        entry: "files.nested.close",
        channel: "files:close",
      }),
      expect.objectContaining({
        entry_kind: "bridge-member",
        entry: "ping",
        entry_path: ["ping"],
        channel: "quick:ping",
      }),
    ]),
  );
});

it("recovers nested member expressions via symbolic fallback and respects overwritten duplicate keys", () => {
  const analysis = analyzeJavaScriptStaticSource(`
      const { contextBridge, ipcRenderer } = require("electron");
      const bag = {
        sub: {
          ping: () => ipcRenderer.invoke("bag:sub:ping"),
        },
      };
      const nestedMemberApi = { sub: bag.sub };
      const overwrittenConstApi = { sub: { old: 1 }, sub: 0 };

      contextBridge.exposeInMainWorld("nestedMemberApi", nestedMemberApi);
      contextBridge.exposeInMainWorld("overwrittenConstApi", overwrittenConstApi);
      contextBridge.exposeInMainWorld("overwrittenInlineApi", {
        sub: { old: 1 },
        sub: 0,
      });
    `);

  expect(analysis.electron.context_bridge_apis).toMatchObject([
    {
      api_key: "nestedMemberApi",
      api_status: "dynamic",
      resolution_basis: "wrapper-substitution",
      members: ["sub", "sub.ping"],
      unknown_members: 0,
      resolution_sources: [expect.any(Object)],
    },
    {
      api_key: "overwrittenConstApi",
      api_status: "object-literal",
      members: ["sub"],
      unknown_members: 0,
      resolution_sources: [expect.any(Object)],
    },
    {
      api_key: "overwrittenInlineApi",
      api_status: "object-literal",
      members: ["sub"],
      unknown_members: 0,
    },
  ]);
  expect(analysis.electron.call_paths).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        entry_kind: "bridge-member",
        entry: "nestedMemberApi.sub.ping",
        channel: "bag:sub:ping",
        terminal: "electron.ipcRenderer.invoke",
      }),
    ]),
  );
});

it("rechecks Object.freeze exemptions when getter-mediated ambient writes propagate later", () => {
  const analysis = analyzeJavaScriptStaticSource(`
      import { contextBridge, ipcRenderer } from "electron";

      const exposed = { safe: () => ipcRenderer.invoke("safe:call") };
      function readChannel() {
        const value = { channel: "stale:channel" };
        Object.freeze(value);
        Object.freeze(exposed);
        return value.channel;
      }

      const holder = {
        target: Object,
        get alias() {
          return this.target;
        },
      };
      holder.alias.freeze = (x) => {
        x.channel = "mutated:channel";
        x.injected = true;
        return x;
      };

      const channel = readChannel();
      ipcRenderer.send(channel);
      contextBridge.exposeInMainWorld("DelayedFreezeOverwrite", exposed);
    `);

  expect(analysis.parse_status).toBe("partial");
  expect(analysis.electron.ipc).toMatchObject([
    {
      side: "renderer",
      operation: "invoke",
      channel: "safe:call",
    },
    {
      side: "renderer",
      operation: "send",
      channel: null,
      channel_expression: "channel",
    },
  ]);
  expect(analysis.electron.context_bridge_apis).toMatchObject([
    {
      api_key: "DelayedFreezeOverwrite",
      api_status: "dynamic",
    },
  ]);
  expect(analysis.electron.context_bridge_apis[0]).not.toHaveProperty(
    "resolution_sources",
  );
});

it("terminates cleanly when an unused destructuring default references an object", () => {
  const analysis = analyzeJavaScriptStaticSource(`
      const { contextBridge, ipcRenderer } = require("electron");
      const spare = {};
      const { selected = spare } = { selected: {} };
      mutate(selected);
      const api = Object.freeze({
        ping: () => ipcRenderer.invoke("default:ping"),
      });
      contextBridge.exposeInMainWorld("api", api);
    `);

  expect(analysis.parse_status).toBe("partial");
  expect(analysis.electron.context_bridge_apis).toMatchObject([
    {
      api_key: "api",
      api_status: "object-literal",
      members: ["ping"],
      unknown_members: 0,
    },
  ]);
});

it("preserves classic-script function snapshots taken before a global overwrite while rejecting deferred closure reads", () => {
  const analysis = analyzeJavaScriptStaticSource(`
      const { contextBridge, ipcRenderer } = require("electron");
      function forward() { ipcRenderer.send("ping"); }
      function makeApi() { return { viaFactory: forward }; }
      const snapshotApi = { forward };
      const factoryApi = makeApi();
      const deferredApi = { run: () => forward() };
      globalThis.forward = replacement;
      const postWriteApi = { forward };
      contextBridge.exposeInMainWorld("snapshotApi", snapshotApi);
      contextBridge.exposeInMainWorld("factoryApi", factoryApi);
      contextBridge.exposeInMainWorld("deferredApi", deferredApi);
      contextBridge.exposeInMainWorld("postWriteApi", postWriteApi);
    `);

  expect(analysis.parse_status).toBe("partial");
  const bridgeCalls = (analysis.electron.call_paths ?? []).filter(
    ({ entry_kind }) => entry_kind === "bridge-member",
  );
  expect(bridgeCalls).toEqual([
    expect.objectContaining({
      entry_kind: "bridge-member",
      entry: "snapshotApi.forward",
      channel: "ping",
      terminal: "electron.ipcRenderer.send",
    }),
    expect.objectContaining({
      entry_kind: "bridge-member",
      entry: "factoryApi.viaFactory",
      channel: "ping",
      terminal: "electron.ipcRenderer.send",
    }),
  ]);
});

it("invalidates shallow-frozen Electron member aliases when a shared method is overwritten", () => {
  const source = `
      const { contextBridge, ipcRenderer } = require("electron");
      const a = Object.freeze({ ipc: ipcRenderer });
      const b = Object.freeze({ ipc: ipcRenderer });
      a.ipc.invoke = () => 0;
      contextBridge.exposeInMainWorld("api", {
        run: () => b.ipc.invoke("fake"),
        keep: () => b.ipc.send("real"),
      });
    `;
  const parsed = parseJavaScriptSource(source, "preload.cjs");
  if (parsed === null) throw new Error("Expected CommonJS parse");
  const analysis = analyzeParsedJavaScriptStaticSource(source, parsed);

  expect(analysis.parse_status).toBe("complete");
  const bridgeCalls = (analysis.electron.call_paths ?? []).filter(
    ({ entry_kind }) => entry_kind === "bridge-member",
  );
  expect(bridgeCalls).toEqual([
    expect.objectContaining({
      entry_kind: "bridge-member",
      entry: "api.keep",
      channel: "real",
      terminal: "electron.ipcRenderer.send",
    }),
  ]);
});

it("records resolution_sources for substituted nested functions and constants while leaving inline leaves unmarked", () => {
  const analysis = analyzeJavaScriptStaticSource(`
      import { contextBridge, ipcRenderer } from "electron";

      const ping = () => ipcRenderer.invoke("ping");
      const version = 1;
      contextBridge.exposeInMainWorld("substitutedLeafApi", { ping, version });
      contextBridge.exposeInMainWorld("inlineLeafApi", {
        ping: () => ipcRenderer.invoke("inline"),
        version: 1,
      });
    `);

  expect(analysis.parse_status).toBe("complete");
  expect(analysis.electron.context_bridge_apis).toMatchObject([
    {
      api_key: "substitutedLeafApi",
      api_status: "object-literal",
      members: ["ping", "version"],
      unknown_members: 0,
      resolution_sources: [expect.any(Object), expect.any(Object)],
    },
    {
      api_key: "inlineLeafApi",
      api_status: "object-literal",
      members: ["ping", "version"],
      unknown_members: 0,
    },
  ]);
  expect(analysis.electron.context_bridge_apis[1]).not.toHaveProperty(
    "resolution_sources",
  );
});

it("tracks member overwrites through returned properties and wrapped objects while preserving rest-array, reassigned-parameter, and generator-return isolation", () => {
  const source = `
      const { contextBridge, ipcRenderer } = require("electron");
      function pick(x) { return x.ipc; }
      const wrap = (x) => ({ ipc: x.ipc });
      function collect(...args) { return args; }
      function resetParam(x) { x = {}; return x; }
      function* values() { yield {}; return ipcRenderer; }

      const picked = Object.freeze({ ipc: pick({ ipc: ipcRenderer }) });
      picked.ipc.invoke = () => 0;

      const wrapped = Array.from([{ ipc: ipcRenderer }], wrap);
      wrapped[0].ipc.sendSync = () => 0;

      const restValues = collect(ipcRenderer);
      restValues.send = () => 0;

      const reset = resetParam(ipcRenderer);
      reset.send = () => 0;

      for (const item of values()) item.send = () => 0;

      const holder = Object.freeze({ ipc: ipcRenderer });
      contextBridge.exposeInMainWorld("api", {
        overwrittenPicked: () => holder.ipc.invoke("fake-invoke"),
        overwrittenWrapped: () => holder.ipc.sendSync("fake-sync"),
        intactSend: () => holder.ipc.send("real-send"),
      });
    `;
  const parsed = parseJavaScriptSource(source, "preload.cjs");
  if (parsed === null) throw new Error("Expected CommonJS parse");
  const analysis = analyzeParsedJavaScriptStaticSource(source, parsed);

  expect(analysis.parse_status).toBe("complete");
  const bridgeCalls = (analysis.electron.call_paths ?? []).filter(
    ({ entry_kind }) => entry_kind === "bridge-member",
  );
  expect(bridgeCalls).toEqual([
    expect.objectContaining({
      entry_kind: "bridge-member",
      entry: "api.intactSend",
      channel: "real-send",
      terminal: "electron.ipcRenderer.send",
    }),
  ]);
});

it("preserves Electron exports across fresh Array.from mappers, overwritten Object.assign sources, and unused parameter defaults while invalidating active defaults and surviving copies", () => {
  const source = `
      const { contextBridge, ipcRenderer } = require("electron");
      function empty() { return {}; }
      const mappers = { empty };
      function pick(x = ipcRenderer, { nested = ipcRenderer } = { nested: {} }) {
        return { x, nested };
      }
      function pickFallback(x = ipcRenderer) { return x; }

      const mappedFresh = Array.from([ipcRenderer], mappers.empty);
      mappedFresh[0].invoke = () => 0;

      const overwrittenAssign = Object.assign({}, { ipc: ipcRenderer }, { ipc: {} });
      overwrittenAssign.ipc.send = () => 0;

      const unusedDefault = pick({});
      unusedDefault.x.sendToHost = () => 0;
      unusedDefault.nested.invoke = () => 0;

      const activeDefault = pickFallback();
      activeDefault.sendSync = () => 0;

      const survivingAssign = Object.assign({}, { ipc: ipcRenderer }, { other: {} });
      survivingAssign.ipc.postMessage = () => 0;

      contextBridge.exposeInMainWorld("api", {
        intactInvoke: () => ipcRenderer.invoke("real-invoke"),
        intactSend: () => ipcRenderer.send("real-send"),
        intactHost: () => ipcRenderer.sendToHost("real-host"),
        overwrittenDefault: () => ipcRenderer.sendSync("fake-sync"),
        overwrittenAssign: () => ipcRenderer.postMessage("fake-post"),
      });
    `;
  const parsed = parseJavaScriptSource(source, "preload.cjs");
  if (parsed === null) throw new Error("Expected CommonJS parse");
  const analysis = analyzeParsedJavaScriptStaticSource(source, parsed);

  expect(analysis.parse_status).toBe("complete");
  expect(analysis.electron.ipc.map(({ channel }) => channel)).toEqual([
    "real-invoke",
    "real-send",
    "real-host",
  ]);
  const bridgeCalls = (analysis.electron.call_paths ?? []).filter(
    ({ entry_kind }) => entry_kind === "bridge-member",
  );
  expect(bridgeCalls).toEqual([
    expect.objectContaining({
      entry_kind: "bridge-member",
      entry: "api.intactHost",
      channel: "real-host",
      terminal: "electron.ipcRenderer.sendToHost",
    }),
    expect.objectContaining({
      entry_kind: "bridge-member",
      entry: "api.intactInvoke",
      channel: "real-invoke",
      terminal: "electron.ipcRenderer.invoke",
    }),
    expect.objectContaining({
      entry_kind: "bridge-member",
      entry: "api.intactSend",
      channel: "real-send",
      terminal: "electron.ipcRenderer.send",
    }),
  ]);
});

it("bounds deeply nested parameter-default activation without exponential stalls", () => {
  let unknownFallbackPattern = "leaf = ipcRenderer";
  let objectFallbackPattern = "leafObj = ipcRenderer";
  for (let depth = 31; depth >= 0; depth -= 1) {
    unknownFallbackPattern = `{ d${depth}: ${unknownFallbackPattern} } = globalThis.unknownFallback`;
    objectFallbackPattern = `{ d${depth}: ${objectFallbackPattern} } = {}`;
  }
  const source = `
      const { contextBridge, ipcRenderer } = require("electron");
      function unpackUnknown(${unknownFallbackPattern}) { return leaf; }
      function unpackObj(${objectFallbackPattern}) { return leafObj; }
      const maybeLeaf = unpackUnknown(globalThis.unknownInput);
      maybeLeaf.sendSync = () => 0;
      const maybeObjLeaf = unpackObj(globalThis.unknownInput);
      maybeObjLeaf.sendToHost = () => 0;
      contextBridge.exposeInMainWorld("api", {
        overwrittenSync: () => ipcRenderer.sendSync("fake-sync"),
        overwrittenHost: () => ipcRenderer.sendToHost("fake-host"),
        intactInvoke: () => ipcRenderer.invoke("real-invoke"),
      });
    `;
  const parsed = parseJavaScriptSource(source, "preload.cjs");
  if (parsed === null) throw new Error("Expected CommonJS parse");
  const analysis = analyzeParsedJavaScriptStaticSource(source, parsed);

  expect(analysis.parse_status).toBe("complete");
  expect(analysis.electron.ipc.map(({ channel }) => channel)).toEqual([
    "real-invoke",
  ]);
});

it("handles getter-deleted Object.assign keys, positional Array.from/Object.values slots, mapper defaults, and null-prototype array-likes", () => {
  const source = `
      const { contextBridge, ipcRenderer } = require("electron");

      const getterDeleted = Object.assign(
        {},
        { ipc: ipcRenderer },
        { get first() { delete this.ipc; return 0; }, ipc: {} },
      );
      getterDeleted.ipc.sendSync = () => 0;

      Array.from([ipcRenderer, {}], (x) => x)[1].invoke = () => 0;
      Object.values({ a: ipcRenderer, b: {} })[1].send = () => 0;
      Array.from([{}], (x = ipcRenderer) => x)[0].sendToHost = () => 0;
      Array.from({ __proto__: null, 0: {}, length: 1, extra: ipcRenderer })[0].postMessage = () => 0;

      contextBridge.exposeInMainWorld("api", {
        overwrittenSync: () => ipcRenderer.sendSync("fake-sync"),
        intactInvoke: () => ipcRenderer.invoke("real-invoke"),
        intactSend: () => ipcRenderer.send("real-send"),
        intactHost: () => ipcRenderer.sendToHost("real-host"),
        intactPost: () => ipcRenderer.postMessage("real-post", "*"),
      });
    `;
  const parsed = parseJavaScriptSource(source, "preload.cjs");
  if (parsed === null) throw new Error("Expected CommonJS parse");
  const analysis = analyzeParsedJavaScriptStaticSource(source, parsed);

  expect(analysis.parse_status).toBe("complete");
  expect(analysis.electron.ipc.map(({ channel }) => channel)).toEqual([
    "real-invoke",
    "real-send",
    "real-host",
    "real-post",
  ]);
});

it("recovers nested symbolic bridge members for TypeScript-wrapped inline contextBridge objects", () => {
  const source = `
      const { contextBridge, ipcRenderer } = require("electron");
      const bag = { sub: { ping: () => ipcRenderer.invoke("cts:ping") } };
      contextBridge.exposeInMainWorld("api", ({ sub: bag.sub } as const));
    `;
  const parsed = parseJavaScriptSource(source, "preload.cts");
  if (parsed === null) throw new Error("Expected .cts parse");
  const analysis = analyzeParsedJavaScriptStaticSource(source, parsed);

  expect(analysis.parse_status).toBe("partial");
  expect(analysis.electron.context_bridge_apis).toMatchObject([
    {
      api_key: "api",
      api_status: "dynamic",
      resolution_basis: "wrapper-substitution",
      members: ["sub", "sub.ping"],
      unknown_members: 0,
    },
  ]);
  expect(analysis.electron.call_paths).toEqual([
    expect.objectContaining({
      entry_kind: "bridge-member",
      entry: "api.sub.ping",
      channel: "cts:ping",
      terminal: "electron.ipcRenderer.invoke",
    }),
  ]);
});

it("marks contextBridge getter and setter accessors as dynamic with unknown_members while keeping object methods complete", () => {
  const accessorAnalysis = analyzeJavaScriptStaticSource(`
      import { contextBridge, ipcRenderer } from "electron";

      const makeNested = () => ({ hidden: () => ipcRenderer.invoke("hidden:call") });
      const getterApi = {
        get nested() {
          return makeNested();
        },
      };
      const accessorPairApi = {
        get pair() {
          return makeNested();
        },
        set pair(_value: unknown) {},
      };

      contextBridge.exposeInMainWorld("getterApi", getterApi);
      contextBridge.exposeInMainWorld("accessorPairApi", accessorPairApi);
    `);

  expect(accessorAnalysis.parse_status).toBe("partial");
  expect(accessorAnalysis.electron.context_bridge_apis).toMatchObject([
    {
      api_key: "getterApi",
      api_status: "dynamic",
      members: ["nested"],
      unknown_members: 1,
    },
    {
      api_key: "accessorPairApi",
      api_status: "dynamic",
      members: ["pair"],
      unknown_members: 1,
    },
  ]);

  const methodAnalysis = analyzeJavaScriptStaticSource(`
      import { contextBridge, ipcRenderer } from "electron";

      const methodApi = {
        ping() {
          return ipcRenderer.invoke("method:ping");
        },
      };

      contextBridge.exposeInMainWorld("methodApi", methodApi);
    `);

  expect(methodAnalysis.parse_status).toBe("complete");
  expect(methodAnalysis.electron.context_bridge_apis).toMatchObject([
    {
      api_key: "methodApi",
      api_status: "object-literal",
      members: ["ping"],
      unknown_members: 0,
    },
  ]);
});

it("preserves copy-time identities across Object.values and Array.from, tagged-template defaults, and unresolved callables", () => {
  const source = `
      const { contextBridge, ipcRenderer } = require("electron");

      const src = { ipc: {} };
      const vals = Object.values(src);
      src.ipc = ipcRenderer;
      vals[0].invoke = () => 0;

      const xs = [{}];
      const directCopy = Array.from(xs);
      const mappedCopy = Array.from(xs, (item) => item);
      xs[0] = ipcRenderer;
      directCopy[0].send = () => 0;
      mappedCopy[0].sendToHost = () => 0;

      function tag(_strings, fallback = ipcRenderer) {
        return fallback;
      }
      const taggedDefined = tag\`\${{}}\`;
      taggedDefined.postMessage = () => 0;

      const pick = globalThis.pick || (() => ({}));
      const picked = pick(ipcRenderer);
      picked.sendSync = () => 0;

      contextBridge.exposeInMainWorld("api", {
        intactInvoke: () => ipcRenderer.invoke("real-invoke"),
        intactSend: () => ipcRenderer.send("real-send"),
        intactHost: () => ipcRenderer.sendToHost("real-host"),
        intactPost: () => ipcRenderer.postMessage("real-post", "*"),
        overwrittenSync: () => ipcRenderer.sendSync("fake-sync"),
      });
    `;
  const parsed = parseJavaScriptSource(source, "preload.cjs");
  if (parsed === null) throw new Error("Expected CommonJS parse");
  const analysis = analyzeParsedJavaScriptStaticSource(source, parsed);

  expect(analysis.parse_status).toBe("complete");
  expect(analysis.electron.ipc.map(({ channel }) => channel)).toEqual([
    "real-invoke",
    "real-send",
    "real-host",
    "real-post",
  ]);
});

it("captures projected return values at synchronous call boundaries while keeping nested mutations and lazy generators live", () => {
  const safeSource = `
      const { contextBridge, ipcRenderer } = require("electron");

      function pick(x) {
        return x.ipc;
      }
      function pickDestructured(x) {
        const { ipc } = x;
        return ipc;
      }
      const src = { ipc: {} };
      const saved = pick(src);
      const savedDestructured = pickDestructured(src);
      src.ipc = ipcRenderer;
      saved.invoke = () => 0;
      savedDestructured.send = () => 0;

      const box = {};
      const nestedSrc = { ipc: box };
      const savedNested = pick(nestedSrc);
      box.fn = ipcRenderer;
      savedNested.fn.sendToHost = () => 0;

      function* lazyGen(x) {
        yield x.ipc;
      }
      const genSrc = { ipc: {} };
      const iter = lazyGen(genSrc);
      genSrc.ipc = ipcRenderer;
      for (const yielded of iter) {
        yielded.sendSync = () => 0;
      }

      contextBridge.exposeInMainWorld("api", {
        intactInvoke: () => ipcRenderer.invoke("real-invoke"),
        intactSend: () => ipcRenderer.send("real-send"),
        overwrittenHost: () => ipcRenderer.sendToHost("fake-host"),
        overwrittenSync: () => ipcRenderer.sendSync("fake-sync"),
      });
    `;
  const parsed = parseJavaScriptSource(safeSource, "preload.cjs");
  if (parsed === null) throw new Error("Expected CommonJS parse");
  const analysis = analyzeParsedJavaScriptStaticSource(safeSource, parsed);

  expect(analysis.parse_status).toBe("complete");
  expect(analysis.electron.ipc.map(({ channel }) => channel)).toEqual([
    "real-invoke",
    "real-send",
  ]);
});

it("resolves named intrinsic sources before their call escape, forwarded default frames, and tagged-template .raw slots", () => {
  const source = `
      const e = require("electron");
      const { contextBridge, ipcRenderer } = e;

      const namedValsSrc = { a: ipcRenderer, b: {} };
      const vals = Object.values(namedValsSrc);
      vals[1].invoke = () => 0;

      const namedAssignOverride = { ipc: {} };
      const merged = Object.assign({ ipc: ipcRenderer }, namedAssignOverride);
      merged.ipc.send = () => 0;

      const namedArrayLike = { __proto__: null, 0: {}, length: 1, extra: ipcRenderer };
      Array.from(namedArrayLike)[0].postMessage = () => 0;

      function pickDefault(x = e) {
        return x;
      }
      function outerDefined(x) {
        return pickDefault(x);
      }
      function outerCopy(xs) {
        return Array.from(xs);
      }
      const definedRes = outerDefined({});
      definedRes.ipcRenderer = {};
      const copiedRes = outerCopy([{}]);
      copiedRes[0].sendToHost = () => 0;

      function tagRaw({ raw = e }) {
        return raw;
      }
      const rawRes = tagRaw\`x\`;
      Reflect.set(rawRes, "ipcRenderer", {});

      const mutatedBeforeSrc = { b: {} };
      mutatedBeforeSrc[String(Date.now())] = ipcRenderer;
      const mutatedVals = Object.values(mutatedBeforeSrc);
      mutatedVals[1].sendSync = () => 0;

      contextBridge.exposeInMainWorld("api", {
        intactInvoke: () => ipcRenderer.invoke("real-invoke"),
        intactSend: () => ipcRenderer.send("real-send"),
        intactPost: () => ipcRenderer.postMessage("real-post", "*"),
        intactHost: () => ipcRenderer.sendToHost("real-host"),
        overwrittenSync: () => ipcRenderer.sendSync("fake-sync"),
      });
    `;
  const parsed = parseJavaScriptSource(source, "preload.cjs");
  if (parsed === null) throw new Error("Expected CommonJS parse");
  const analysis = analyzeParsedJavaScriptStaticSource(source, parsed);

  expect(analysis.parse_status).toBe("complete");
  expect(analysis.electron.ipc.map(({ channel }) => channel)).toEqual([
    "real-invoke",
    "real-send",
    "real-post",
    "real-host",
  ]);
});

it("retains default activation when an outer frame mutates or omits a forwarded argument", () => {
  const source = `
      const e = require("electron");
      const { contextBridge, ipcRenderer } = e;

      function pickIpc(x = ipcRenderer) {
        return x;
      }
      function outerOmitted(x) {
        return pickIpc(x);
      }
      function outerMutated(o) {
        o.a = undefined;
        return pickIpc(o.a);
      }
      outerOmitted().invoke = () => 0;
      outerMutated({ a: {} }).send = () => 0;

      contextBridge.exposeInMainWorld("api", {
        overwrittenInvoke: () => ipcRenderer.invoke("fake-invoke"),
        overwrittenSend: () => ipcRenderer.send("fake-send"),
        intactHost: () => ipcRenderer.sendToHost("real-host"),
      });
    `;
  const parsed = parseJavaScriptSource(source, "preload.cjs");
  if (parsed === null) throw new Error("Expected CommonJS parse");
  const analysis = analyzeParsedJavaScriptStaticSource(source, parsed);

  expect(analysis.parse_status).toBe("complete");
  expect(analysis.electron.ipc.map(({ channel }) => channel)).toEqual([
    "real-host",
  ]);
});

it("prunes unreachable conditional and logical arms before attributing Electron member writes", () => {
  const source = `
      const { contextBridge, ipcRenderer } = require("electron");
      const truthyFlag = true;

      const condAlias = truthyFlag ? {} : ipcRenderer;
      condAlias.invoke = () => 0;

      const orAlias = {} || ipcRenderer;
      orAlias.send = () => 0;

      const andAlias = (false && ipcRenderer) || {};
      andAlias.postMessage = () => 0;

      const nullishAlias = {} ?? ipcRenderer;
      nullishAlias.sendToHost = () => 0;

      const reachableAlias = !truthyFlag ? {} : ipcRenderer;
      reachableAlias.sendSync = () => 0;

      contextBridge.exposeInMainWorld("api", {
        intactInvoke: () => ipcRenderer.invoke("real-invoke"),
        intactSend: () => ipcRenderer.send("real-send"),
        intactPost: () => ipcRenderer.postMessage("real-post", "*"),
        intactHost: () => ipcRenderer.sendToHost("real-host"),
        overwrittenSync: () => ipcRenderer.sendSync("fake-sync"),
      });
    `;
  const parsed = parseJavaScriptSource(source, "preload.cjs");
  if (parsed === null) throw new Error("Expected CommonJS parse");
  const analysis = analyzeParsedJavaScriptStaticSource(source, parsed);

  expect(analysis.parse_status).toBe("complete");
  expect(analysis.electron.ipc.map(({ channel }) => channel)).toEqual([
    "real-invoke",
    "real-send",
    "real-post",
    "real-host",
  ]);
});

it("snapshots Object.assign and Array.from copies after argument evaluation while preserving argument object identity", () => {
  const source = `
      const { contextBridge, ipcRenderer } = require("electron");

      const src = { ipc: ipcRenderer };
      const copy = Object.assign({}, src, ((src.ipc = {}), {}));
      copy.ipc.invoke = () => 0;

      const spreadElem = { ipc: ipcRenderer };
      const spreadHolder = [spreadElem];
      const spreadCopy = Object.assign(
        {},
        ...spreadHolder,
        ((spreadElem.ipc = {}), {}),
      );
      spreadCopy.ipc.send = () => 0;

      const slot = { ipc: ipcRenderer };
      const mapped = Array.from(
        [slot],
        (x) => x.ipc,
        ((slot.ipc = {}), undefined),
      );
      mapped[0].postMessage = () => 0;

      let rebound = { ipc: ipcRenderer };
      const reboundCopy = Object.assign({}, rebound, ((rebound = {}), {}));
      reboundCopy.ipc.sendSync = () => 0;

      const unpackedArr = [{ ipc: ipcRenderer }];
      const unpackedCopy = Object.assign(
        {},
        ...unpackedArr,
        ((unpackedArr[0] = {}), {}),
      );
      unpackedCopy.ipc.sendToHost = () => 0;

      contextBridge.exposeInMainWorld("api", {
        intactInvoke: () => ipcRenderer.invoke("real-invoke"),
        intactSend: () => ipcRenderer.send("real-send"),
        intactPost: () => ipcRenderer.postMessage("real-post", "*"),
        overwrittenSync: () => ipcRenderer.sendSync("fake-sync"),
        overwrittenHost: () => ipcRenderer.sendToHost("fake-host"),
      });
    `;
  const parsed = parseJavaScriptSource(source, "preload.cjs");
  if (parsed === null) throw new Error("Expected CommonJS parse");
  const analysis = analyzeParsedJavaScriptStaticSource(source, parsed);

  expect(analysis.parse_status).toBe("complete");
  expect(analysis.electron.ipc.map(({ channel }) => channel)).toEqual([
    "real-invoke",
    "real-send",
    "real-post",
  ]);
});

it("preserves fresh containers for known intrinsic return values while retaining prototype and element projections", () => {
  const source = `
      const e = require("electron");
      const { contextBridge, ipcRenderer } = e;

      const local = Object.create(ipcRenderer);
      Object.defineProperty(local, "invoke", { value: () => 0 });
      local.send = () => 0;

      const arr = Array.of(ipcRenderer);
      Object.defineProperty(arr, "0", { value: {} });
      arr.push = () => 0;

      const vals = Object.values(ipcRenderer);
      vals.push = () => 0;

      const fromEnt = Object.fromEntries([["ipc", ipcRenderer]]);
      Object.defineProperty(fromEnt, "other", { value: 1 });

      const protoChild = Object.create(e);
      protoChild.ipcRenderer.sendSync = () => 0;

      Array.of(ipcRenderer)[0].sendToHost = () => 0;

      contextBridge.exposeInMainWorld("api", {
        intactInvoke: () => ipcRenderer.invoke("real-invoke"),
        intactSend: () => ipcRenderer.send("real-send"),
        intactPost: () => ipcRenderer.postMessage("real-post", "*"),
        overwrittenSync: () => ipcRenderer.sendSync("fake-sync"),
        overwrittenHost: () => ipcRenderer.sendToHost("fake-host"),
      });
    `;
  const parsed = parseJavaScriptSource(source, "preload.cjs");
  if (parsed === null) throw new Error("Expected CommonJS parse");
  const analysis = analyzeParsedJavaScriptStaticSource(source, parsed);

  expect(analysis.parse_status).toBe("complete");
  expect(analysis.electron.ipc.map(({ channel }) => channel)).toEqual([
    "real-invoke",
    "real-send",
    "real-post",
  ]);
});
