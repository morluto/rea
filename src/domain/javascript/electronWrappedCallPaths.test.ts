import { describe, expect, it } from "vitest";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const bundle = (entry: string) => `(() => {
 const modules = {
  2(module) { module.exports = require("electron"); },
  5(module,exports,load) {
   const electron=load(2);
   Object.defineProperty(exports,"__esModule",{value:true});
   exports.sender = function(channel) {return (...args)=>send(channel,...args)};
   function send(channel,...args) {electron.ipcRenderer.send(channel,...args)}
   exports.events = {addListener(channel,handler) {
    const guarded = (event,...args) => {if (allowed(event)) handler(event,...args)};
    return electron.ipcMain.addListener(channel,guarded);
   }};
  },
  9(module,exports,load) {const electron=load(2), helper=load(5); ${entry}}
 };
 function load(id) {const m={exports:{}};modules[id].call(m.exports,m,m.exports,load);return m.exports;}
 load(9);
})();`;

describe("wrapped Electron control-flow alternatives", () => {
  it.each(["flag ? copy : cut", "flag ? copy : unknownHandler", "choose()"])(
    "does not select one IPC handler from %s",
    (handler) => {
      const result = analyzeJavaScriptStaticSource(`
        const e = require("electron");
        const copy = event => event.sender.copy();
        const cut = event => event.sender.cut();
        function choose() { if (flag) return copy; }
        function register(channel, handler) { e.ipcMain.on(channel, handler); }
        register("test:copy", ${handler});
      `);
      expect(result.electron.ipc).toContainEqual(
        expect.objectContaining({
          channel: "test:copy",
          side: "main",
          handler_kind: "dynamic-expression",
          resolution_basis: "wrapper-substitution",
        }),
      );
      expect(result.electron.call_paths ?? []).toEqual([]);
      expect(result.parse_status).toBe("partial");
    },
  );
  it.each(["'ready'", "false", "0", "''", "({})", "(()=>{})"])(
    "short-circuits nullish fallback for %s in callbacks and seed calls",
    (left) => {
      for (const source of [
        `e.ipcMain.on("test:copy", event => { ${left} ?? event.sender.copy(); });`,
        `${left} ?? e.ipcMain.on("test:copy", event => event.sender.copy());`,
        `e.ipcMain.on("test:copy", event => { const selected = ${left} ?? (()=>event.sender.copy()); selected(); });`,
      ])
        expect(
          analyzeJavaScriptStaticSource(`const e=require("electron");${source}`)
            .electron.call_paths ?? [],
        ).toEqual([]);
    },
  );
  it.each(["null", "undefined", "void 0"])(
    "follows nullish fallback for %s",
    (left) => {
      const result = analyzeJavaScriptStaticSource(`const e=require("electron");
        ${left} ?? e.ipcMain.on("test:copy", event => { ${left} ?? event.sender.copy(); });`);
      expect(result.electron.call_paths).toContainEqual(
        expect.objectContaining({
          terminal: "ipc-event.sender.copy",
          conditions: [],
        }),
      );
    },
  );
  it("retains a nullish guard for unknown fallback rather than a falsy guard", () => {
    for (const source of [
      `e.ipcMain.on("test:copy", event => { value ?? event.sender.copy(); });`,
      `value ?? e.ipcMain.on("test:copy", event => event.sender.copy());`,
    ]) {
      const result = analyzeJavaScriptStaticSource(
        `const e=require("electron");${source}`,
      );
      expect(result.electron.call_paths).toContainEqual(
        expect.objectContaining({
          terminal: "ipc-event.sender.copy",
          conditions: [
            expect.objectContaining({
              expression: "(value) === null || (value) === undefined",
            }),
          ],
        }),
      );
    }
  });
  it.each([
    "if (flag) return copy; else return cut; return dead;",
    "if (flag) { return copy; } return cut;",
    "if (flag) { if (other) return copy; else return cut; } else return cut; return dead;",
  ])("retains every possible factory return: %s", (body) => {
    const result = analyzeJavaScriptStaticSource(`const e=require("electron");
      const copy=()=>e.ipcRenderer.send("test:copy"), cut=()=>e.ipcRenderer.send("test:cut"), dead=()=>e.ipcRenderer.send("test:dead");
      function choose(){${body}}
      e.contextBridge.exposeInMainWorld("desktop", {copy:choose()});`);
    expect(
      [
        ...new Set(result.electron.call_paths?.map((path) => path.channel)),
      ].sort(),
    ).toEqual(["test:copy", "test:cut"]);
    const paths = result.electron.call_paths ?? [];
    expect(
      paths
        .find(({ channel }) => channel === "test:copy")
        ?.conditions.map(({ expression }) => expression),
    ).toContain("flag");
    expect(
      paths
        .filter(({ channel }) => channel === "test:cut")
        .some((path) =>
          path.conditions.some(({ expression }) => expression === "!(flag)"),
        ),
    ).toBe(true);
  });
});

