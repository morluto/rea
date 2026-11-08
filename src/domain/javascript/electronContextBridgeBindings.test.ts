import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

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
  ["mutable let object", "let api = { send: () => {} };"],
  ["mutable var object", "var api = { send: () => {} };"],
  ["reassigned binding", "let api = { a: 1 }; api = { b: 2 };"],
  ["direct property mutation", "const api = { a: 1 }; api.extra = 2;"],
  ["escaped binding", "const api = { a: 1 }; mutate(api);"],
  [
    "Object.assign mutation",
    "const api = { a: 1 }; Object.assign(api, extra);",
  ],
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
  [
    "nested const mutated after parent construction",
    "const sub = { a: 1 }; const api = { sub }; sub.extra = 2;",
  ],
  [
    "nested mutation through shallow Object.freeze",
    "const sub = { a: 1 }; const api = Object.freeze({ sub }); api.sub.extra = 2;",
  ],
  [
    "escaped shallow Object.freeze with nested object",
    "const sub = { a: 1 }; const api = Object.freeze({ sub }); mutate(api);",
  ],
  ["mutable nested let object", "let sub = { a: 1 }; const api = { sub };"],
  ["self-referential const object", "const api = { self: api };"],
  [
    "mutually referencing const objects",
    "const a = { next: b }; const b = { prev: a }; const api = a;",
  ],
])(
  "keeps nested unsoundness %s dynamic with unknown count",
  (_label, setup) => {
    const analysis = analyzeJavaScriptStaticSource(`
        const { contextBridge } = require("electron");
        ${setup}
        contextBridge.exposeInMainWorld("AppApi", api);
      `);

    expect(analysis.parse_status).toBe("partial");
    const [finding] = analysis.electron.context_bridge_apis;
    expect(finding?.api_status).toBe("dynamic");
    expect(finding?.unknown_members).toBeGreaterThanOrEqual(1);
  },
);

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
      const { contextBridge } = require("electron");
      function bridgeCall() { return 1; }
      globalThis.bridgeCall = replacement;
      contextBridge.exposeInMainWorld("ClassicFn", bridgeCall);
    `);
  expect(classicGlobalFn.parse_status).toBe("partial");
  expect(classicGlobalFn.electron.context_bridge_apis).toMatchObject([
    { api_key: "ClassicFn", api_status: "dynamic", unknown_members: 1 },
  ]);
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