it("preserves an observed empty contextBridge API object", () => {
  const result = analyzeJavaScriptStaticSource(`
      const electron = require("electron");
      electron.contextBridge.exposeInMainWorld("desktop", {});
    `);
  expect(result.electron.context_bridge_apis).toContainEqual(
    expect.objectContaining({
      api_key: "desktop",
      api_status: "object-literal",
      members: [],
      unknown_members: 0,
    }),
  );
  expect(result.electron.context_bridge_apis?.[0]).not.toHaveProperty(
    "resolution_basis",
  );
  expect(result.parse_status).toBe("complete");
});

it("connects exposed closures to IPC sends and text clipboard calls", () => {
  const result = analyzeJavaScriptStaticSource(
    bundle(`
   const text = value => navigator.clipboard.writeText(value);
   const api={copy:helper.sender("example:copy"),copyText:text};
   electron.contextBridge.exposeInMainWorld("desktop",api);
  `),
  );
  expect(result.electron.context_bridge_apis).toMatchObject([
    { api_key: "desktop", members: ["copy", "copyText"] },
  ]);
  expect(result.electron.ipc).toContainEqual(
    expect.objectContaining({
      side: "renderer",
      channel: "example:copy",
      operation: "send",
    }),
  );
  expect(result.electron.call_paths).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        entry: "desktop.copy",
        channel: "example:copy",
        terminal: "electron.ipcRenderer.send",
      }),
      expect.objectContaining({
        entry: "desktop.copyText",
        terminal: "navigator.clipboard.writeText",
      }),
    ]),
  );
  const ipcFinding = result.electron.ipc.find(
    ({ channel }) => channel === "example:copy",
  );
  const ipcPath = result.electron.call_paths?.find(
    ({ entry }) => entry === "desktop.copy",
  );
  expect(ipcFinding).toBeDefined();
  expect(ipcPath?.steps.at(-1)).toBeDefined();
  expect(ipcFinding?.location).toEqual(ipcPath?.steps.at(-1)?.location);
});
it("resolves a helper factory listed after its bundle consumer", () => {
  const result = analyzeJavaScriptStaticSource(`(() => {
      const modules = {
        2(module) { module.exports = require("electron"); },
        9(module,exports,load) {
          const electron=load(2),helper=load(5);
          electron.contextBridge.exposeInMainWorld("desktop", {copy:helper.sender("after:copy")});
        },
        5(module,exports,load) {
          const electron=load(2);
          exports.sender=channel=>()=>electron.ipcRenderer.send(channel);
        }
      };
      function load(id) { const m={exports:{}}; modules[id].call(m.exports,m,m.exports,load); return m.exports; }
      load(9);
    })();`);
  expect(result.electron.call_paths).toContainEqual(
    expect.objectContaining({
      entry: "desktop.copy",
      channel: "after:copy",
      terminal: "electron.ipcRenderer.send",
    }),
  );
});
it("substitutes guarded listener callbacks and preserves guard evidence", () => {
  const result = analyzeJavaScriptStaticSource(
    bundle(
      `helper.events.addListener("example:copy",event=>event.sender.copy());`,
    ),
  );
  expect(result.electron.ipc).toContainEqual(
    expect.objectContaining({
      side: "main",
      channel: "example:copy",
      operation: "on",
    }),
  );
  expect(result.electron.call_paths).toContainEqual(
    expect.objectContaining({
      entry_kind: "ipc-handler",
      channel: "example:copy",
      terminal: "ipc-event.sender.copy",
      conditions: [expect.objectContaining({ expression: "allowed(event)" })],
    }),
  );
  const ipcFinding = result.electron.ipc.find(
    ({ channel, operation }) =>
      channel === "example:copy" && operation === "on",
  );
  const ipcStep = result.electron.call_paths
    ?.find(({ entry_kind }) => entry_kind === "ipc-handler")
    ?.steps.find(({ kind }) => kind === "ipc");
  expect(ipcFinding).toBeDefined();
  expect(ipcStep).toBeDefined();
  expect(ipcFinding?.location).toEqual(ipcStep?.location);
});
it("retains distinct wrapper invocation ranges for one IPC API source", () => {
  const result = analyzeJavaScriptStaticSource(`
      const e=require("electron");
      const copy=event=>event.sender.copy();
      function register(channel,handler){e.ipcMain.on(channel,handler);}
      register("same:channel",copy);
      register("same:channel",copy);
    `);
  const findings = result.electron.ipc.filter(
    ({ resolution_basis, channel }) =>
      resolution_basis === "wrapper-substitution" && channel === "same:channel",
  );
  expect(findings).toHaveLength(2);
  expect(findings[0]?.location).toEqual(findings[1]?.location);
  expect(findings[0]?.invocation_location).toBeDefined();
  expect(findings[1]?.invocation_location).toBeDefined();
  expect(findings[0]?.invocation_location).not.toEqual(
    findings[1]?.invocation_location,
  );
});
it("keeps a directly observed renderer operation singular when tracing its exposed callback", () => {
  const result = analyzeJavaScriptStaticSource(`
    const {contextBridge,ipcRenderer}=require("electron");
    contextBridge.exposeInMainWorld("desktop",{ping:()=>ipcRenderer.invoke("ping")});
  `);
  expect(result.electron.ipc).toHaveLength(1);
  expect(result.electron.ipc[0]).toMatchObject({
    channel: "ping",
    operation: "invoke",
  });
  expect(result.electron.ipc[0]).not.toHaveProperty("resolution_basis");
  expect(result.electron.call_paths).toContainEqual(
    expect.objectContaining({ entry: "desktop.ping", channel: "ping" }),
  );
});
it("does not identify overwritten Electron namespaces or shadowed require", () => {
  for (const source of [
    `const e=require("electron");e.ipcMain={on(){}};e.ipcMain.on("bad",event=>event.sender.copy());`,
    `function require(){return {ipcMain:{on(){}}}};const e=require("electron");e.ipcMain.on("bad",event=>event.sender.copy());`,
  ])
    expect(
      analyzeJavaScriptStaticSource(source).electron.call_paths ?? [],
    ).toEqual([]);
});
it("preserves guarded alternatives in direct exposed object literals", () => {
  const result = analyzeJavaScriptStaticSource(`
      const e=require("electron");
      const copy=()=>e.ipcRenderer.send("copy");
      const cut=()=>e.ipcRenderer.send("cut");
      e.contextBridge.exposeInMainWorld("desktop", {action: flag ? copy : cut});
    `);
  expect(result.electron.call_paths).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        entry: "desktop.action",
        channel: "copy",
        conditions: [expect.objectContaining({ expression: "flag" })],
      }),
      expect.objectContaining({
        entry: "desktop.action",
        channel: "cut",
        conditions: [expect.objectContaining({ expression: "!(flag)" })],
      }),
    ]),
  );
});
it("preserves conditions when a wrapper dispatches through conditional external methods", () => {
  const result = analyzeJavaScriptStaticSource(`
      const e=require("electron");
      const send=flag ? e.ipcRenderer.send : e.ipcRenderer.invoke;
      e.contextBridge.exposeInMainWorld("desktop", {action:()=>send("channel")});
    `);
  expect(result.electron.call_paths).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        entry: "desktop.action",
        channel: "channel",
        terminal: "electron.ipcRenderer.send",
        conditions: [expect.objectContaining({ expression: "flag" })],
      }),
      expect.objectContaining({
        entry: "desktop.action",
        channel: "channel",
        terminal: "electron.ipcRenderer.invoke",
        conditions: [expect.objectContaining({ expression: "!(flag)" })],
      }),
    ]),
  );
  expect(
    result.electron.ipc.filter(
      ({ resolution_basis, channel }) =>
        resolution_basis === "wrapper-substitution" && channel === "channel",
    ),
  ).toEqual([]);
  expect(result.parse_status).toBe("partial");
});
it("keeps conditional IPC channels unknown instead of reporting them unconditionally", () => {
  const result = analyzeJavaScriptStaticSource(`
      const e=require("electron");
      const channel=flag ? "copy" : "cut";
      e.contextBridge.exposeInMainWorld("desktop", {action:()=>e.ipcRenderer.send(channel)});
    `);
  expect(result.electron.call_paths ?? []).toEqual([]);
  expect(result.parse_status).toBe("partial");
});
it("retains enclosing branch predicates without emitting unconditional wrapper findings", () => {
  const result = analyzeJavaScriptStaticSource(`
    const e=require("electron");
    function expose(key,api){e.contextBridge.exposeInMainWorld(key,api);}
    function register(channel,handler){e.ipcMain.on(channel,handler);}
    if(flag){
      expose("conditional",{copy:()=>navigator.clipboard.writeText("copy")});
      register("only:flag",event=>event.sender.copy());
    }
  `);
  expect(result.electron.context_bridge_apis).not.toContainEqual(
    expect.objectContaining({
      api_key: "conditional",
      resolution_basis: "wrapper-substitution",
    }),
  );
  expect(result.electron.ipc).not.toContainEqual(
    expect.objectContaining({
      channel: "only:flag",
      resolution_basis: "wrapper-substitution",
    }),
  );
  for (const entry of ["conditional.copy", "only:flag"])
    expect(result.electron.call_paths).toContainEqual(
      expect.objectContaining({
        entry,
        conditions: [expect.objectContaining({ expression: "flag" })],
      }),
    );
  expect(result.parse_status).toBe("partial");
});
it("preserves the raw bridge observation for a guarded object value", () => {
  const result = analyzeJavaScriptStaticSource(`
      const e=require("electron");
      const api=flag ? {copy:()=>e.ipcRenderer.send("copy")} : {};
      e.contextBridge.exposeInMainWorld("desktop", api);
    `);
  expect(result.electron.context_bridge_apis).toContainEqual(
    expect.objectContaining({
      api_key: "desktop",
      api_status: "dynamic",
    }),
  );
  expect(result.parse_status).toBe("partial");
});
it("preserves the source expression for a guarded bridge world key", () => {
  const result = analyzeJavaScriptStaticSource(`
      const e=require("electron");
      const world=flag ? "desktop" : "shell";
      e.contextBridge.exposeInMainWorld(world, {copy:()=>e.ipcRenderer.send("copy")});
    `);
  expect(result.electron.context_bridge_apis).toContainEqual(
    expect.objectContaining({ api_key: null, api_key_expression: "world" }),
  );
  expect(result.parse_status).toBe("partial");
});
it.each(["const", "var"])(
  "does not use a %s callback initializer before exposure",
  (declaration) => {
    const result = analyzeJavaScriptStaticSource(
      bundle(`
          const electron=load(2);
          electron.contextBridge.exposeInMainWorld("desktop", {copy: callback});
          ${declaration} callback=()=>electron.ipcRenderer.send("late");
        `),
    );
    expect(result.electron.call_paths ?? []).toEqual([]);
    expect(result.parse_status).toBe("partial");
  },
);
it("does not use an original Electron module factory after its slot is replaced", () => {
  const result = analyzeJavaScriptStaticSource(
    bundle(`
      modules[2] = function(module) {
        module.exports = {contextBridge:{exposeInMainWorld(){}},ipcRenderer:{send(){}}};
      };
      const electron=load(2);
      electron.contextBridge.exposeInMainWorld("desktop", {copy:()=>electron.ipcRenderer.send("fake")});
    `),
  );
  expect(result.electron.call_paths ?? []).toEqual([]);
});
it.each(["({})", "load(2)"])(
  "does not emit the impossible logical-RHS terminal after %s",
  (left) => {
    const result = analyzeJavaScriptStaticSource(
      bundle(`
        electron.ipcMain.on("guard", event => { ${left} || event.sender.copy(); });
      `),
    );
    expect(result.electron.call_paths ?? []).toEqual([]);
  },
);
it("does not follow a statically false callback branch", () => {
  const result = analyzeJavaScriptStaticSource(
    bundle(
      `helper.events.addListener("example:copy",event=>{if(false)event.sender.copy()});`,
    ),
  );
  expect(result.electron.call_paths ?? []).toEqual([]);
});
it("retains early rejection guards and excludes calls after definite returns", () => {
  const guarded = analyzeJavaScriptStaticSource(
    `const e=require("electron");e.ipcMain.on("guard",event=>{if(!allowed(event))return;event.sender.copy()});`,
  );
  expect(guarded.electron.call_paths).toContainEqual(
    expect.objectContaining({
      conditions: [
        expect.objectContaining({ expression: "!(!allowed(event))" }),
      ],
    }),
  );
  for (const body of [
    "return;event.sender.copy()",
    "if(true)return;event.sender.copy()",
    "if(false)event.sender.copy()",
  ])
    expect(
      analyzeJavaScriptStaticSource(
        `const e=require("electron");e.ipcMain.on("dead",event=>{${body}});`,
      ).electron.call_paths ?? [],
    ).toEqual([]);
  expect(
    analyzeJavaScriptStaticSource(
      `const e=require("electron");if(false)e.ipcMain.on("dead",event=>event.sender.copy());`,
    ).electron.call_paths ?? [],
  ).toEqual([]);
});
it("rejects dynamic channels, computed overwrites, unknown spreads and reassigned callback parameters", () => {
  for (const entry of [
    `helper.events.addListener(runtimeChannel,event=>event.sender.copy());`,
    `electron[runtimeKey]={};electron.ipcMain.on("bad",event=>event.sender.copy());`,
    `const api={copy:helper.sender("bad"),...unknownApi};electron.contextBridge.exposeInMainWorld("desktop",api);`,
    `helper.events.addListener("bad",event=>{event=other;event.sender.copy()});`,
  ])
    expect(
      analyzeJavaScriptStaticSource(bundle(entry)).electron.call_paths ?? [],
    ).toEqual([]);
});
it("resolves renamed default and namespace import helpers from their syntax", () => {
  const result = analyzeJavaScriptStaticSource(
    bundle(`
   const defaultImport=x=>x&&x.__esModule?x:{default:x};
   function namespaceImport(x){if(x&&x.__esModule)return x;return unknownWrap(x)}
   const E=defaultImport(load(2)),H=namespaceImport(load(5));
   E.default.contextBridge.exposeInMainWorld("renamed",{copy:(0,H.sender)("test:renamed")});
  `),
  );
  expect(result.electron.call_paths).toContainEqual(
    expect.objectContaining({
      entry: "renamed.copy",
      channel: "test:renamed",
      terminal: "electron.ipcRenderer.send",
    }),
  );
  expect(
    result.electron.call_paths
      ?.flatMap((p) => p.steps)
      .every((step) => step.label.length > 0),
  ).toBe(true);
});
it("does not trust helper names or follow returns after a definite throw", () => {
  for (const helper of [
    `function __toESM() {return {ipcRenderer:{send(){}}}}`,
    `function __toESM(value) {throw Error("inert");return value;}`,
    `function __toESM(value) {if(true){throw Error("inert")}return value;}`,
  ]) {
    const result = analyzeJavaScriptStaticSource(`
        const electron = require("electron");
        ${helper}
        const wrapped = __toESM(electron);
        electron.contextBridge.exposeInMainWorld("desktop",{
          copy:()=>wrapped.ipcRenderer.send("test:copy")
        });
      `);
    expect(result.electron.call_paths ?? []).toEqual([]);
  }
});

describe("wrapped Electron API identity", () => {
  it("does not restore rejected Electron identities through wrapper substitution", () => {
    for (const source of [
      `const e=require("electron");e.ipcMain={on(){}};e.ipcMain.on("bad",event=>event.sender.copy());`,
      `function require(){return {ipcMain:{on(){}}}};const e=require("electron");e.ipcMain.on("bad",event=>event.sender.copy());`,
      `const e=require("electron");const ipc=e.ipcRenderer,alias=ipc;delete alias.send;function send(channel){ipc.send(channel)}send("bad");`,
      `require("electron/renderer").ipcRenderer={};const e=require("electron");function send(channel){e.ipcRenderer.send(channel)}send("bad");`,
      `const e=require("electron");[e.ipcRenderer]=replacements;function send(channel){e.ipcRenderer.send(channel)}send("bad");`,
      `const e=require("electron");for(e.contextBridge of replacements){}function expose(api){e.contextBridge.exposeInMainWorld("api",api)}expose({copy:()=>navigator.clipboard.writeText("bad")});`,
      `const e=require("electron");const ipc=e.ipcRenderer;Reflect.deleteProperty(ipc,"send");function send(channel){ipc.send(channel)}send("bad");`,
    ]) {
      const { electron } = analyzeJavaScriptStaticSource(source);
      expect(electron.call_paths ?? []).toEqual([]);
      expect(electron.ipc).toEqual([]);
      expect(electron.context_bridge_apis).toEqual([]);
    }
  });
  it("keeps unaffected Electron methods available after a sibling method write", () => {
    const { electron } = analyzeJavaScriptStaticSource(`
      const e=require("electron");
      delete e.ipcRenderer.send;
      function invoke(channel){e.ipcRenderer.invoke(channel)}
      invoke("good");
    `);
    expect(electron.ipc).toContainEqual(
      expect.objectContaining({ channel: "good", operation: "invoke" }),
    );
  });
});
