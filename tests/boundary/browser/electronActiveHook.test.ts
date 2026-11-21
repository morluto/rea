import { withVerifierCleanup } from "../../../scripts/lib/verifier-cleanup.mjs";
import { createTestProcessRegistry } from "../../support/process/processFixture.js";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { expect, it, onTestFinished } from "vitest";

import { electronActiveTimelineEventSchema } from "../../../src/domain/javascript/electronActiveObservation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const electronModuleSource = `const { EventEmitter } = require("node:events");
const app = new EventEmitter();
app.isReady = () => true;
app.relaunch = () => undefined;
app.setAsDefaultProtocolClient = () => true;
app.setLoginItemSettings = () => undefined;
app.requestSingleInstanceLock = () => globalThis.__singleInstanceLockHeld !== false;
app.moveToApplicationsFolder = () => {
  throw new Error("moveToApplicationsFolder must not run");
};
const ipcMain = new EventEmitter();
ipcMain.handlers = new Map();
ipcMain.handle = (channel, listener) => ipcMain.handlers.set(channel, listener);
const ipcRenderer = {
  send: () => undefined,
  sendSync: () => "ok",
  invoke: () => Promise.resolve("ok"),
  postMessage: () => undefined,
};
class WebContents extends EventEmitter {
  constructor() {
    super();
    this.id = 12;
  }
  loadFile() { return Promise.resolve(); }
  loadURL() { return Promise.resolve(); }
  loadDataURL() { return Promise.resolve(); }
  send() { return undefined; }
  postMessage() { return undefined; }
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; return undefined; }
}
class BrowserWindow extends EventEmitter {
  constructor(options) {
    super();
    this.id = 3;
    this.webContents = new WebContents();
    this.options = options;
    this.webContents.session = options.webPreferences.session ?? (options.webPreferences.partition ? createSession() : session);
    this.webContents.getLastWebPreferences = () => options.webPreferences;
    app.emit("browser-window-created", {}, this);
  }
}
const utilityProcess = {
  fork: () => {
    const child = new EventEmitter();
    child.pid = 44;
    child.postMessage = () => undefined;
    return child;
  },
};
globalThis.__nativeShellCalls = [];
const shell = {
  openExternal: (url) => { globalThis.__nativeShellCalls.push(["openExternal", url]); return Promise.resolve(); },
  openPath: (path) => { globalThis.__nativeShellCalls.push(["openPath", path]); return Promise.resolve(""); },
  trashItem: (path) => { globalThis.__nativeShellCalls.push(["trashItem", path]); return require("node:fs/promises").unlink(path); },
  showItemInFolder: (path) => { globalThis.__nativeShellCalls.push(["showItemInFolder", path]); },
  writeShortcutLink: (path) => { globalThis.__nativeShellCalls.push(["writeShortcutLink", path]); return true; },
};
const createSession = () => {
  const value = new EventEmitter();
  value.setPermissionRequestHandler = function(handler) { this.requestHandler = handler; };
  value.setPermissionCheckHandler = function(handler) { this.checkHandler = handler; };
  value.setCertificateVerifyProc = function(handler) { this.certificateHandler = handler; };
  app.emit("session-created", value);
  return value;
};
const session = createSession();
const customSession = createSession();
const contextBridge = {
  exposeInMainWorld: () => undefined,
  exposeInIsolatedWorld: () => undefined,
};
module.exports = {
  app,
  get BrowserWindow() { return BrowserWindow; },
  contextBridge,
  ipcMain,
  ipcRenderer,
  session: {
    defaultSession: session,
    fromPartition: () => customSession,
    fromPath: () => customSession,
  },
  shell,
  utilityProcess,
};
`;

const activeCaptureSource = `(async () => {
const electron = require("electron");
const window = new electron.BrowserWindow({ webPreferences: { preload: "/approved/preload.js" } });
const channel = "x".repeat(2048);
electron.ipcMain.handle(channel, async () => ({ ok: true }));
await electron.ipcMain.handlers.get(channel)({ sender: { id: 9 }, senderFrame: { routingId: 7 } }, ...Array.from({ length: 40 }, () => ({ value: true })));
window.webContents.send("main-to-renderer", { value: true });
window.webContents.emit("render-process-gone", { reason: "crashed" });
const longEventName = "l".repeat(2048);
window.webContents.emit(longEventName);
const utility = electron.utilityProcess.fork("utility.js");
utility.emit("message", { data: { value: true } });
utility.postMessage({ value: true });
const cancelledDownloads = [];
for (const [name, session] of [
  ["default", electron.session.defaultSession],
  ["partition", electron.session.fromPartition("persist:custom")],
]) {
  const item = { cancel() { cancelledDownloads.push(this === item ? name : "foreign"); } };
  session.emit("will-download", {}, item, window.webContents);
}
const defaultPopupDecision = window.webContents.windowOpenHandler({ url: "https://default-popup.invalid" });
window.webContents.setWindowOpenHandler(() => ({ action: "allow" }));
const popupDecision = window.webContents.windowOpenHandler({ url: "https://popup.invalid" });
electron.shell.openExternal("https://example.invalid").catch(() => undefined);
electron.app.relaunch();
const moveResult = electron.app.moveToApplicationsFolder({
  conflictHandler: () => {
    throw new Error("conflictHandler must not run");
  },
});
electron.contextBridge.exposeInMainWorld("api", { value: true });
window.webContents.loadURL("https://example.invalid").catch(() => undefined);
for (let index = 0; index < 6000; index++) electron.app.relaunch();
electron.ipcRenderer.send("x".repeat(9 * 1024 * 1024));
electron.app.emit("r".repeat(9 * 1024 * 1024));
const manyArguments = Array(30_000).fill(true);
for (let index = 0; index < 8; index++) electron.ipcRenderer.send("shape-budget", ...manyArguments);
try { process.dlopen({}, "/missing/native.node"); } catch {}
const firstSnapshot = globalThis.__reaElectronActiveSnapshot();
const firstIpc = firstSnapshot.events.find((event) => event.kind === "main-handler-invocation");
if (firstIpc) { firstIpc.channel = "mutated"; firstIpc.argument_shapes.push("mutated"); }
firstSnapshot.events.length = 0;
const snapshot = globalThis.__reaElectronActiveSnapshot();
process.stdout.write(JSON.stringify({ snapshot, default_popup_decision: defaultPopupDecision, popup_decision: popupDecision, move_result: moveResult, cancelled_downloads: cancelledDownloads }) + "\\n");
})();
`;

it("retains active hook evidence within its event-retention budget", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-");
  await writeElectronFixture(root);
  const script = join(root, "exercise.cjs");
  await writeFile(script, activeCaptureSource);
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const result = JSON.parse(
    execution.stdout.trim().split("\n").at(-1) ?? "null",
  ) as {
    readonly default_popup_decision: { readonly action: string };
    readonly popup_decision: { readonly action: string };
    readonly move_result: boolean;
    readonly cancelled_downloads: readonly string[];
    readonly snapshot: {
      readonly hook_error: boolean;
      readonly events: readonly Record<string, unknown>[];
      readonly observed: number;
      readonly retained: number;
      readonly dropped: number;
      readonly dropped_ipc: number;
      readonly dropped_runtime: number;
      readonly retention_budget_bytes: number;
    };
  };
  const { snapshot } = result;
  expect(
    electronActiveTimelineEventSchema.array().parse(snapshot.events),
  ).toHaveLength(snapshot.retained);

  expect(snapshot.hook_error).toBe(false);
  expect(snapshot.observed).toBe(snapshot.retained + snapshot.dropped);
  expect(snapshot.observed).toBeGreaterThan(5_000);
  expect(snapshot.dropped_ipc).toBeGreaterThanOrEqual(2);
  expect(snapshot.dropped_runtime).toBe(1);
  expect(snapshot.dropped).toBe(
    snapshot.dropped_ipc + snapshot.dropped_runtime,
  );
  expect(
    snapshot.events.some(
      (event) =>
        event.kind === "ipc-renderer-send" &&
        Array.isArray(event.argument_shapes) &&
        event.argument_shapes.length === 30_000,
    ),
  ).toBe(true);
  expect(
    Buffer.byteLength(JSON.stringify(snapshot), "utf8"),
  ).toBeLessThanOrEqual(snapshot.retention_budget_bytes);
  const sequences = snapshot.events.map((event) => event.sequence as number);
  expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
  expect(snapshot.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "window-lifecycle", event: "created" }),
      expect.objectContaining({ kind: "preload", event: "configured" }),
      expect.objectContaining({ kind: "shell-attempt", phase: "blocked" }),
      expect.objectContaining({
        kind: "app-lifecycle",
        event: "moveToApplicationsFolder",
        phase: "blocked",
        argument_shapes: ["object"],
        error: true,
      }),
      expect.objectContaining({
        kind: "updater",
        event: "relaunch",
        phase: "blocked",
      }),
      expect.objectContaining({ kind: "native-addon" }),
      expect.objectContaining({ kind: "popup-attempt", phase: "blocked" }),
    ]),
  );
  expect(result.default_popup_decision).toEqual({ action: "deny" });
  expect(result.popup_decision).toEqual({ action: "deny" });
  expect(result.move_result).toBe(false);
  expect(result.cancelled_downloads).toEqual(["default", "partition"]);
  expect(
    snapshot.events.filter(
      (event) => event.kind === "download" && event.phase === "blocked",
    ),
  ).toEqual([
    expect.objectContaining({ target: "webContents:12" }),
    expect.objectContaining({ target: "webContents:12" }),
  ]);
  const ipc = snapshot.events.find(
    (event) => event.kind === "main-handler-invocation",
  );
  expect(ipc).toMatchObject({
    correlation_id: expect.stringMatching(/^capture:\d+:\d+$/u),
    direction: "renderer-to-main",
    sender: "webContents:9",
    frame: "frame:7",
  });
  expect(ipc?.channel).toBe("x".repeat(2_048));
  expect(ipc?.argument_shapes).toHaveLength(40);
  expect(snapshot.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "web-contents-lifecycle",
        event: "l".repeat(2048),
      }),
    ]),
  );
});

it.each([true, false])(
  "denies permissions before registration and after a handler is replaced or cleared (app ready: %s)",
  async (ready) => {
    const root = await createTestTempDirectory("rea-electron-session-policy-");
    await writeElectronFixture(
      root,
      electronModuleSource +
        `
let ready = ${String(ready)};
app.isReady = () => ready;
app.once("ready", () => { ready = true; });
Object.defineProperty(module.exports.session, "defaultSession", {
  get() {
    if (!ready) throw new Error("default session requested before app ready");
    return session;
  },
});
const pathSession = createSession();
module.exports.session.fromPath = () => pathSession;
`,
    );
    const script = join(root, "permissions.cjs");
    await writeFile(
      script,
      `const { app, BrowserWindow, session } = require("electron");
const exercise = (selected, id) => {
  const query = () => {
    let granted = true;
    selected.requestHandler?.({ id }, "notifications", value => { granted = value; });
    return { granted, checked: selected.checkHandler?.({ id }, "notifications") ?? true };
  };
  const initial = query();
  let applicationCalls = 0;
  selected.setPermissionRequestHandler((_contents, _permission, callback) => { applicationCalls++; callback(true); });
  selected.setPermissionCheckHandler(() => { applicationCalls++; return true; });
  const replaced = query();
  selected.setPermissionRequestHandler(null);
  selected.setPermissionCheckHandler(null);
  return { outcomes: [initial, replaced, query()], applicationCalls };
};
const rows = [];
const initiallyReady = app.isReady();
if (!initiallyReady) app.emit("ready");
rows.push(exercise(session.defaultSession, 45));
if (initiallyReady) {
  rows.push(exercise(session.fromPartition("persist:caller"), 46));
  rows.push(exercise(session.fromPath("/caller/profile"), 47));
  rows.push(exercise(new BrowserWindow({ webPreferences: { partition: "caller" } }).webContents.session, 48));
  const engine = {
    setPermissionRequestHandler(handler) { this.requestHandler = handler; },
    setPermissionCheckHandler(handler) { this.checkHandler = handler; },
  };
  app.emit("session-created", engine);
  rows.push(exercise(engine, 49));
}
const certificate = [];
session.defaultSession.setCertificateVerifyProc((_request, done) => done(0));
session.defaultSession.certificateHandler({ hostname: "certificate-private.invalid" }, code => certificate.push(code));
const snapshot = globalThis.__reaElectronActiveSnapshot();
console.log(JSON.stringify({ rows, certificate, snapshot }));`,
    );
    const execution = await runNode(script, root);
    expect(execution.code, execution.stderr).toBe(0);
    const { rows, certificate, snapshot } = JSON.parse(execution.stdout) as {
      rows: unknown;
      certificate: unknown;
      snapshot: { hook_error: boolean; events: unknown };
    };
    const ids = ready ? [45, 46, 47, 48, 49] : [45];
    const denied = { granted: false, checked: false };
    expect(rows).toEqual(
      ids.map(() => ({
        outcomes: [denied, denied, denied],
        applicationCalls: 0,
      })),
    );
    expect(snapshot.hook_error).toBe(false);
    const events = electronActiveTimelineEventSchema
      .array()
      .parse(snapshot.events);
    const requestAndCheck = ["permission-request", "permission-check"];
    expect(events.filter(({ kind }) => kind === "permission")).toEqual([
      ...ids.flatMap((id) =>
        [...requestAndCheck, ...requestAndCheck, ...requestAndCheck].map(
          (event) =>
            expect.objectContaining({
              event,
              phase: "blocked",
              target: `webContents:${String(id)}`,
              argument_shapes: ["string"],
              error: true,
            }),
        ),
      ),
      expect.objectContaining({
        event: "certificate-error",
        phase: "blocked",
        argument_shapes: ["object"],
        error: true,
      }),
    ]);
    expect(certificate).toEqual([-2]);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /notifications|certificate-private/,
    );
  },
);

it("blocks shell effects, preserves return contracts, and keeps argument values out of evidence", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-shell-");
  await writeElectronFixture(root);
  const selected = join(root, "retained.txt");
  await writeFile(selected, "must remain");
  const script = join(root, "shell.cjs");
  await writeFile(
    script,
    `const { shell } = require("electron");
(async () => {
  const selected = ${JSON.stringify(selected)};
  const revealed = shell.showItemInFolder("/host/secret-folder/file.txt");
  const written = shell.writeShortcutLink("caller-private.lnk", "create", { target: "payload.exe" });
  const calls = [shell.openExternal("https://example.invalid/caller-private"), shell.openPath(selected), shell.trashItem(selected)];
  const settlements = await Promise.allSettled(calls);
  console.log(JSON.stringify({
    revealReturnsVoid: revealed === undefined,
    written,
    promises: calls.map(call => call instanceof Promise),
    settlements: settlements.map(entry => entry.status === "rejected" ? entry.reason.message : entry),
    nativeCalls: globalThis.__nativeShellCalls,
    snapshot: globalThis.__reaElectronActiveSnapshot(),
  }));
})();
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const { snapshot, ...outcomes } = JSON.parse(execution.stdout) as {
    snapshot: { hook_error: boolean; events: unknown };
  } & Record<string, unknown>;
  expect(outcomes).toEqual({
    revealReturnsVoid: true,
    written: false,
    promises: [true, true, true],
    settlements: Array(3).fill("External shell effects are blocked"),
    nativeCalls: [],
  });
  expect(await readFile(selected, "utf8")).toBe("must remain");
  expect(snapshot.hook_error).toBe(false);
  const events = electronActiveTimelineEventSchema
    .array()
    .parse(snapshot.events);
  const attempts = [
    { event: "showItemInFolder", argument_shapes: ["string"] },
    {
      event: "writeShortcutLink",
      argument_shapes: ["string", "string", "object"],
    },
    { event: "openExternal", argument_shapes: ["string"] },
    { event: "openPath", argument_shapes: ["string"] },
    { event: "trashItem", argument_shapes: ["string"] },
  ];
  expect(events.filter(({ kind }) => kind === "shell-attempt")).toEqual(
    attempts.map((attempt) =>
      expect.objectContaining({ ...attempt, phase: "blocked", error: true }),
    ),
  );
  const evidence = JSON.stringify(snapshot);
  for (const value of [
    "secret-folder",
    "caller-private",
    "payload.exe",
    selected,
  ])
    expect(evidence).not.toContain(value);
});

it.each([
  { held: true, refused: false },
  { held: false, refused: true },
])(
  "stops an application handed off by its single-instance lock (held: $held)",
  async ({ held, refused }) => {
    const root = await createTestTempDirectory("rea-electron-hook-lock-");
    await writeElectronFixture(root);
    const script = join(root, "lock.cjs");
    await writeFile(
      script,
      `const { app } = require("electron");
globalThis.__singleInstanceLockHeld = ${String(held)};
setImmediate(async () => {
  const snapshot = globalThis.__reaElectronActiveSnapshot();
  // An already-announced refusal settles first; otherwise false wins.
  const announced = await Promise.race([
    globalThis.__reaElectronSingleInstanceLockRefusal,
    Promise.resolve(false),
  ]);
  process.stdout.write(JSON.stringify({
    refused: snapshot.single_instance_lock_refused,
    announced,
    events: snapshot.events.filter((event) => event.event === "requestSingleInstanceLock"),
  }) + "\\n");
});
const primary = app.requestSingleInstanceLock();
process.stdout.write(JSON.stringify({ application_continued: primary }) + "\\n");
`,
    );
    const execution = await runNode(script, root);
    expect(execution.code, execution.stderr).toBe(0);
    const lines = execution.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    // A refused launch belongs to the running instance: application code
    // after the lock request must not run, and the process stays readable.
    expect(lines).toEqual([
      ...(held ? [{ application_continued: true }] : []),
      {
        refused,
        announced: refused,
        events: refused
          ? [
              expect.objectContaining({
                kind: "app-lifecycle",
                phase: "blocked",
                target: "app",
                error: true,
              }),
            ]
          : [],
      },
    ]);
  },
);

it("classifies a dropped browser preload as preload configuration at capture", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-browser-preload-",
  );
  await writeElectronFixture(root);
  const script = join(root, "browser-preload.cjs");
  await writeFile(
    script,
    `Object.defineProperty(process, "type", { value: "browser" });
const electron = require("electron");
new electron.BrowserWindow({ webPreferences: { preload: "p".repeat(6 * 1024 * 1024) } });
const snapshot = globalThis.__reaElectronActiveSnapshot();
process.stdout.write(JSON.stringify(snapshot) + "\\n");
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const snapshot = JSON.parse(
    execution.stdout.trim().split("\n").at(-1) ?? "null",
  ) as {
    readonly dropped_event_families: readonly {
      readonly family: string;
      readonly count: number;
    }[];
    readonly dropped_event_roles: readonly {
      readonly role: string;
      readonly count: number;
    }[];
  };
  expect(snapshot.dropped_event_families).toContainEqual({
    family: "preload-configuration",
    count: 1,
  });
  expect(snapshot.dropped_event_roles).toContainEqual({
    role: "browser",
    count: 1,
  });
});

it("removes observed ipcMain listeners through their original function", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-ipc-removal-");
  await writeElectronFixture(root);
  const script = join(root, "ipc-removal.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const event = { sender: { id: 9 }, senderFrame: { routingId: 7 } };
let calls = 0;
const listener = () => { calls += 1; };
ipcMain.on("repeated", listener);
ipcMain.on("repeated", listener);
ipcMain.removeListener("repeated", listener);
const repeatedAfterFirstRemoval = ipcMain.listenerCount("repeated");
ipcMain.off("repeated", listener);
ipcMain.once("pending-once", listener);
ipcMain.removeListener("pending-once", listener);
ipcMain.on("fired-once", listener);
ipcMain.once("fired-once", listener);
ipcMain.emit("fired-once", event);
ipcMain.removeListener("fired-once", listener);
ipcMain.emit("repeated", event);
ipcMain.emit("pending-once", event);
ipcMain.emit("fired-once", event);
const snapshot = globalThis.__reaElectronActiveSnapshot();
process.stdout.write(JSON.stringify({
  calls,
  repeated_after_first_removal: repeatedAfterFirstRemoval,
  listeners: ["repeated", "pending-once", "fired-once"].map((channel) => ipcMain.listenerCount(channel)),
  invocations: snapshot.events.filter((item) => item.kind === "main-event-invocation").map((item) => item.channel),
}) + "\\n");
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  expect(JSON.parse(execution.stdout)).toEqual({
    calls: 2,
    repeated_after_first_removal: 1,
    listeners: [0, 0, 0],
    invocations: ["fired-once", "fired-once"],
  });
});

it("removes the newest ipcMain registration across aliases and preserves the remaining callbacks", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-ipc-aliases-");
  await writeElectronFixture(root);
  const script = join(root, "ipc-aliases.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const event = { sender: { id: 9 }, senderFrame: { routingId: 7 } };
const mixed = (channel, customLink) => {
  const order = [];
  const first = () => { order.push("first"); };
  if (customLink) first.listener = () => { order.push("inner"); };
  const middle = () => { order.push("middle"); };
  ipcMain.on(channel, first);
  ipcMain.on(channel, middle);
  ipcMain.addListener(channel, first);
  ipcMain.removeListener(channel, first);
  ipcMain.emit(channel, event);
  return { order, listeners: ipcMain.listenerCount(channel) };
};
const plain = mixed("mixed", false);
const linked = mixed("linked", true);
let onceCalls = 0;
const once = () => { onceCalls += 1; };
ipcMain.once("once-then-add", once);
ipcMain.addListener("once-then-add", once);
ipcMain.removeListener("once-then-add", once);
ipcMain.emit("once-then-add", event);
ipcMain.emit("once-then-add", event);
const snapshot = globalThis.__reaElectronActiveSnapshot();
console.log(JSON.stringify({
  plain, linked,
  once: { calls: onceCalls, listeners: ipcMain.listenerCount("once-then-add") },
  invocations: snapshot.events.filter((item) => item.kind === "main-event-invocation").map((item) => item.channel),
}));
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  expect(JSON.parse(execution.stdout)).toEqual({
    plain: { order: ["first", "middle"], listeners: 2 },
    linked: { order: ["first", "middle"], listeners: 2 },
    once: { calls: 1, listeners: 0 },
    invocations: ["mixed", "mixed", "linked", "linked", "once-then-add"],
  });
});

it("records ipcMain listeners registered by a newListener callback during once", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-ipc-nested-");
  await writeElectronFixture(root);
  const script = join(root, "ipc-nested.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const event = { sender: { id: 9 }, senderFrame: { routingId: 7 } };
let nestedCalls = 0;
ipcMain.addListener("newListener", (channel) => {
  if (channel === "outer") ipcMain.on("nested", () => { nestedCalls += 1; });
});
ipcMain.once("outer", () => undefined);
ipcMain.emit("nested", event);
ipcMain.emit("outer", event);
const snapshot = globalThis.__reaElectronActiveSnapshot();
process.stdout.write(JSON.stringify({
  nested_calls: nestedCalls,
  invocations: snapshot.events.filter((item) => item.kind === "main-event-invocation").map((item) => item.channel),
}) + "\\n");
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  expect(JSON.parse(execution.stdout)).toEqual({
    nested_calls: 1,
    invocations: ["nested", "outer"],
  });
});

it("keeps removal working after many fired ipcMain once registrations", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-ipc-repeat-");
  await writeElectronFixture(root);
  const script = join(root, "ipc-repeat.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const event = { sender: { id: 9 }, senderFrame: { routingId: 7 } };
let calls = 0;
const listener = () => { calls += 1; };
for (let index = 0; index < 200; index += 1) {
  ipcMain.once("repeated-once", listener);
  ipcMain.emit("repeated-once", event);
}
const afterOnce = ipcMain.rawListeners("repeated-once").length;
ipcMain.on("repeated-once", listener);
ipcMain.removeListener("repeated-once", listener);
ipcMain.emit("repeated-once", event);
process.stdout.write(JSON.stringify({
  calls,
  after_once: afterOnce,
  listeners: ipcMain.listenerCount("repeated-once"),
}) + "\\n");
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  expect(JSON.parse(execution.stdout)).toEqual({
    calls: 200,
    after_once: 0,
    listeners: 0,
  });
});

it("reports original ipcMain listeners to newListener and removeListener observers", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-ipc-meta-");
  await writeElectronFixture(root);
  const script = join(root, "ipc-meta.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const event = { sender: { id: 9 }, senderFrame: { routingId: 7 } };
const channels = new Set(["on", "removed-once", "fired-once"]);
const added = [];
const removed = [];
ipcMain.addListener("newListener", (channel, listener) => { if (channels.has(channel)) added.push([channel, listener]); });
ipcMain.addListener("removeListener", (channel, listener) => { if (channels.has(channel)) removed.push([channel, listener]); });
const onListener = () => undefined;
const removedOnce = () => undefined;
let firedCalls = 0;
const firedOnce = () => { firedCalls += 1; };
ipcMain.on("on", onListener);
ipcMain.removeListener("on", onListener);
ipcMain.once("removed-once", removedOnce);
ipcMain.removeListener("removed-once", removedOnce);
ipcMain.once("fired-once", firedOnce);
ipcMain.emit("fired-once", event);
ipcMain.emit("fired-once", event);
const expected = [["on", onListener], ["removed-once", removedOnce], ["fired-once", firedOnce]];
const same = (actual) => actual.length === expected.length &&
  actual.every(([channel, listener], index) => channel === expected[index][0] && listener === expected[index][1]);
const snapshot = globalThis.__reaElectronActiveSnapshot();
process.stdout.write(JSON.stringify({
  added_originals: same(added),
  removed_originals: same(removed),
  fired_calls: firedCalls,
  invocations: snapshot.events.filter((item) => item.kind === "main-event-invocation").map((item) => item.channel),
}) + "\\n");
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  expect(JSON.parse(execution.stdout)).toEqual({
    added_originals: true,
    removed_originals: true,
    fired_calls: 1,
    invocations: ["fired-once"],
  });
});

it("registers and removes ipcMain once listeners through decorators installed after the hook", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-ipc-decor-");
  await writeElectronFixture(root);
  const script = join(root, "ipc-decorators.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const event = { sender: { id: 9 }, senderFrame: { routingId: 7 } };
const seen = [];
const hookedOn = ipcMain.on;
const hookedRemoveListener = ipcMain.removeListener;
ipcMain.on = function decoratedOn(channel, listener) {
  if (channel === "decorated") seen.push("on");
  return hookedOn.call(this, channel, listener);
};
ipcMain.removeListener = function decoratedRemoveListener(channel, listener) {
  if (channel === "decorated") seen.push("removeListener");
  return hookedRemoveListener.call(this, channel, listener);
};
let calls = 0;
const listener = () => { calls += 1; };
const returned = ipcMain.once("decorated", listener);
const registered = ipcMain.listenerCount("decorated", listener);
ipcMain.emit("decorated", event);
ipcMain.emit("decorated", event);
const snapshot = globalThis.__reaElectronActiveSnapshot();
process.stdout.write(JSON.stringify({
  seen,
  returns_emitter: returned === ipcMain,
  registered,
  remaining: ipcMain.listenerCount("decorated"),
  calls,
  invocations: snapshot.events.filter((item) => item.kind === "main-event-invocation").map((item) => item.channel),
}) + "\\n");
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  expect(JSON.parse(execution.stdout)).toEqual({
    seen: ["on", "removeListener"],
    returns_emitter: true,
    registered: 1,
    remaining: 0,
    calls: 1,
    invocations: ["decorated"],
  });
});

it("keeps hooked ipcMain listener semantics identical to an unhooked EventEmitter", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-ipc-diff-");
  await writeElectronFixture(root);
  const script = join(root, "ipc-differential.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const { EventEmitter } = require("node:events");
const event = { sender: { id: 9 }, senderFrame: { routingId: 7 } };
const scenario = (emitter) => {
  const log = [];
  const names = new Map();
  const named = (name) => {
    const listener = () => { log.push("call:" + name); };
    names.set(listener, name);
    return listener;
  };
  const label = (listener) => names.get(listener) ?? "unknown";
  emitter.on("newListener", (channel, listener) => {
    if (channel === "ch") log.push("new:" + label(listener));
  });
  emitter.on("removeListener", (channel, listener) => {
    if (channel === "ch") log.push("remove:" + label(listener));
  });
  const [a, b, c, d] = ["a", "b", "c", "d"].map(named);
  const state = () => {
    log.push("count:" + emitter.listenerCount("ch") + ":" + [a, b, c, d].map((listener) => emitter.listenerCount("ch", listener)).join(","));
    log.push("listeners:" + emitter.listeners("ch").map(label).join(","));
    log.push("raw:" + emitter.rawListeners("ch").map((listener) => label(listener.listener ?? listener)).join(","));
  };
  emitter.on("ch", a);
  emitter.once("ch", b);
  emitter.on("ch", c);
  emitter.addListener("ch", a);
  emitter.once("ch", d);
  emitter.prependListener("ch", c);
  emitter.prependOnceListener("ch", d);
  state();
  emitter.removeListener("ch", a);
  state();
  emitter.emit("ch", event);
  state();
  emitter.off("ch", c);
  emitter.once("ch", b);
  emitter.removeListener("ch", b);
  emitter.once("ch", d);
  state();
  emitter.emit("ch", event);
  state();
  emitter.off("ch", c);
  // An app function's own listener property is not a hook wrapper.
  const e = named("e");
  e.listener = c;
  emitter.on("ch", a);
  emitter.on("ch", c);
  emitter.prependOnceListener("ch", d);
  emitter.prependListener("ch", e);
  emitter.on("ch", a);
  state();
  emitter.removeAllListeners("ch");
  state();
  emitter.on("ch", b);
  emitter.on("ch", c);
  emitter.removeAllListeners();
  state();
  return log;
};
process.stdout.write(JSON.stringify({
  plain: scenario(new EventEmitter()),
  hooked: scenario(ipcMain),
}) + "\\n");
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const { plain, hooked } = JSON.parse(execution.stdout) as {
    plain: string[];
    hooked: string[];
  };
  expect(plain).not.toContain("new:unknown");
  expect(hooked).toEqual(plain);
});

it("keeps native bulk traversal when removal observers append or prepend listeners", async () => {
  const result = await runIpcHookFixture(`const scenario = (emitter, mode) => {
  const events = [];
  const names = new Map();
  const named = (name) => {
    const listener = () => { events.push("call:" + name); };
    names.set(listener, name);
    return listener;
  };
  const label = (listener) =>
    names.get(listener) ??
    (names.has(listener.listener) ? "wrapper(" + names.get(listener.listener) + ")" : "unknown");
  const [a, b, c, replacement] = ["a", "b", "c", "replacement"].map(named);
  let inserted = false;
  emitter.on("removeListener", (channel, listener) => {
    if (channel !== mode) return;
    events.push("remove:" + label(listener));
    if (inserted) return;
    inserted = true;
    emitter[mode === "append" ? "on" : "prependListener"](mode, replacement);
  });
  emitter.on(mode, a);
  emitter[mode === "append" ? "once" : "on"](mode, b);
  emitter.on(mode, c);
  events.push("returns_emitter:" + (emitter.removeAllListeners(mode) === emitter));
  events.push("listeners:" + emitter.listeners(mode).map(label).join(","));
  emitter.emit(mode, { sender: { id: 9 }, senderFrame: { routingId: 7 } });
  emitter.removeAllListeners();
  events.push("cleared:" + emitter.listenerCount(mode) + ":" + emitter.listenerCount("removeListener"));
  return events;
};
const rows = ["append", "prepend"].map(mode => ({
  mode, plain: scenario(new EventEmitter(), mode), hooked: scenario(ipcMain, mode),
}));
const snapshot = globalThis.__reaElectronActiveSnapshot();
console.log(JSON.stringify({ rows,
  invocations: snapshot.events.filter(event =>
    event.kind === "main-event-invocation" && event.channel !== "removeListener"
  ).map(event => event.channel),
}));
`);
  const { rows, invocations } = result as {
    rows: { mode: string; plain: string[]; hooked: string[] }[];
    invocations: string[];
  };
  expect(rows.map(({ mode }) => mode)).toEqual(["append", "prepend"]);
  for (const { mode, plain, hooked } of rows) {
    expect(hooked, mode).toEqual(plain);
    expect(plain[0], mode).toBe("remove:c");
    expect(plain.at(-1), mode).toBe("cleared:0:0");
  }
  expect(rows[0]?.plain).toEqual([
    "remove:c",
    "remove:wrapper(b)",
    "remove:a",
    "returns_emitter:true",
    "listeners:replacement",
    "call:replacement",
    "remove:replacement",
    "cleared:0:0",
  ]);
  expect(invocations).toEqual(["append", "prepend"]);
});

it("does not infer hook dispatch from an application's listener metadata", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-indirect-owner-",
  );
  await writeElectronFixture(root);
  const script = join(root, "indirect-owner.cjs");
  await writeFile(
    script,
    `const {ipcMain}=require("electron");
ipcMain.on("seed",()=>{});
let calls=0;
const outer=()=>{calls++;};
outer.listener=ipcMain.rawListeners("seed")[0];
ipcMain.on("outer",outer);
ipcMain.emit("outer", {sender:{id:9}});
ipcMain.removeListener("outer",outer);
const events=globalThis.__reaElectronActiveSnapshot().events;
process.stdout.write(JSON.stringify({calls,remaining:ipcMain.listenerCount("outer"),
 invocations:events.filter(e=>e.kind==="main-event-invocation"&&e.channel==="outer").length,
 gaps:events.filter(e=>e.kind==="ipc-observation-gap"&&e.channel==="outer").map(e=>e.event)}));`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  expect(JSON.parse(execution.stdout)).toEqual({
    calls: 1,
    remaining: 0,
    invocations: 0,
    gaps: ["listener-chain"],
  });
});

it("keeps ipcMain once self-removal through an on decorator that wraps the hook", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-ipc-wrap-");
  await writeElectronFixture(root);
  const script = join(root, "ipc-wrapping-decorator.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const { EventEmitter } = require("node:events");
const event = { sender: { id: 9 }, senderFrame: { routingId: 7 } };
// Installed after the hook: wraps each listener and names it via .listener.
const decorate = (emitter) => {
  const decoratedOn = emitter.on;
  emitter.on = function wrappingOn(channel, listener) {
    const layer = function decoratedListener(...args) {
      return listener.apply(this, args);
    };
    layer.listener = listener;
    return decoratedOn.call(this, channel, layer);
  };
};
const scenario = (emitter) => {
  decorate(emitter);
  let calls = 0;
  const listener = () => { calls += 1; };
  const returned = emitter.once("decorated", listener);
  const registered = emitter.listenerCount("decorated");
  emitter.emit("decorated", event);
  const afterFirst = emitter.listenerCount("decorated");
  emitter.emit("decorated", event);
  emitter.once("decorated", listener);
  emitter.emit("decorated", event);
  return {
    returns_emitter: returned === emitter,
    registered,
    after_first: afterFirst,
    remaining: emitter.listenerCount("decorated"),
    raw: emitter.rawListeners("decorated").length,
    calls,
  };
};
const plain = scenario(new EventEmitter());
const hooked = scenario(ipcMain);
const snapshot = globalThis.__reaElectronActiveSnapshot();
process.stdout.write(JSON.stringify({
  plain,
  hooked,
  invocations: snapshot.events.filter((item) => item.kind === "main-event-invocation").map((item) => item.channel),
}) + "\\n");
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const { plain, hooked, invocations } = JSON.parse(execution.stdout) as {
    plain: Record<string, unknown>;
    hooked: Record<string, unknown>;
    invocations: string[];
  };
  expect(plain).toEqual({
    returns_emitter: true,
    registered: 1,
    after_first: 0,
    remaining: 0,
    raw: 0,
    calls: 2,
  });
  expect(hooked).toEqual(plain);
  expect(invocations).toEqual(["decorated", "decorated"]);
});

it("preserves native bulk removal through application decorators", async () => {
  // The readonly registration is irreversible within this child.
  const modes = ["stable", "replaced", "getter", "proxy", "readonly"];
  const result = await runIpcHookFixture(`const scenario = (emitter, mode) => {
  const seen = [];
  const onListener = () => undefined;
  const onceListener = () => undefined;
  const prior = Object.getOwnPropertyDescriptor(emitter, "removeListener");
  const nativeRemove = emitter.removeListener;
  const decorate = (name) => function removalDecorator(channel, listener) {
    if (this !== emitter) throw new Error("decorator receiver changed");
    if (channel === mode) {
      const label = listener === onListener ? "on" :
        listener.listener === onceListener ? "once" : "unknown";
      seen.push(name + ":" + label);
      if (label === "unknown") throw new Error("unexpected recording wrapper");
    }
    return nativeRemove.call(this, channel, listener);
  };
  const observeRemoval = (channel) => {
    if (mode === "replaced" && channel === mode)
      emitter.removeListener = decorate("replacement");
  };
  emitter.on("removeListener", observeRemoval);
  emitter.on(mode, onListener);
  emitter.once(mode, onceListener);
  emitter.removeListener = decorate("first");
  if (mode === "readonly") Object.defineProperty(emitter, "removeListener", {
    value: emitter.removeListener, writable: false, configurable: false,
  });
  if (mode === "getter") Object.defineProperty(emitter, "removeListener", {
    configurable: true,
    get() {
      if (this !== emitter) throw new Error("getter receiver changed");
      return decorate("first");
    },
  });
  if (mode === "proxy") emitter.removeListener = new Proxy(emitter.removeListener, {
    get() { throw new Error("decorator metadata must not be read"); },
  });
  let failure = null, returnsEmitter = false;
  try { returnsEmitter = emitter.removeAllListeners(mode) === emitter; }
  catch (cause) { failure = cause.message; }
  finally {
    if (mode !== "readonly") {
      if (prior) Object.defineProperty(emitter, "removeListener", prior);
      else delete emitter.removeListener;
    }
    nativeRemove.call(emitter, "removeListener", observeRemoval);
  }
  return { seen, returnsEmitter, remaining: emitter.listenerCount(mode), failure };
};
console.log(JSON.stringify(${JSON.stringify(modes)}.map(mode => ({
  mode, plain: scenario(new EventEmitter(), mode), hooked: scenario(ipcMain, mode),
}))));
`);
  const rows = result as {
    mode: string;
    plain: Record<string, unknown>;
    hooked: Record<string, unknown>;
  }[];
  expect(rows.map(({ mode }) => mode)).toEqual(modes);
  for (const { mode, plain, hooked } of rows) {
    expect(plain, mode).toEqual({
      seen: ["first:once", mode === "replaced" ? "replacement:on" : "first:on"],
      returnsEmitter: true,
      remaining: 0,
      failure: null,
    });
    expect(hooked, mode).toEqual(plain);
  }
});

it("matches native once dispatch and retains only established invocations", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-native-once-");
  await writeElectronFixture(root);
  const script = join(root, "electron-once-runtime.mjs");
  await copyFile(
    fileURLToPath(
      new URL(
        "../../../tests/support/analysis-efficiency/electron-once-runtime.mjs",
        import.meta.url,
      ),
    ),
    script,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const result = JSON.parse(execution.stdout) as {
    cases: number;
    disagreements: number;
    rows: readonly {
      mode: string;
      native: Record<string, unknown>;
      hooked: Record<string, unknown> & { body_calls: number };
      observation: readonly { kind: string; event: string | null }[];
    }[];
  };
  expect(result.cases).toBe(39);
  expect(result.disagreements).toBe(0);
  for (const row of result.rows) {
    expect(row.hooked, row.mode).toEqual(row.native);
    const invocations = row.observation.filter(
      (event) => event.kind === "main-event-invocation",
    );
    if (
      row.mode === "inherited-listener-setter" ||
      row.mode === "on-getter-listener-setter" ||
      row.mode.startsWith("on-getter-native-alias")
    ) {
      expect(invocations).toEqual([]);
      expect(row.observation).toEqual([
        {
          kind: "ipc-observation-gap",
          event: "once-metadata",
          error: row.mode === "on-getter-native-alias-throws",
        },
      ]);
    } else {
      expect(invocations.length, row.mode).toBe(row.hooked.body_calls);
      if (row.hooked.body_calls === 0)
        expect(
          row.observation.some((event) => event.kind === "ipc-observation-gap"),
          row.mode,
        ).toBe(true);
      if (row.mode.includes("non-callable") && row.hooked.body_calls === 0)
        expect(row.observation, row.mode).toEqual([
          expect.objectContaining({
            kind: "ipc-observation-gap",
            error: true,
          }),
        ]);
    }
  }
});

const runIpcHookFixture = async (scenario: string): Promise<unknown> => {
  const root = await createTestTempDirectory("rea-electron-hook-ipc-dispatch-");
  await writeElectronFixture(root);
  const script = join(root, "ipc-dispatch.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const { EventEmitter } = require("node:events");
${scenario}`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  return JSON.parse(execution.stdout);
};

it("preserves native callable method reads for on and once dispatch", async () => {
  const modes = ["single-on", "multiple-on", "empty-once", "event-once"];
  const result = await runIpcHookFixture(`const scenario = (emitter, mode) => {
  const calls = [];
  const reads = [];
  const listener = new Proxy(function() { calls.push("first"); }, {
    get(target, key, receiver) {
      if (key === "apply" || key === "call") {
        reads.push(key);
        throw new Error("application invocation metadata");
      }
      return Reflect.get(target, key, receiver);
    },
  });
  if (mode.endsWith("once")) emitter.once(mode, listener);
  else emitter.on(mode, listener);
  if (mode === "multiple-on") emitter.on(mode, () => calls.push("second"));
  let failure = null;
  try {
    if (mode === "empty-once") emitter.emit(mode);
    else emitter.emit(mode, { sender: { id: 9 } });
  } catch (cause) { failure = cause.message; }
  return { calls, reads, failure, remaining: emitter.listenerCount(mode) };
};
console.log(JSON.stringify(${JSON.stringify(modes)}.map(mode => ({
  mode, plain: scenario(new EventEmitter(), mode), hooked: scenario(ipcMain, mode),
}))));
`);
  const rows = result as {
    mode: string;
    plain: Record<string, unknown>;
    hooked: Record<string, unknown>;
  }[];
  expect(rows.map(({ mode }) => mode)).toEqual(modes);
  // Node owns whether it consults call/apply. Compare the whole trace.
  for (const { mode, plain, hooked } of rows) {
    expect(plain.remaining, mode).toBe(
      mode === "multiple-on" ? 2 : mode === "single-on" ? 1 : 0,
    );
    expect(hooked, mode).toEqual(plain);
  }
});

it("preserves native raw callback apply semantics across argument-list types", async () => {
  const modes = [
    "arguments",
    "array-like",
    "null",
    "undefined",
    "missing",
    "primitive",
  ];
  const result = await runIpcHookFixture(`const scenario = (emitter, mode) => {
  let calls = 0, reads = 0, correctReceiver = false, arity = null;
  const event = { sender: { id: 9 } };
  let first = null;
  emitter.on(mode, function(...args) {
    calls++; correctReceiver = this === emitter; arity = args.length;
    first = args.length ? args[0] === event : null;
  });
  const listener = emitter.rawListeners(mode)[0];
  let list;
  if (mode === "arguments") list = (function() { return arguments; })(event, 42);
  if (mode === "array-like") list = { length: 2, get 0() { reads++; return event; }, 1: 42 };
  if (mode === "null") list = null;
  if (mode === "primitive") list = 42;
  let typeError = false;
  try {
    if (mode === "missing") listener.apply(emitter);
    else listener.apply(emitter, list);
  } catch (cause) { typeError = cause instanceof TypeError; }
  return { calls, reads, correctReceiver, arity, first, typeError };
};
console.log(JSON.stringify(${JSON.stringify(modes)}.map(mode => ({
  mode, plain: scenario(new EventEmitter(), mode), hooked: scenario(ipcMain, mode),
}))));
`);
  const rows = result as {
    mode: string;
    plain: Record<string, unknown>;
    hooked: Record<string, unknown>;
  }[];
  expect(rows.map(({ mode }) => mode)).toEqual(modes);
  for (const { mode, plain, hooked } of rows) {
    const populated = mode === "arguments" || mode === "array-like";
    expect(plain, mode).toEqual({
      calls: mode === "primitive" ? 0 : 1,
      reads: mode === "array-like" ? 1 : 0,
      correctReceiver: mode !== "primitive",
      arity: mode === "primitive" ? null : populated ? 2 : 0,
      first: populated ? true : null,
      typeError: mode === "primitive",
    });
    expect(hooked, mode).toEqual(plain);
  }
});

it("preserves the native once argument-list object passed to custom apply", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-ipc-once-args-",
  );
  await writeElectronFixture(root);
  const script = join(root, "ipc-once-arguments.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const { EventEmitter } = require("node:events");
const scenario = (emitter) => {
  const event = { sender: { id: 9 } };
  let calls = 0, argumentObject = false, correctReceiver = false;
  const listener = function(value) { calls++; correctReceiver = this === emitter && value === event; };
  listener.apply = function(receiver, list) {
    argumentObject = Object.prototype.toString.call(list) === "[object Arguments]";
    if (!argumentObject) throw new Error("once changed argument-list identity");
    return Reflect.apply(Function.prototype.apply, this, [receiver, list]);
  };
  emitter.once("ch", listener);
  let failure = null;
  try { emitter.emit("ch", event); } catch (cause) { failure = cause.message; }
  return { calls, argumentObject, correctReceiver, failure, remaining: emitter.listenerCount("ch") };
};
console.log(JSON.stringify({ plain: scenario(new EventEmitter()), hooked: scenario(ipcMain) }));
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const { plain, hooked } = JSON.parse(execution.stdout) as {
    plain: Record<string, unknown>;
    hooked: Record<string, unknown>;
  };
  expect(plain).toEqual({
    calls: 1,
    // Newer runtimes bypass custom apply entirely. If native calls it, the
    // callback's guard still requires its exact Arguments representation.
    argumentObject: expect.any(Boolean),
    correctReceiver: true,
    failure: null,
    remaining: 0,
  });
  expect(hooked).toEqual(plain);
});

it.each([
  "function-setter",
  "function-readonly",
  "object-setter",
  "object-readonly",
])("owns on-wrapper metadata despite inherited %s properties", async (mode) => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-ipc-prototype-",
  );
  await writeElectronFixture(root);
  const script = join(root, "ipc-inherited-listener.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const { EventEmitter } = require("node:events");
const mode = ${JSON.stringify(mode)};
const scenario = (emitter) => {
  const prototype = mode.startsWith("function") ? Function.prototype : Object.prototype;
  const prior = Object.getOwnPropertyDescriptor(prototype, "listener");
  let calls = 0, writes = 0, failure = null;
  Object.defineProperty(prototype, "listener", mode.endsWith("setter") ? {
    configurable: true, set() { writes++; throw new Error("inherited metadata write"); },
  } : { configurable: true, writable: false, value: undefined });
  try {
    emitter.on("ch", () => { calls++; });
    emitter.emit("ch", { sender: { id: 9 } });
  } catch (cause) { failure = cause.message; }
  finally {
    if (prior) Object.defineProperty(prototype, "listener", prior);
    else delete prototype.listener;
  }
  return { calls, writes, failure, remaining: emitter.listenerCount("ch") };
};
console.log(JSON.stringify({ plain: scenario(new EventEmitter()), hooked: scenario(ipcMain) }));
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const { plain, hooked } = JSON.parse(execution.stdout) as {
    plain: Record<string, unknown>;
    hooked: Record<string, unknown>;
  };
  expect(plain).toEqual({ calls: 1, writes: 0, failure: null, remaining: 1 });
  expect(hooked).toEqual(plain);
});

it("records on and once invocations without consulting application Array species", async () => {
  const kinds = ["on", "multiple-on", "once"];
  const result = await runIpcHookFixture(`const countInvocations = (kind) => {
  let count = 0;
  for (const event of globalThis.__reaElectronActiveSnapshot().events)
    if (event.kind === "main-event-invocation" && event.channel === kind) count++;
  return count;
};
const scenario = (emitter, kind) => {
  let calls = 0, reads = 0, failure = null, retainedUnderSpecies;
  emitter[kind === "once" ? "once" : "on"](kind, () => { calls++; });
  if (kind === "multiple-on") emitter.on(kind, () => { calls++; });
  const prior = Object.getOwnPropertyDescriptor(Array, Symbol.species);
  Object.defineProperty(Array, Symbol.species, { configurable: true, get() {
    reads++; throw new Error("application array species");
  }});
  try {
    emitter.emit(kind, { sender: { id: 9 } }, 42);
    if (emitter === ipcMain) retainedUnderSpecies = countInvocations(kind);
  }
  catch (cause) { failure = cause.message; }
  finally { Object.defineProperty(Array, Symbol.species, prior); }
  return { calls, reads, failure, retainedUnderSpecies };
};
console.log(JSON.stringify(${JSON.stringify(kinds)}.map(kind => ({
  kind, plain: scenario(new EventEmitter(), kind), hooked: scenario(ipcMain, kind),
  invocations: countInvocations(kind),
}))));
`);
  const rows = result as {
    kind: string;
    plain: Record<string, unknown>;
    hooked: Record<string, unknown>;
    invocations: number;
  }[];
  expect(rows.map(({ kind }) => kind)).toEqual(kinds);
  for (const { kind, plain, hooked, invocations } of rows) {
    const expected = kind === "multiple-on" ? 2 : 1;
    expect(plain, kind).toEqual({ calls: expected, reads: 0, failure: null });
    expect(hooked, kind).toEqual({ ...plain, retainedUnderSpecies: expected });
    expect(invocations, kind).toBe(expected);
  }
});

it("preserves opaque custom apply inputs and records gaps without claiming dispatch", async () => {
  const modes = ["array", "arguments", "array-like", "null"];
  const result = await runIpcHookFixture(`const scenario = (emitter, mode) => {
  let calls = 0, reads = 0, exact = false, methodThis = false, arity = null;
  const token = {};
  const listener = function(...args) { calls++; arity = args.length; return token; };
  let list = [42, 43];
  if (mode === "arguments") list = (function() { return arguments; })(42, 43);
  if (mode === "array-like") list = { length: 2, get 0() { reads++; return 42; }, 1: 43 };
  if (mode === "null") list = null;
  listener.apply = function(receiver, input) {
    exact = input === list;
    methodThis = this === listener;
    if (!exact) throw new Error("custom apply input was replaced");
    return Reflect.apply(listener, receiver, input ?? []);
  };
  emitter.on(mode, listener);
  let returned = false, failure = null;
  try { returned = emitter.rawListeners(mode)[0].apply(emitter, list) === token; }
  catch (cause) { failure = cause.message; }
  return { calls, reads, exact, methodThis, arity, returned, failure };
};
const rows = ${JSON.stringify(modes)}.map(mode => ({
  mode, plain: scenario(new EventEmitter(), mode), hooked: scenario(ipcMain, mode),
}));
const snapshot = globalThis.__reaElectronActiveSnapshot();
console.log(JSON.stringify({ rows,
  invocations: snapshot.events.filter(e => e.kind === "main-event-invocation").length,
  gaps: snapshot.events.filter(e => e.kind === "ipc-observation-gap").map(e => ({channel: e.channel, event: e.event})) }));
`);
  const { rows, invocations, gaps } = result as {
    rows: {
      mode: string;
      plain: Record<string, unknown>;
      hooked: Record<string, unknown>;
    }[];
    invocations: number;
    gaps: unknown[];
  };
  expect(rows.map(({ mode }) => mode)).toEqual(modes);
  for (const { mode, plain, hooked } of rows) {
    expect(plain, mode).toEqual({
      calls: 1,
      reads: mode === "array-like" ? 1 : 0,
      exact: true,
      methodThis: true,
      arity: mode === "null" ? 0 : 2,
      returned: true,
      failure: null,
    });
    expect(hooked, mode).toEqual(plain);
  }
  expect(invocations).toBe(0);
  expect(gaps).toEqual(
    modes.map((channel) => ({ channel, event: "custom-apply" })),
  );
});

it("preserves borrowed intrinsic and custom raw apply receivers", async () => {
  const result =
    await runIpcHookFixture(`const scenario = (emitter, custom) => {
  let originalCalls = 0, borrowedCalls = 0, sameList = false;
  const token = {}, list = [42, 43];
  const channel = custom ? "custom" : "intrinsic";
  const listener = function() { originalCalls++; };
  const other = function(...args) { borrowedCalls++; return args[0] === 42 && args[1] === 43 ? token : null; };
  if (custom) listener.apply = function(receiver, input) {
    sameList = input === list;
    return Reflect.apply(this, receiver, input);
  };
  emitter.on(channel, listener);
  const returned = emitter.rawListeners(channel)[0].apply.call(other, emitter, list) === token;
  return { originalCalls, borrowedCalls, sameList, returned };
};
const rows = [false, true].map(custom => ({
  custom, plain: scenario(new EventEmitter(), custom), hooked: scenario(ipcMain, custom),
}));
const snapshot = globalThis.__reaElectronActiveSnapshot();
console.log(JSON.stringify({ rows,
  invocations: snapshot.events.filter(e => e.kind === "main-event-invocation").length }));
`);
  const { rows, invocations } = result as {
    rows: {
      custom: boolean;
      plain: Record<string, unknown>;
      hooked: Record<string, unknown>;
    }[];
    invocations: number;
  };
  expect(rows.map(({ custom }) => custom)).toEqual([false, true]);
  for (const { custom, plain, hooked } of rows) {
    expect(plain).toEqual({
      originalCalls: 0,
      borrowedCalls: 1,
      sameList: custom,
      returned: true,
    });
    expect(hooked).toEqual(plain);
  }
  expect(invocations).toBe(0);
});

it("uses the captured Array.isArray intrinsic while selecting a native listener entry", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-captured-array-is-array-",
  );
  await writeElectronFixture(root);
  const script = join(root, "captured-array-is-array.cjs");
  await writeFile(
    script,
    `const { EventEmitter } = require("node:events");
const { ipcMain } = require("electron");
const scenario = (emitter) => {
  const listener = function original() {};
  const marker = function marker() {};
  const foreign = function foreign() {};
  emitter.on("ch", listener);
  emitter.on("ch", marker);
  emitter.rawListeners("ch")[0].listener = foreign;
  const originalIsArray = Array.isArray;
  let failure = null;
  Array.isArray = () => { throw new Error("late application Array.isArray"); };
  try { emitter.removeListener("ch", listener); }
  catch (cause) { failure = cause.message; }
  finally { Array.isArray = originalIsArray; }
  return { failure, remaining: emitter.listenerCount("ch"), eventNames: emitter.eventNames() };
};
console.log(JSON.stringify({ plain: scenario(new EventEmitter()), hooked: scenario(ipcMain),
  hook_error: globalThis.__reaElectronActiveSnapshot().hook_error }));
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const result = JSON.parse(execution.stdout);
  expect(result.hook_error).toBe(false);
  expect(result.hooked).toEqual(result.plain);
  expect(result.plain).toEqual({
    failure: null,
    remaining: 1,
    eventNames: ["ch"],
  });
});

it("keeps listener registration and removal independent of late intrinsic replacement", async () => {
  const intrinsics = [
    "defineProperty",
    "getOwnPropertyDescriptor",
    "getPrototypeOf",
    "get",
    "set",
    "Set",
    "Proxy",
    "WeakMap.has",
    "WeakMap.get",
    "WeakMap.set",
    "Set.has",
    "Set.add",
  ];
  const root = await createTestTempDirectory(
    "rea-electron-hook-late-intrinsic-",
  );
  await writeElectronFixture(root);
  const script = join(root, "ipc-late-intrinsic.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const { EventEmitter } = require("node:events");
const row = (specification) => {
  const [constructor, member] = specification.split(".");
  const method = member ?? specification;
  const owner = member !== undefined ? globalThis[constructor].prototype
    : method === "Set" || method === "Proxy" ? globalThis
    : method === "get" || method === "set" ? Reflect : Object;
  const original = owner[method];
  const onChannel = specification + ":on", onceChannel = specification + ":once";
  const scenario = (target) => {
    const seen = [];
    let failure = null;
    try {
      const onListener = () => seen.push("on");
      target.on(onChannel, onListener);
      target.once(onceChannel, () => seen.push("once"));
      target.on("removeListener", () => {});
      target.emit(onChannel, null, 42);
      target.emit(onceChannel, null, 43);
      target.emit(onceChannel, null, 44);
      target.removeAllListeners();
    } catch (cause) { failure = cause.message; }
    return { seen, failure, remaining: target.eventNames().length };
  };
  const emitter = new EventEmitter();
  const replacement = function() { throw new Error("late application intrinsic replacement"); };
  owner[method] = replacement;
  let plain, hooked;
  try {
    if (owner[method] !== replacement) throw new Error("fixture did not replace " + specification);
    plain = scenario(emitter);
    hooked = scenario(ipcMain);
  }
  finally { owner[method] = original; }
  const snapshot = globalThis.__reaElectronActiveSnapshot();
  return { specification, plain, hooked,
    invocations: snapshot.events.filter(e => e.kind === "main-event-invocation" && (e.channel === onChannel || e.channel === onceChannel)).length };
};
console.log(JSON.stringify(${JSON.stringify(intrinsics)}.map(row)));
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const rows = JSON.parse(execution.stdout) as {
    specification: string;
    plain: Record<string, unknown>;
    hooked: Record<string, unknown>;
    invocations: number;
  }[];
  expect(rows.map(({ specification }) => specification)).toEqual(intrinsics);
  for (const { specification, plain, hooked, invocations } of rows) {
    expect(plain, specification).toEqual({
      seen: ["on", "once"],
      failure: null,
      remaining: 0,
    });
    expect(hooked, specification).toEqual(plain);
    expect(invocations, specification).toBe(2);
  }
});

it("preserves native dispatch across bounded listener and prototype chains", async () => {
  const cases = [
    { mode: "data", depth: 16, remaining: 1 },
    { mode: "data", depth: 17, remaining: 1 },
    { mode: "accessor" },
    { mode: "proxy" },
    { mode: "data", depth: 17, once: false, remaining: 1 },
    { mode: "inherited-data", prototypeDepth: 1 },
    { mode: "inherited-accessor", prototypeDepth: 1 },
    { mode: "inherited-proxy", prototypeDepth: 1 },
    { mode: "inherited-data", prototypeDepth: 16 },
    { mode: "inherited-data", prototypeDepth: 17 },
  ].map((entry) => ({
    depth: 1,
    prototypeDepth: 0,
    once: true,
    remaining: 0,
    ...entry,
  }));
  const root = await createTestTempDirectory(
    "rea-electron-hook-chain-coverage-",
  );
  await writeElectronFixture(root);
  const script = join(root, "ipc-chain-coverage.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const { EventEmitter } = require("node:events");
const scenario = (target, channel, { mode, once, depth, prototypeDepth }) => {
  const prior = Object.getOwnPropertyDescriptor(target, "on");
  let calls = 0, reads = 0;
  try {
    for (let index = 0; index < depth; index++) {
      const previous = target.on;
      target.on = function(channel, listener) {
        let outer = function(...args) { return Reflect.apply(listener, this, args); };
        if (mode.startsWith("inherited-")) {
          let prototype = Object.create(Function.prototype);
          Object.defineProperty(prototype, "listener", mode === "inherited-accessor"
            ? { get() { reads++; return listener; } } : { value: listener });
          if (mode === "inherited-proxy") prototype = new Proxy(prototype, {
            getOwnPropertyDescriptor() { throw new Error("prototype metadata reflection"); },
            getPrototypeOf() { throw new Error("prototype traversal reflection"); }
          });
          for (let index = 1; index < prototypeDepth; index++) prototype = Object.create(prototype);
          Object.setPrototypeOf(outer, prototype);
        }
        else if (mode === "accessor") Object.defineProperty(outer, "listener", { get() { reads++; return listener; } });
        else outer.listener = listener;
        if (mode === "proxy") outer = new Proxy(outer, {
          getOwnPropertyDescriptor() { throw new Error("application metadata reflection"); }
        });
        return Reflect.apply(previous, this, [channel, outer]);
      };
    }
    target[once ? "once" : "on"](channel, () => calls++);
    target.emit(channel, null, 42); target.emit(channel, null, 43);
    return { calls, reads, remaining: target.listenerCount(channel) };
  } finally {
    if (prior) Object.defineProperty(target, "on", prior);
    else delete target.on;
  }
};
const rows = ${JSON.stringify(cases)}.map((entry, index) => {
  const channel = "chain-" + index;
  const priorCount = globalThis.__reaElectronActiveSnapshot().events.length;
  const plain = scenario(new EventEmitter(), channel, entry);
  const hooked = scenario(ipcMain, channel, entry);
  const events = globalThis.__reaElectronActiveSnapshot().events.slice(priorCount);
  return { plain, hooked, channel,
    invocations: events.filter(e => e.kind === "main-event-invocation").length,
    gaps: events.filter(e => e.kind === "ipc-observation-gap").map(e => ({event: e.event, channel: e.channel})) };
});
console.log(JSON.stringify(rows));
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const rows = JSON.parse(execution.stdout) as {
    channel: string;
    plain: Record<string, unknown>;
    hooked: Record<string, unknown>;
    invocations: number;
    gaps: unknown[];
  }[];
  expect(rows).toHaveLength(cases.length);
  for (const [
    index,
    { mode, depth, prototypeDepth, once, remaining },
  ] of cases.entries()) {
    const label = `${mode} depth ${String(depth)}, prototype ${String(prototypeDepth)}, once ${String(once)}`;
    const plain = {
      calls: once ? 1 : 2,
      reads: mode.endsWith("accessor") ? 1 : 0,
      remaining,
    };
    const channel = `chain-${String(index)}`;
    expect(rows[index], label).toEqual({
      channel,
      plain,
      hooked: plain,
      invocations: once ? 1 : 0,
      gaps: [{ event: "listener-chain", channel }],
    });
  }
});

it.each(["array", "map"])(
  "snapshots retained state without application %s iterators",
  async (kind) => {
    const root = await createTestTempDirectory(
      "rea-electron-hook-snapshot-iterator-",
    );
    await writeElectronFixture(root);
    const script = join(root, "ipc-snapshot-iterator.cjs");
    await writeFile(
      script,
      `const { ipcMain } = require("electron");
let calls = 0, reads = 0, failure = null, snapshot;
ipcMain.on("ch", () => { calls++; });
ipcMain.emit("ch", { sender: { id: 9 } }, 42);
const prototype = ${JSON.stringify(kind)} === "array" ? Array.prototype : Map.prototype;
const prior = Object.getOwnPropertyDescriptor(prototype, Symbol.iterator);
Object.defineProperty(prototype, Symbol.iterator, { configurable: true, value() {
  reads++; throw new Error("application iterator observed retained state");
}});
try { snapshot = globalThis.__reaElectronActiveSnapshot(); }
catch (cause) { failure = cause.message; }
finally { Object.defineProperty(prototype, Symbol.iterator, prior); }
const copied = snapshot?.events.find(e => e.kind === "main-event-invocation");
if (copied) { copied.channel = "changed"; copied.argument_shapes[0] = "changed"; }
const retained = globalThis.__reaElectronActiveSnapshot().events.find(e => e.kind === "main-event-invocation");
console.log(JSON.stringify({ calls, reads, failure, copied: !!copied, retained: {channel: retained.channel, shapes: retained.argument_shapes} }));
`,
    );
    const execution = await runNode(script, root);
    expect(execution.code, execution.stderr).toBe(0);
    expect(JSON.parse(execution.stdout)).toEqual({
      calls: 1,
      reads: 0,
      failure: null,
      copied: true,
      retained: { channel: "ch", shapes: ["number"] },
    });
  },
);

it("invokes handle callbacks without reading callable method properties", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-ipc-callable-");
  await writeElectronFixture(root);
  const script = join(root, "ipc-callable-properties.cjs");
  await writeFile(
    script,
    `"use strict";
const { ipcMain } = require("electron");
const { EventEmitter } = require("node:events");
const scenario = async (emitter, observed) => {
  let calls = 0;
  let reads = 0;
  let correctReceiver = false;
  let arity = null;
  const listener = new Proxy(function(...args) {
    calls += 1;
    correctReceiver = this === undefined;
    arity = args.length;
  }, { get(target, key, receiver) {
    if (key === "call" || key === "apply") {
      reads += 1;
      throw new Error("callable metadata must not be read");
    }
    return Reflect.get(target, key, receiver);
  }});
  const event = { sender: { id: 9 } };
  let failure = null;
  try {
    if (observed) {
      emitter.handle("ch", listener);
      const handler = emitter.handlers.get("ch");
      await handler(event, 42);
    } else {
      await listener(event, 42);
    }
  } catch (cause) { failure = cause.message; }
  return { calls, reads, correct_receiver: correctReceiver, arity, failure };
};
(async () => {
  process.stdout.write(JSON.stringify({ plain: await scenario(new EventEmitter(), false),
    hooked: await scenario(ipcMain, true) }) + "\\n");
})();
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const { plain, hooked } = JSON.parse(execution.stdout) as {
    plain: Record<string, unknown>;
    hooked: Record<string, unknown>;
  };
  expect(plain).toEqual({
    calls: 1,
    reads: 0,
    correct_receiver: true,
    arity: 2,
    failure: null,
  });
  expect(hooked).toEqual(plain);
});

it.each(["accessor", "proxy"])(
  "does not evaluate %s listener metadata while classifying ipcMain wrappers",
  async (kind) => {
    const root = await createTestTempDirectory(
      "rea-electron-hook-ipc-accessor-",
    );
    await writeElectronFixture(root);
    const script = join(root, "ipc-listener-accessor.cjs");
    await writeFile(
      script,
      `const { ipcMain } = require("electron");
const { EventEmitter } = require("node:events");
const event = { sender: { id: 9 } };
const scenario = (emitter) => {
  let reads = 0;
  let calls = 0;
  let listener = () => { calls += 1; };
  const inspectMetadata = () => {
    reads += 1;
    throw new Error("listener metadata must not run during registration");
  };
  if (${JSON.stringify(kind)} === "accessor") {
    Object.defineProperty(listener, "listener", { get: inspectMetadata });
  } else {
    listener = new Proxy(listener, {
      getOwnPropertyDescriptor: inspectMetadata,
      get(target, key, receiver) {
        if (key === "listener") return inspectMetadata();
        return Reflect.get(target, key, receiver);
      },
    });
  }
  let failure = null;
  let registered = 0;
  try {
    emitter.on("accessor", listener);
    emitter.emit("accessor", event);
    registered = emitter.listenerCount("accessor");
    emitter.removeAllListeners("accessor");
  } catch (cause) { failure = cause.message; }
  return { reads, calls, registered, failure };
};
process.stdout.write(JSON.stringify({ plain: scenario(new EventEmitter()), hooked: scenario(ipcMain) }) + "\\n");
`,
    );
    const execution = await runNode(script, root);
    expect(execution.code, execution.stderr).toBe(0);
    const { plain, hooked } = JSON.parse(execution.stdout) as {
      plain: Record<string, unknown>;
      hooked: Record<string, unknown>;
    };
    expect(plain).toEqual({ reads: 0, calls: 1, registered: 1, failure: null });
    expect(hooked).toEqual(plain);
  },
);

it("isolates hook and exercise from ancestor Electron packages", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-ancestor-");
  await writeElectronFixture(root, 'module.exports = "/ambient/Electron";');
  const ambientHook = await stageHook(join(root, "producer", "scripts"));
  expect(createRequire(ambientHook)("electron")).toBe("/ambient/Electron");

  const fixture = join(root, "fixture");
  await writeElectronFixture(fixture);
  const script = join(fixture, "exercise.cjs");
  await writeFile(
    script,
    `const { BrowserWindow } = require("electron");
const window = new BrowserWindow({ webPreferences: {} });
process.stdout.write(JSON.stringify({
  hook_error: globalThis.__reaElectronActiveSnapshot().hook_error,
  window_open_handler: typeof window.webContents.windowOpenHandler,
}) + "\\n");
`,
  );
  const result = await runNode(script, fixture, ambientHook);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    hook_error: false,
    window_open_handler: "function",
  });
});

it("does not read an application rawListeners accessor during hook setup", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-raw-listeners-accessor-",
  );
  const source = electronModuleSource.replace(
    "const ipcMain = new EventEmitter();",
    `const ipcMain = new EventEmitter();
let rawListenersReads = 0;
Object.defineProperty(ipcMain, "rawListeners", { configurable: true, get() {
  rawListenersReads++;
  throw new Error("application rawListeners getter");
}});
globalThis.__rawListenersReads = () => rawListenersReads;`,
  );
  await writeElectronFixture(root, source);
  const script = join(root, "raw-listeners-accessor.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
let calls = 0;
ipcMain.on("ch", () => calls++);
ipcMain.emit("ch");
ipcMain.removeAllListeners("ch");
console.log(JSON.stringify({ calls, reads: globalThis.__rawListenersReads(),
  hook_error: globalThis.__reaElectronActiveSnapshot().hook_error }));
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  expect(JSON.parse(execution.stdout)).toEqual({
    calls: 1,
    reads: 0,
    hook_error: false,
  });
});

it("leaves an accessor removal method untouched and suppresses uncertain invocation evidence", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-removal-method-accessor-",
  );
  const source = electronModuleSource.replace(
    "const ipcMain = new EventEmitter();",
    `const ipcMain = new EventEmitter();
let removeListenerReads = 0;
Object.defineProperty(ipcMain, "removeListener", { configurable: true, get() {
  removeListenerReads++;
  return EventEmitter.prototype.removeListener;
}});
globalThis.__removeListenerReads = () => removeListenerReads;`,
  );
  await writeElectronFixture(root, source);
  const script = join(root, "removal-method-accessor.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const listener = function original() {};
ipcMain.on("ch", listener);
ipcMain.emit("ch");
ipcMain.removeAllListeners("ch");
const snapshot = globalThis.__reaElectronActiveSnapshot();
console.log(JSON.stringify({ reads: globalThis.__removeListenerReads(),
  invocations: snapshot.events.filter((event) => event.kind === "main-event-invocation"),
  gaps: snapshot.events.filter((event) => event.kind === "ipc-observation-gap"),
  remaining: ipcMain.listenerCount("ch"), hook_error: snapshot.hook_error }));
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const result = JSON.parse(execution.stdout) as {
    readonly reads: number;
    readonly invocations: readonly unknown[];
    readonly gaps: readonly {
      readonly event: string;
      readonly channel: string | null;
    }[];
    readonly remaining: number;
    readonly hook_error: boolean;
  };
  expect(result).toMatchObject({
    reads: 0,
    invocations: [],
    remaining: 0,
    hook_error: false,
  });
  expect(result.gaps).toEqual([
    expect.objectContaining({ event: "listener-registration", channel: "ch" }),
  ]);
});

it("preserves native last-registration order when the last raw listener link is mutated", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-removal-mutated-lifo-",
  );
  await writeElectronFixture(root);
  const script = join(root, "removal-mutated-lifo.cjs");
  await writeFile(
    script,
    `const { EventEmitter } = require("node:events");
const { ipcMain } = require("electron");
const scenario = (emitter) => {
  const calls = [];
  const listener = () => calls.push("listener");
  const marker = () => calls.push("marker");
  const foreign = () => calls.push("foreign");
  const nativeRemove = emitter.removeListener;
  let removals = 0;
  let failure = null;
  emitter.on("removeListener", () => {});
  emitter.on("ch", listener);
  emitter.on("ch", marker);
  emitter.on("ch", listener);
  emitter.rawListeners("ch").at(-1).listener = foreign;
  emitter.removeListener = function(channel, candidate) {
    if (channel === "ch" && ++removals === 2)
      throw new Error("second callback removal rejected");
    return Reflect.apply(nativeRemove, this, arguments);
  };
  try { emitter.removeAllListeners("ch"); } catch (cause) { failure = cause.message; }
  emitter.removeListener = nativeRemove;
  calls.length = 0;
  emitter.emit("ch");
  return { failure, removals, remaining: emitter.listenerCount("ch"), calls };
};
process.stdout.write(JSON.stringify({
  plain: scenario(new EventEmitter()),
  hooked: scenario(ipcMain),
  hook_error: globalThis.__reaElectronActiveSnapshot().hook_error,
}) + "\\n");
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const result = JSON.parse(
    execution.stdout.trim().split("\n").at(-1) ?? "null",
  ) as {
    readonly plain: {
      readonly failure: string;
      readonly removals: number;
      readonly remaining: number;
      readonly calls: readonly string[];
    };
    readonly hooked: {
      readonly failure: string;
      readonly removals: number;
      readonly remaining: number;
      readonly calls: readonly string[];
    };
    readonly hook_error: boolean;
  };
  expect(result.hook_error).toBe(false);
  expect(result.hooked).toEqual(result.plain);
  expect(result.plain).toEqual({
    failure: "second callback removal rejected",
    removals: 2,
    remaining: 2,
    calls: ["listener", "marker"],
  });
});

it("lets a later data listener link win over an earlier owned callback", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-removal-later-data-link-",
  );
  await writeElectronFixture(root);
  const script = join(root, "removal-later-data-link.cjs");
  await writeFile(
    script,
    `const { EventEmitter } = require("node:events");
const { ipcMain } = require("electron");
const scenario = (emitter) => {
  const calls = [];
  const original = function original() { calls.push("original"); };
  const later = function later() { calls.push("later"); };
  const removed = [];
  emitter.on("removeListener", (_channel, callback) => removed.push(callback === original ? "original" : callback === later ? "later" : "other"));
  emitter.on("ch", original);
  emitter.on("ch", later);
  emitter.rawListeners("ch")[1].listener = original;
  emitter.removeListener("ch", original);
  return { remaining: emitter.listenerCount("ch"), removed,
    originalStillRegistered: emitter.listeners("ch").includes(original),
    laterStillRegistered: emitter.listeners("ch").includes(later) };
};
console.log(JSON.stringify({ plain: scenario(new EventEmitter()), hooked: scenario(ipcMain),
  hook_error: globalThis.__reaElectronActiveSnapshot().hook_error }));
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const result = JSON.parse(execution.stdout) as {
    readonly plain: {
      readonly remaining: number;
      readonly removed: readonly string[];
      readonly originalStillRegistered: boolean;
      readonly laterStillRegistered: boolean;
    };
    readonly hooked: {
      readonly remaining: number;
      readonly removed: readonly string[];
      readonly originalStillRegistered: boolean;
      readonly laterStillRegistered: boolean;
    };
    readonly hook_error: boolean;
  };
  expect(result.hook_error).toBe(false);
  expect(result.hooked).toEqual(result.plain);
  expect(result.plain).toEqual({
    remaining: 1,
    removed: ["original"],
    originalStillRegistered: true,
    laterStillRegistered: false,
  });
});

it("normalizes a later raw link to an earlier owned registration", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-removal-owned-link-chain-",
  );
  await writeElectronFixture(root);
  const script = join(root, "removal-owned-link-chain.cjs");
  await writeFile(
    script,
    `const { EventEmitter } = require("node:events");
const { ipcMain } = require("electron");
const scenario = (emitter) => {
  const calls = [];
  const original = function original() { calls.push("original"); };
  const later = function later() { calls.push("later"); };
  const foreign = function foreign() {};
  const removed = [];
  emitter.on("removeListener", (_channel, callback) => removed.push(callback === original ? "original" : callback === later ? "later" : "other"));
  emitter.on("ch", original);
  emitter.on("ch", later);
  const first = emitter.rawListeners("ch")[0];
  const second = emitter.rawListeners("ch")[1];
  first.listener = foreign;
  second.listener = first;
  emitter.removeListener("ch", original);
  emitter.emit("ch");
  return { remaining: emitter.listenerCount("ch"), removed, calls };
};
console.log(JSON.stringify({ plain: scenario(new EventEmitter()), hooked: scenario(ipcMain),
  hook_error: globalThis.__reaElectronActiveSnapshot().hook_error }));
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const result = JSON.parse(execution.stdout) as {
    readonly plain: {
      readonly remaining: number;
      readonly removed: readonly string[];
      readonly calls: readonly string[];
    };
    readonly hooked: {
      readonly remaining: number;
      readonly removed: readonly string[];
      readonly calls: readonly string[];
    };
    readonly hook_error: boolean;
  };
  expect(result.hook_error).toBe(false);
  expect(result.hooked).toEqual(result.plain);
  expect(result.plain).toEqual({
    remaining: 1,
    removed: ["original"],
    calls: ["original"],
  });
});

it("preserves native direct-removal cleanup with throwing listener metadata", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-removal-accessor-gap-",
  );
  await writeElectronFixture(root);
  const script = join(root, "removal-accessor-gap.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const marker = new Error("listener metadata getter");
let reads = 0;
const listener = function original() {};
ipcMain.on("ch", listener);
Object.defineProperty(ipcMain.rawListeners("ch")[0], "listener", { get() {
  reads++;
  throw marker;
}});
let failure;
try { ipcMain.removeListener("ch", listener); } catch (cause) { failure = cause; }
const snapshot = globalThis.__reaElectronActiveSnapshot();
console.log(JSON.stringify({ reads, sameFailure: failure === marker,
  remaining: ipcMain.listenerCount("ch"),
  gaps: snapshot.events.filter((event) => event.kind === "ipc-observation-gap"),
  hook_error: snapshot.hook_error }));
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const result = JSON.parse(execution.stdout) as {
    readonly reads: number;
    readonly sameFailure: boolean;
    readonly remaining: number;
    readonly gaps: readonly Record<string, unknown>[];
    readonly hook_error: boolean;
  };
  // Pinned Node24.18 removes the exact callback without reading its public
  // metadata when no removeListener observer is registered.
  expect(result).toMatchObject({
    reads: 0,
    sameFailure: false,
    remaining: 0,
    hook_error: false,
  });
  expect(result.gaps).toEqual([]);
});

it("forwards native direct-removal bookkeeping to the real emitter", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-removal-bookkeeping-",
  );
  await writeElectronFixture(root);
  const script = join(root, "removal-bookkeeping.cjs");
  await writeFile(
    script,
    `const { EventEmitter } = require("node:events");
const { ipcMain } = require("electron");
const scenario = (emitter) => {
  const listener = function original() {};
  const foreign = function foreign() {};
  const payloads = [];
  emitter.on("removeListener", (_channel, callback) => payloads.push(callback === foreign ? "foreign" : callback === listener ? "original" : "other"));
  emitter.on("ch", listener);
  emitter.rawListeners("ch")[0].listener = foreign;
  emitter.removeListener("ch", listener);
  const afterRemoval = { eventCount: emitter._eventsCount, names: emitter.eventNames().map(String) };
  emitter.on("after", () => {});
  const afterRegister = { eventCount: emitter._eventsCount, names: emitter.eventNames().map(String) };
  return { payloads, afterRemoval, afterRegister };
};
console.log(JSON.stringify({ plain: scenario(new EventEmitter()), hooked: scenario(ipcMain),
  hook_error: globalThis.__reaElectronActiveSnapshot().hook_error }));
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const result = JSON.parse(execution.stdout) as {
    readonly plain: {
      readonly payloads: readonly string[];
      readonly afterRemoval: {
        readonly eventCount: number;
        readonly names: readonly string[];
      };
      readonly afterRegister: {
        readonly eventCount: number;
        readonly names: readonly string[];
      };
    };
    readonly hooked: {
      readonly payloads: readonly string[];
      readonly afterRemoval: {
        readonly eventCount: number;
        readonly names: readonly string[];
      };
      readonly afterRegister: {
        readonly eventCount: number;
        readonly names: readonly string[];
      };
    };
    readonly hook_error: boolean;
  };
  expect(result.hook_error).toBe(false);
  expect(result.hooked).toEqual(result.plain);
  expect(result.plain).toEqual({
    payloads: ["foreign"],
    afterRemoval: { eventCount: 1, names: ["removeListener"] },
    afterRegister: { eventCount: 2, names: ["removeListener", "after"] },
  });
});

it.each([1, 2] as const)(
  "preserves owned listener accessor meta-event behavior with %s registration(s)",
  async (registrationCount) => {
    const root = await createTestTempDirectory(
      "rea-electron-hook-removal-meta-accessor-",
    );
    await writeElectronFixture(root);
    const script = join(root, "removal-meta-accessor.cjs");
    await writeFile(
      script,
      `const { EventEmitter } = require("node:events");
const { ipcMain } = require("electron");
const registrationCount = ${JSON.stringify(registrationCount)};
const scenario = (emitter) => {
  const stages = [];
  const listener = function original() {};
  const marker = function marker() {};
  let reads = 0;
  emitter.on("removeListener", (channel, callback) => {
    stages.push({ kind: "meta", channel, callbackIsOriginal: callback === listener,
      callbackIsMarker: callback === marker, remaining: emitter.listenerCount("ch") });
  });
  for (let index = 0; index < registrationCount; index++) emitter.on("ch", listener);
  if (registrationCount === 2) emitter.on("ch", marker);
  Object.defineProperty(emitter.rawListeners("ch")[0], "listener", { configurable: true, get() {
    reads++;
    stages.push({ kind: "getter" });
    return listener;
  }});
  let failure = null;
  try { emitter.removeListener("ch", listener); } catch (cause) { failure = cause.message; }
  return { reads, failure, remaining: emitter.listenerCount("ch"), stages };
};
const plain = scenario(new EventEmitter());
const hooked = scenario(ipcMain);
console.log(JSON.stringify({ plain, hooked,
  hook_error: globalThis.__reaElectronActiveSnapshot().hook_error }));
`,
    );
    const execution = await runNode(script, root);
    expect(execution.code, execution.stderr).toBe(0);
    const result = JSON.parse(execution.stdout) as {
      readonly plain: {
        readonly reads: number;
        readonly failure: string | null;
        readonly remaining: number;
        readonly stages: readonly Record<string, unknown>[];
      };
      readonly hooked: {
        readonly reads: number;
        readonly failure: string | null;
        readonly remaining: number;
        readonly stages: readonly Record<string, unknown>[];
      };
      readonly hook_error: boolean;
    };
    expect(result.hook_error).toBe(false);
    expect(result.hooked).toEqual(result.plain);
    expect(result.plain.reads).toBe(registrationCount === 1 ? 1 : 0);
    expect(result.plain.failure).toBeNull();
    expect(result.plain.stages[0]).toMatchObject(
      registrationCount === 1 ? { kind: "getter" } : { kind: "meta" },
    );
    expect(result.plain.stages.at(-1)).toMatchObject({
      kind: "meta",
      channel: "ch",
      callbackIsOriginal: true,
      remaining: registrationCount === 1 ? 0 : 2,
    });
  },
);

it("keeps listener ownership when native function prototype metadata changes", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-wrapper-constructor-",
  );
  await writeElectronFixture(root);
  const script = join(root, "wrapper-constructor.cjs");
  await writeFile(
    script,
    `const { EventEmitter } = require("node:events");
const { ipcMain } = require("electron");
const scenario = (emitter) => {
  const listener = function original() {};
  const foreign = function foreign() {};
  emitter.on("ch", listener);
  const entry = emitter.rawListeners("ch")[0];
  const constructor = entry.prototype.constructor;
  const constructorIsPublicEntry = constructor === entry;
  constructor.listener = foreign;
  emitter.removeListener("ch", listener);
  return { constructorIsPublicEntry, remaining: emitter.listenerCount("ch") };
};
console.log(JSON.stringify({ plain: scenario(new EventEmitter()), hooked: scenario(ipcMain),
  hook_error: globalThis.__reaElectronActiveSnapshot().hook_error }));
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const result = JSON.parse(execution.stdout);
  expect(result.hook_error).toBe(false);
  expect(result.hooked).toEqual(result.plain);
  expect(result.plain).toEqual({
    constructorIsPublicEntry: true,
    remaining: 0,
  });
});

it("matches native custom inspection that mutates the raw listener", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-removal-inspect-mutation-",
  );
  await writeElectronFixture(root);
  const script = join(root, "removal-inspect-mutation.cjs");
  await writeFile(
    script,
    `const { inspect } = require("node:util");
const { EventEmitter } = require("node:events");
const { ipcMain } = require("electron");
const scenario = (emitter) => {
  const listener = function original() {};
  const foreign = function foreign() {};
  emitter.on("ch", listener);
  const raw = emitter.rawListeners("ch")[0];
  let inspectorReceiverIsRaw = false;
  raw[inspect.custom] = function() {
    inspectorReceiverIsRaw = this === raw;
    this.listener = foreign;
    return "listener inspected";
  };
  const description = inspect(raw, { showProxy: true });
  emitter.removeListener("ch", listener);
  return { inspectorReceiverIsRaw, description,
    remaining: emitter.listenerCount("ch") };
};
console.log(JSON.stringify({ plain: scenario(new EventEmitter()), hooked: scenario(ipcMain),
  hook_error: globalThis.__reaElectronActiveSnapshot().hook_error }));
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const result = JSON.parse(execution.stdout);
  expect(result.hook_error).toBe(false);
  expect(result.hooked).toEqual(result.plain);
  expect(result.plain).toEqual({
    inspectorReceiverIsRaw: true,
    description: "listener inspected",
    remaining: 0,
  });
});

it("normalizes an earlier raw owner in a later removal meta payload", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-removal-owned-meta-link-",
  );
  await writeElectronFixture(root);
  const script = join(root, "removal-owned-meta-link.cjs");
  await writeFile(
    script,
    `const { EventEmitter } = require("node:events");
const { ipcMain } = require("electron");
const scenario = (emitter) => {
  const original = function original() {};
  const later = function later() {};
  const payloads = [];
  emitter.on("removeListener", (_channel, callback) => payloads.push(
    callback === original ? "original" : callback === later ? "later" : "other"));
  emitter.on("ch", original);
  const firstRaw = emitter.rawListeners("ch")[0];
  emitter.removeListener("ch", original);
  emitter.on("ch", later);
  emitter.rawListeners("ch")[0].listener = firstRaw;
  emitter.removeListener("ch", original);
  return { payloads, remaining: emitter.listenerCount("ch") };
};
console.log(JSON.stringify({ plain: scenario(new EventEmitter()), hooked: scenario(ipcMain),
  hook_error: globalThis.__reaElectronActiveSnapshot().hook_error }));
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const result = JSON.parse(execution.stdout);
  expect(result.hook_error).toBe(false);
  expect(result.hooked).toEqual(result.plain);
  expect(result.plain).toEqual({
    payloads: ["original", "original"],
    remaining: 0,
  });
});

it("preserves the native argument that proves a chained removal match", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-removal-chain-argument-",
  );
  await writeElectronFixture(root);
  const script = join(root, "removal-chain-argument.cjs");
  await writeFile(
    script,
    `const { EventEmitter } = require("node:events");
const { ipcMain } = require("electron");
const scenario = (emitter) => {
  const calls = [];
  const original = function original() { calls.push("original"); };
  const g = function g() { calls.push("g"); };
  const h = function h() { calls.push("h"); };
  const removed = [];
  emitter.on("removeListener", (_channel, callback) => removed.push(
    callback === original ? "original" : callback === g ? "g" : callback === h ? "h" : "other"));
  emitter.on("ch", original);
  const firstRaw = emitter.rawListeners("ch")[0];
  g.listener = firstRaw;
  emitter.on("ch", g);
  h.listener = g;
  emitter.on("ch", h);
  emitter.removeListener("ch", original);
  emitter.emit("ch");
  return { remaining: emitter.listenerCount("ch"), removed, calls };
};
console.log(JSON.stringify({ plain: scenario(new EventEmitter()), hooked: scenario(ipcMain),
  hook_error: globalThis.__reaElectronActiveSnapshot().hook_error }));
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const result = JSON.parse(execution.stdout);
  expect(result.hook_error).toBe(false);
  expect(result.hooked).toEqual(result.plain);
  expect(result.plain).toEqual({
    remaining: 2,
    removed: ["original"],
    calls: ["original", "h"],
  });
});

it("falls back to native errors for a revoked listener-array proxy", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-revoked-listener-array-",
  );
  await writeElectronFixture(root);
  const script = join(root, "revoked-listener-array.cjs");
  await writeFile(
    script,
    `const { EventEmitter } = require("node:events");
const { ipcMain } = require("electron");
const scenario = (emitter) => {
  const listener = function original() {};
  const marker = function marker() {};
  emitter.on("ch", listener);
  emitter.on("ch", marker);
  const entry = emitter.rawListeners("ch")[0];
  entry.listener = function foreign() {};
  const revocable = Proxy.revocable(emitter._events.ch, {});
  emitter._events.ch = revocable.proxy;
  revocable.revoke();
  let failure = null;
  try { emitter.removeListener("ch", listener); } catch (cause) { failure = { name: cause.name, message: cause.message }; }
  return failure;
};
const plain = scenario(new EventEmitter());
const hooked = scenario(ipcMain);
console.log(JSON.stringify({ plain, hooked,
  gaps: globalThis.__reaElectronActiveSnapshot().events.filter((event) => event.kind === "ipc-observation-gap"),
  hook_error: globalThis.__reaElectronActiveSnapshot().hook_error }));
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const result = JSON.parse(execution.stdout) as {
    readonly plain: { readonly name: string; readonly message: string };
    readonly hooked: { readonly name: string; readonly message: string };
    readonly gaps: readonly {
      readonly event: string;
      readonly target: string;
    }[];
    readonly hook_error: boolean;
  };
  expect(result.hook_error).toBe(false);
  expect(result.hooked).toEqual(result.plain);
  expect(result.gaps).toContainEqual(
    expect.objectContaining({
      event: "listener-removal",
      target: "ipcMain.removeListener",
    }),
  );
});

it("records a gap when an opaque later registration blocks ownership ordering", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-removal-opaque-gap-",
  );
  await writeElectronFixture(root);
  const script = join(root, "removal-opaque-gap.cjs");
  await writeFile(
    script,
    `const { ipcMain } = require("electron");
const listener = function original() {};
const opaque = function opaque() {};
ipcMain.on("ch", listener);
ipcMain.on("ch", opaque);
ipcMain.rawListeners("ch")[0].listener = listener;
Object.defineProperty(ipcMain.rawListeners("ch")[1], "listener", { get() { return undefined; } });
ipcMain.removeListener("ch", listener);
const snapshot = globalThis.__reaElectronActiveSnapshot();
console.log(JSON.stringify({ remaining: ipcMain.listenerCount("ch"),
  gaps: snapshot.events.filter((event) => event.kind === "ipc-observation-gap"),
  hook_error: snapshot.hook_error }));
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const result = JSON.parse(execution.stdout) as {
    readonly remaining: number;
    readonly gaps: readonly {
      readonly event: string;
      readonly channel: string | null;
    }[];
    readonly hook_error: boolean;
  };
  expect(result.remaining).toBe(1);
  expect(result.gaps).toContainEqual(
    expect.objectContaining({
      kind: "ipc-observation-gap",
      event: "listener-removal",
      phase: "observed",
      channel: "ch",
      target: "ipcMain.removeListener",
      process_type: "main",
      error: false,
    }),
  );
  expect(result.hook_error).toBe(false);
});

it("preserves pre-hook removeListener decorator receiver and callback identity", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-preinstalled-removal-decorator-",
  );
  const source = electronModuleSource.replace(
    "const ipcMain = new EventEmitter();",
    `const ipcMain = new EventEmitter();
globalThis.__preHookRemovalCalls = [];
const originalRemoveListener = EventEmitter.prototype.removeListener;
ipcMain.removeListener = function(channel, callback) {
  globalThis.__preHookRemovalCalls.push({
    receiverIsEmitter: this === ipcMain,
    callback,
  });
  return Reflect.apply(originalRemoveListener, this, arguments);
};`,
  );
  await writeElectronFixture(root, source);
  const script = join(root, "preinstalled-removal-decorator.cjs");
  await writeFile(
    script,
    `const { EventEmitter } = require("node:events");
const { ipcMain } = require("electron");
const observations = globalThis.__preHookRemovalCalls;
const decorate = (emitter) => {
  const native = EventEmitter.prototype.removeListener;
  emitter.removeListener = function(channel, callback) {
    observations.push({ receiverIsEmitter: this === emitter, callback });
    return Reflect.apply(native, this, arguments);
  };
  return emitter;
};
const scenario = (emitter) => {
  const start = observations.length;
  const original = function original() {};
  emitter.on("ch", original);
  emitter.rawListeners("ch")[0].listener = () => {};
  emitter.removeListener("ch", original);
  return {
    remaining: emitter.listenerCount("ch"),
    forwarded: observations.slice(start).map(({ receiverIsEmitter, callback }) => ({
      receiverIsEmitter, callbackIsOriginal: callback === original,
    })),
  };
};
const plain = scenario(decorate(new EventEmitter()));
const hooked = scenario(ipcMain);
console.log(JSON.stringify({ plain: plain.remaining, hooked: hooked.remaining,
  observations: [...plain.forwarded, ...hooked.forwarded],
  hook_error: globalThis.__reaElectronActiveSnapshot().hook_error }));
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const result = JSON.parse(execution.stdout) as {
    readonly plain: number;
    readonly hooked: number;
    readonly observations: readonly {
      readonly receiverIsEmitter: boolean;
      readonly callbackIsOriginal: boolean;
    }[];
    readonly hook_error: boolean;
  };
  expect(result.hook_error).toBe(false);
  expect(result.plain).toBe(0);
  expect(result.hooked).toBe(0);
  expect(result.observations).toEqual([
    { receiverIsEmitter: true, callbackIsOriginal: true },
    { receiverIsEmitter: true, callbackIsOriginal: true },
  ]);
});

it("forwards pre-hook on and once decorators exact registrations with an explicit gap", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-preinstalled-registration-decorators-",
  );
  const source = electronModuleSource.replace(
    "const ipcMain = new EventEmitter();",
    `const ipcMain = new EventEmitter();
globalThis.__preHookRegistrationCalls = [];
const install = (emitter) => {
  const nativeOn = EventEmitter.prototype.on;
  const nativeOnce = EventEmitter.prototype.once;
  emitter.on = function(channel, callback) {
    globalThis.__preHookRegistrationCalls.push({
      method: "on", receiverIsEmitter: this === emitter, callback,
    });
    return Reflect.apply(nativeOn, this, arguments);
  };
  emitter.once = function(channel, callback) {
    globalThis.__preHookRegistrationCalls.push({
      method: "once", receiverIsEmitter: this === emitter, callback,
    });
    return Reflect.apply(nativeOnce, this, arguments);
  };
};
install(ipcMain);`,
  );
  await writeElectronFixture(root, source);
  const script = join(root, "preinstalled-registration-decorators.cjs");
  await writeFile(
    script,
    `const { EventEmitter } = require("node:events");
const { ipcMain } = require("electron");
const observations = globalThis.__preHookRegistrationCalls;
const decorate = (emitter) => {
  const nativeOn = EventEmitter.prototype.on;
  const nativeOnce = EventEmitter.prototype.once;
  emitter.on = function(channel, callback) {
    observations.push({ method: "on", receiverIsEmitter: this === emitter, callback });
    return Reflect.apply(nativeOn, this, arguments);
  };
  emitter.once = function(channel, callback) {
    observations.push({ method: "once", receiverIsEmitter: this === emitter, callback });
    return Reflect.apply(nativeOnce, this, arguments);
  };
  return emitter;
};
const scenario = (emitter) => {
  const start = observations.length;
  const calls = [];
  const ordinary = function ordinary() { calls.push("ordinary"); };
  const oneShot = function oneShot() { calls.push("oneShot"); };
  emitter.on("ch", ordinary);
  emitter.once("ch", oneShot);
  emitter.emit("ch");
  emitter.removeAllListeners("ch");
  return {
    calls,
    forwarded: observations.slice(start).map(({ method, receiverIsEmitter, callback }) => ({
      method, receiverIsEmitter,
      callbackIdentity: callback === ordinary ? "ordinary" : callback === oneShot ? "oneShot" :
        Object.getOwnPropertyDescriptor(callback, "listener")?.value === oneShot ? "onceWrapper" : "unexpected",
    })),
  };
};
const plain = scenario(decorate(new EventEmitter()));
const hooked = scenario(ipcMain);
const snapshot = globalThis.__reaElectronActiveSnapshot();
console.log(JSON.stringify({ plain: plain.calls, hooked: hooked.calls,
  observations: [...plain.forwarded, ...hooked.forwarded],
  calls: snapshot.events.filter((event) => event.kind === "main-event-invocation"),
  gaps: snapshot.events.filter((event) => event.kind === "ipc-observation-gap"),
  hook_error: snapshot.hook_error }));
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const result = JSON.parse(execution.stdout) as {
    readonly plain: readonly string[];
    readonly hooked: readonly string[];
    readonly observations: readonly {
      readonly method: string;
      readonly receiverIsEmitter: boolean;
      readonly callbackIdentity: string;
    }[];
    readonly calls: readonly unknown[];
    readonly gaps: readonly {
      readonly event: string;
      readonly channel: string | null;
    }[];
    readonly hook_error: boolean;
  };
  expect(result.hook_error).toBe(false);
  expect(result.plain).toEqual(["ordinary", "oneShot"]);
  expect(result.hooked).toEqual(result.plain);
  expect(result.observations).toEqual([
    { method: "on", receiverIsEmitter: true, callbackIdentity: "ordinary" },
    { method: "once", receiverIsEmitter: true, callbackIdentity: "oneShot" },
    {
      method: "on",
      receiverIsEmitter: true,
      callbackIdentity: "onceWrapper",
    },
    { method: "on", receiverIsEmitter: true, callbackIdentity: "ordinary" },
    { method: "once", receiverIsEmitter: true, callbackIdentity: "oneShot" },
    {
      method: "on",
      receiverIsEmitter: true,
      callbackIdentity: "onceWrapper",
    },
  ]);
  expect(result.calls).toEqual([]);
  expect(
    result.gaps.filter((gap) => gap.event === "listener-registration"),
  ).toHaveLength(2);
  expect(result.gaps.map((gap) => gap.channel)).toEqual(["ch", "ch"]);
});

it("forwards borrowed on and once registrations without attributing calls to ipcMain", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-borrowed-registration-",
  );
  await writeElectronFixture(root);
  const script = join(root, "borrowed-registration.cjs");
  await writeFile(
    script,
    `const { EventEmitter } = require("node:events");
const { ipcMain } = require("electron");
const scenario = (hooked) => {
  const target = new EventEmitter();
  const registrations = [];
  const calls = [];
  const originalOn = hooked ? ipcMain.on : EventEmitter.prototype.on;
  const originalOnce = hooked ? ipcMain.once : EventEmitter.prototype.once;
  const onListener = function onListener() { calls.push("on"); };
  const onceListener = function onceListener() { calls.push("once"); };
  const foreign = function foreign() {};
  EventEmitter.prototype.on.call(target, "newListener", (channel, callback) => {
    if (channel === "on") registrations.push(callback === onListener);
    if (channel === "once") registrations.push(callback === onceListener);
  });
  Reflect.apply(originalOn, target, ["on", onListener]);
  target.rawListeners("on")[0].listener = foreign;
  target.removeListener("on", onListener);
  target.emit("on");
  Reflect.apply(originalOnce, target, ["once", onceListener]);
  target.rawListeners("once")[0].listener = foreign;
  target.removeListener("once", onceListener);
  target.emit("once");
  return { registrations, calls, remaining: target.eventNames().map(String) };
};
const plain = scenario(false);
const hooked = scenario(true);
const invalid = (method, target) => {
  try { Reflect.apply(target[method], null, ["invalid", () => {}]); return null; }
  catch (cause) { return { name: cause.name, message: cause.message }; }
};
const failures = { plain: {}, hooked: {} };
for (const method of ["on", "once"]) {
  failures.plain[method] = invalid(method, EventEmitter.prototype);
  failures.hooked[method] = invalid(method, ipcMain);
}
const snapshot = globalThis.__reaElectronActiveSnapshot();
console.log(JSON.stringify({ plain, hooked, failures,
  gaps: snapshot.events.filter((event) => event.kind === "ipc-observation-gap").map((event) => ({
    channel: event.channel, event: event.event, target: event.target, error: event.error,
  })),
  invocations: snapshot.events.filter((event) => event.kind === "main-event-invocation").length,
  hook_error: snapshot.hook_error }));
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const result = JSON.parse(execution.stdout);
  expect(result.hook_error).toBe(false);
  expect(result.hooked).toEqual(result.plain);
  expect(result.plain).toEqual({
    registrations: [true, true],
    calls: ["once"],
    remaining: ["newListener"],
  });
  expect(result.failures.hooked).toEqual(result.failures.plain);
  expect(result.failures.plain.on.name).toBe("TypeError");
  expect(result.failures.plain.once.name).toBe("TypeError");
  expect(result.gaps).toEqual([
    {
      channel: "on",
      event: "listener-registration",
      target: "ipcMain.on",
      error: false,
    },
    {
      channel: "once",
      event: "listener-registration",
      target: "ipcMain.once",
      error: false,
    },
    {
      channel: "invalid",
      event: "listener-registration",
      target: "ipcMain.on",
      error: true,
    },
    {
      channel: "invalid",
      event: "listener-registration",
      target: "ipcMain.once",
      error: true,
    },
  ]);
  expect(result.invocations).toBe(0);
});

it("does not inspect object event channels while recording registration gaps", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-object-channel-gap-",
  );
  await writeElectronFixture(root);
  const script = join(root, "object-channel-gap.cjs");
  await writeFile(
    script,
    `const { EventEmitter } = require("node:events");
const { ipcMain } = require("electron");
const scenario = (hooked) => {
  const target = new EventEmitter();
  const effects = [];
  const channel = {
    [Symbol.toPrimitive](hint) { effects.push("coerce:" + hint); return "object-channel"; },
    get toJSON() { effects.push("get:toJSON"); throw new Error("unexpected channel serialization"); },
  };
  const listener = function original() {};
  const registration = hooked ? ipcMain.on : EventEmitter.prototype.on;
  Reflect.apply(registration, target, [channel, listener]);
  return { effects, eventNames: target.eventNames() };
};
const plain = scenario(false);
const hooked = scenario(true);
const snapshot = globalThis.__reaElectronActiveSnapshot();
console.log(JSON.stringify({ plain, hooked,
  gaps: snapshot.events.filter((event) => event.kind === "ipc-observation-gap").map((event) => ({
    channel: event.channel, event: event.event, target: event.target,
  })), hook_error: snapshot.hook_error }));
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const result = JSON.parse(execution.stdout);
  expect(result.hook_error).toBe(false);
  expect(result.hooked).toEqual(result.plain);
  expect(result.plain.effects).toEqual(["coerce:string", "coerce:string"]);
  expect(result.plain.eventNames).toEqual(["object-channel"]);
  expect(result.gaps).toEqual([
    { channel: null, event: "listener-registration", target: "ipcMain.on" },
  ]);
});

it("preserves borrowed removeAllListeners callback identity", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-borrowed-remove-all-identity-",
  );
  await writeElectronFixture(root);
  const script = join(root, "borrowed-remove-all-identity.cjs");
  await writeFile(
    script,
    `const { EventEmitter } = require("node:events");
const { ipcMain } = require("electron");
const publicListener = (() => {
  const listener = function original() {};
  ipcMain.on("source", listener);
  return ipcMain.rawListeners("source")[0];
})();
const makeForeignEmitter = () => {
  const emitter = new EventEmitter();
  const received = [];
  emitter.on("removeListener", () => {});
  emitter.on("ch", publicListener);
  const nativeRemove = EventEmitter.prototype.removeListener;
  emitter.removeListener = function(channel, callback) {
    if (channel === "ch") {
      received.push(callback);
      if (callback !== publicListener) throw new Error("wrong removal callback");
    }
    return Reflect.apply(nativeRemove, this, arguments);
  };
  return { emitter, received };
};
const control = makeForeignEmitter();
const borrowed = makeForeignEmitter();
EventEmitter.prototype.removeAllListeners.call(control.emitter, "ch");
let failure = null;
try { Reflect.apply(ipcMain.removeAllListeners, borrowed.emitter, ["ch"]); }
catch (cause) { failure = cause.message; }
console.log(JSON.stringify({
  controlReceivedPublic: control.received.length === 1 && control.received[0] === publicListener,
  borrowedReceivedPublic: borrowed.received.length === 1 && borrowed.received[0] === publicListener,
  controlRemaining: control.emitter.listenerCount("ch"),
  borrowedRemaining: borrowed.emitter.listenerCount("ch"),
  failure,
  hook_error: globalThis.__reaElectronActiveSnapshot().hook_error,
}));
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  expect(JSON.parse(execution.stdout)).toEqual({
    controlReceivedPublic: true,
    borrowedReceivedPublic: true,
    controlRemaining: 0,
    borrowedRemaining: 0,
    failure: null,
    hook_error: false,
  });
});

it("does not coerce object channels before native listener removal", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-object-channel-",
  );
  await writeElectronFixture(root);
  const script = join(root, "object-channel.cjs");
  await writeFile(
    script,
    `const { EventEmitter } = require("node:events");
const { ipcMain } = require("electron");
const scenario = (emitter) => {
  let conversions = 0;
  const listener = () => {};
  emitter.on("ch", listener);
  const rawListener = emitter.rawListeners("ch")[0];
  rawListener.listener = () => {};
  rawListener.listener = listener;
  const channel = { [Symbol.toPrimitive]() { conversions++; return "ch"; } };
  emitter.removeListener(channel, listener);
  return { conversions, remaining: emitter.listenerCount("ch") };
};
console.log(JSON.stringify({ plain: scenario(new EventEmitter()), hooked: scenario(ipcMain),
  hook_error: globalThis.__reaElectronActiveSnapshot().hook_error }));
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const result = JSON.parse(execution.stdout) as {
    readonly plain: {
      readonly conversions: number;
      readonly remaining: number;
    };
    readonly hooked: {
      readonly conversions: number;
      readonly remaining: number;
    };
    readonly hook_error: boolean;
  };
  expect(result.hook_error).toBe(false);
  expect(result.hooked).toEqual(result.plain);
  expect(result.plain).toEqual({ conversions: 1, remaining: 0 });
});

it("removes observed ipcMain registrations after the public listener link is deleted", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-removal-deleted-link-",
  );
  await writeElectronFixture(root);
  const script = join(root, "removal-deleted-link.cjs");
  await writeFile(
    script,
    `const { EventEmitter } = require("node:events");
const { ipcMain } = require("electron");
const scenario = (emitter) => {
  const listener = () => {};
  const removed = [];
  const nativeRemove = emitter.removeListener;
  let seenOriginal = false;
  emitter.on("removeListener", (_channel, callback) => removed.push(callback === listener));
  emitter.on("ch", listener);
  delete emitter.rawListeners("ch")[0].listener;
  emitter.removeListener = function(channel, callback) {
    if (channel === "ch") seenOriginal = callback === listener;
    return Reflect.apply(nativeRemove, this, arguments);
  };
  emitter.removeAllListeners("ch");
  emitter.removeListener = nativeRemove;
  return { seenOriginal, remaining: emitter.listenerCount("ch"), removed };
};
process.stdout.write(JSON.stringify({
  plain: scenario(new EventEmitter()),
  hooked: scenario(ipcMain),
  hook_error: globalThis.__reaElectronActiveSnapshot().hook_error,
}) + "\\n");
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const result = JSON.parse(
    execution.stdout.trim().split("\n").at(-1) ?? "null",
  ) as {
    readonly plain: {
      readonly seenOriginal: boolean;
      readonly remaining: number;
      readonly removed: readonly boolean[];
    };
    readonly hooked: {
      readonly seenOriginal: boolean;
      readonly remaining: number;
      readonly removed: readonly boolean[];
    };
    readonly hook_error: boolean;
  };
  expect(result.hook_error).toBe(false);
  expect(result.hooked).toEqual(result.plain);
  expect(result.plain).toEqual({
    seenOriginal: true,
    remaining: 0,
    removed: [true],
  });
});

it("preserves native bulk removal and the original error when listener metadata throws", async () => {
  const result =
    await runIpcHookFixture(`const scenario = (emitter, decorated) => {
  const channel = decorated ? "decorated" : "direct";
  const listener = function original() {};
  const failure = new Error("metadata getter");
  const removals = [];
  let reads = 0;
  const observe = () => {};
  const nativeRemove = emitter.removeListener;
  const prior = Object.getOwnPropertyDescriptor(emitter, "removeListener");
  emitter.on("removeListener", observe);
  emitter.on(channel, listener);
  Object.defineProperty(emitter.rawListeners(channel)[0], "listener", {
    configurable: true,
    get() { reads++; throw failure; },
  });
  if (decorated) emitter.removeListener = function(channel, callback) {
    removals.push({ receiverIsEmitter: this === emitter, callbackIsOriginal: callback === listener });
    if (callback !== listener) throw new Error("decorator received noncanonical callback");
    return Reflect.apply(nativeRemove, this, arguments);
  };
  let sameFailure = false;
  try { emitter.removeAllListeners(channel); } catch (cause) { sameFailure = cause === failure; }
  finally {
    if (prior) Object.defineProperty(emitter, "removeListener", prior);
    else delete emitter.removeListener;
    nativeRemove.call(emitter, "removeListener", observe);
  }
  return { reads, sameFailure, remaining: emitter.listenerCount(channel), removals };
};
const rows = [false, true].map(decorated => ({
  decorated, plain: scenario(new EventEmitter(), decorated), hooked: scenario(ipcMain, decorated),
}));
console.log(JSON.stringify({ rows, hookError: globalThis.__reaElectronActiveSnapshot().hook_error }));
`);
  const { rows, hookError } = result as {
    hookError: boolean;
    rows: {
      decorated: boolean;
      plain: Record<string, unknown>;
      hooked: Record<string, unknown>;
    }[];
  };
  expect(hookError).toBe(false);
  expect(rows.map(({ decorated }) => decorated)).toEqual([false, true]);
  for (const { decorated, plain, hooked } of rows) {
    expect(plain).toEqual({
      reads: 1,
      sameFailure: true,
      remaining: 0,
      removals: decorated
        ? [{ receiverIsEmitter: true, callbackIsOriginal: true }]
        : [],
    });
    expect(hooked).toEqual(plain);
  }
});

it("preserves direct removeListener and off cleanup for changed or deleted raw listener links", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-removal-direct-link-",
  );
  await writeElectronFixture(root);
  const script = join(root, "removal-direct-link.cjs");
  await writeFile(
    script,
    `const { EventEmitter } = require("node:events");
const { ipcMain } = require("electron");
const scenario = (emitter, method, link) => {
  const channel = method + "-" + link;
  const listener = () => {};
  emitter.on(channel, listener);
  const entry = emitter.rawListeners(channel)[0];
  if (link === "deleted") delete entry.listener;
  else entry.listener = () => {};
  const returned = emitter[method](channel, listener);
  return { remaining: emitter.listenerCount(channel), returnedEmitter: returned === emitter };
};
const outcomes = {};
for (const method of ["removeListener", "off"]) {
  outcomes[method] = {};
  for (const link of ["changed", "deleted"]) {
    outcomes[method][link] = {
      plain: scenario(new EventEmitter(), method, link),
      hooked: scenario(ipcMain, method, link),
    };
  }
}
console.log(JSON.stringify({
  outcomes,
  hook_error: globalThis.__reaElectronActiveSnapshot().hook_error,
}));
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const removed = { remaining: 0, returnedEmitter: true };
  const unchangedNativeOutcome = {
    changed: { plain: removed, hooked: removed },
    deleted: { plain: removed, hooked: removed },
  };
  expect(JSON.parse(execution.stdout)).toEqual({
    hook_error: false,
    outcomes: {
      removeListener: unchangedNativeOutcome,
      off: unchangedNativeOutcome,
    },
  });
});

it("preserves warning-only rejections and records later blocked shell rejections", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-rejection-warn-",
  );
  await writeElectronFixture(root);
  const script = join(root, "warnings.cjs");
  await writeFile(
    script,
    `const { shell } = require("electron");
Promise.reject(new Error("controlled rejection"));
setImmediate(() => {
  shell.openExternal("https://example.invalid");
  setImmediate(() => {
    console.log(JSON.stringify({
      listeners: process.listenerCount("unhandledRejection"),
      events: globalThis.__reaElectronActiveSnapshot().events.filter(event =>
        event.kind === "process-lifecycle" && event.event === "unhandled-rejection").map(event => ({
          phase: event.phase, argument_shapes: event.argument_shapes, error: event.error,
        })),
    }));
  });
});
`,
  );
  const result = await runNode(script, root, undefined, [
    "--unhandled-rejections=warn",
  ]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toContain("UnhandledPromiseRejectionWarning");
  expect(JSON.parse(result.stdout)).toEqual({
    listeners: 0,
    events: Array.from({ length: 2 }, () => ({
      phase: "observed",
      argument_shapes: ["object", "object"],
      error: true,
    })),
  });
});

it("preserves native rejection listener identity, throws and borrowed process emits", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-rejection-listener-",
  );
  await writeElectronFixture(root);
  const script = join(root, "listeners.cjs");
  await writeFile(
    script,
    `const { EventEmitter } = require("node:events");
const reason = new Error("controlled listener reason");
const promise = Promise.resolve();
const sentinel = new Error("controlled listener throw");
let calls = 0;
function throwingListener(actualReason, actualPromise) {
  if (actualReason !== reason || actualPromise !== promise) throw new Error("identity changed");
  if (++calls === 2) throw sentinel;
}
process.on("unhandledRejection", throwingListener);
const returned = process.emit("unhandledRejection", reason, promise);
let sameThrow = false;
try { process.emit("unhandledRejection", reason, promise); } catch (cause) { sameThrow = cause === sentinel; }
const borrowed = process.emit.call(new EventEmitter(), "unhandledRejection", reason, promise);
process.off("unhandledRejection", throwingListener);
const rejectionShapes = () => globalThis.__reaElectronActiveSnapshot().events.filter(event =>
  event.kind === "process-lifecycle" && event.event === "unhandled-rejection").map(event => event.argument_shapes);
const explicitShapes = rejectionShapes();
const entries = [{}, [], () => undefined, []].map((target, index) => {
  const { proxy, revoke } = Proxy.revocable(target, {});
  if (index < 3) revoke();
  return { reason: proxy, promise: undefined };
});
const received = [];
process.on("unhandledRejection", (reason, promise) => {
  received.push(entries.findIndex(entry => entry.reason === reason && entry.promise === promise));
});
for (const entry of entries) entry.promise = Promise.reject(entry.reason);
setImmediate(() => console.log(JSON.stringify({
  calls, returned, sameThrow, borrowed, explicitShapes,
  received,
  listeners: process.listenerCount("unhandledRejection"),
  rejectedShapes: rejectionShapes().slice(explicitShapes.length),
})));
`,
  );
  const result = await runNode(script, root);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    calls: 2,
    returned: true,
    sameThrow: true,
    borrowed: false,
    explicitShapes: [
      ["object", "object"],
      ["object", "object"],
    ],
    received: [0, 1, 2, 3],
    listeners: 1,
    rejectedShapes: [
      ["object", "object"],
      ["object", "object"],
      ["function", "object"],
      ["array", "object"],
    ],
  });
});

it("preserves an Electron-style uncaught exception listener policy", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-uncaught-policy-",
  );
  await writeElectronFixture(
    root,
    electronModuleSource +
      `
process.on("uncaughtException", () => {
  if (process.listenerCount("uncaughtException") > 1) return;
  console.log(JSON.stringify({ listeners: process.listenerCount("uncaughtException"),
    kinds: globalThis.__reaElectronActiveSnapshot().events.filter(event => event.kind === "process-lifecycle").map(event => event.event),
  }));
});
`,
  );
  const script = join(root, "uncaught.cjs");
  await writeFile(script, 'throw new Error("controlled uncaught");\n');
  const result = await runNode(script, root);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    listeners: 1,
    kinds: ["uncaught-exception"],
  });
});

it.each(["throw", "strict"])(
  "preserves fatal rejection policy in %s mode",
  async (mode) => {
    const root = await createTestTempDirectory(
      "rea-electron-hook-rejection-fatal-",
    );
    await writeElectronFixture(root);
    const script = join(root, "fatal-rejection.cjs");
    await writeFile(
      script,
      `process.on("exit", () => console.log(JSON.stringify({
  listeners: process.listenerCount("uncaughtException"),
  kinds: globalThis.__reaElectronActiveSnapshot().events.filter(event => event.kind === "process-lifecycle").map(event => event.event),
})));
Promise.reject(new Error("controlled fatal rejection"));
`,
    );
    const result = await runNode(script, root, undefined, [
      "--unhandled-rejections=" + mode,
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("controlled fatal rejection");
    expect(JSON.parse(result.stdout)).toEqual({
      listeners: 0,
      kinds:
        mode === "throw"
          ? ["unhandled-rejection", "uncaught-exception"]
          : ["uncaught-exception"],
    });
  },
);

it("preserves fatal process termination after recording uncaught exceptions", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-fatal-");
  await writeElectronFixture(
    root,
    'throw new Error("controlled Electron unavailable");',
  );
  const script = join(root, "fatal.cjs");
  await writeFile(
    script,
    'process.stdout.write(String(globalThis.__reaElectronActiveSnapshot().hook_error) + "\\n");\nthrow new Error("fatal-hook-secret");\n',
  );
  const result = await runNode(script, root);

  expect(result.code).not.toBe(0);
  expect(result.stdout.trim()).toBe("true");
  expect(result.stderr).toContain("fatal-hook-secret");
});

it.each([
  "standard-prefix",
  "sandbox-prefix",
  "absent",
  "invalid-json",
  "mismatch",
  "foreign-hook",
  "unknown-prefix",
  "no-entry",
  "empty-entry",
])("preserves caller-owned argv for the %s capture handoff", async (mode) => {
  const root = await createTestTempDirectory("rea-electron-argv-");
  await writeElectronFixture(root);
  const hook = join(root, "electron-active-hook.cjs");
  const callerArguments = [
    "--",
    "/caller/plugin.asar",
    "--config=/caller/app.asar/settings",
    "-r",
    hook,
    `--require=${hook}`,
    "--inspect=0",
    "--remote-debugging-port=0",
    "/caller/electron-active-hook.cjs",
    "",
    "中文",
  ];
  const plan = [
    "-r",
    mode === "foreign-hook" ? join(root, "foreign-hook.cjs") : hook,
    ...(mode === "no-entry"
      ? []
      : [
          mode === "empty-entry" ? "" : "/selected/app.asar",
          ...callerArguments,
        ]),
  ];
  const argv = [
    "/runner/electron",
    ...(mode === "sandbox-prefix" ? ["--no-sandbox"] : []),
    mode === "unknown-prefix" ? "--inspect=1234" : "--inspect=0",
    "--remote-debugging-port=0",
    ...plan,
  ];
  const handoff = JSON.stringify({
    length: plan.length,
    sha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
  });
  if (mode === "mismatch") argv[argv.length - 1] = "another-document";
  const restored = mode === "standard-prefix" || mode === "sandbox-prefix";
  const script = join(root, "argv.cjs");
  await writeFile(
    script,
    `
    const argv = ${JSON.stringify(argv)};
    process.argv = argv;
    delete process.env.REA_ELECTRON_CAPTURE_ARGV;
    const handoff = ${JSON.stringify(
      mode === "absent" ? null : mode === "invalid-json" ? "{" : handoff,
    )};
    if (handoff !== null) process.env.REA_ELECTRON_CAPTURE_ARGV = handoff;
    require("./electron-active-hook.cjs");
    console.log(JSON.stringify({ argv: process.argv, same: process.argv === argv,
      handoff_present: "REA_ELECTRON_CAPTURE_ARGV" in process.env,
      hook_error: globalThis.__reaElectronActiveSnapshot().hook_error }));
  `,
  );

  // Establish Electron's observed argv before loading the hook.
  const result = await runNode(script, root, undefined, [], false);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    argv: restored
      ? ["/runner/electron", "/selected/app.asar", ...callerArguments]
      : argv,
    same: true,
    handoff_present: false,
    hook_error: !restored && mode !== "absent",
  });
});

const writeElectronFixture = async (
  root: string,
  source = electronModuleSource,
) => {
  const directory = join(root, "node_modules", "electron");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: "electron", main: "index.cjs" }),
  );
  await writeFile(join(directory, "index.cjs"), source);
};

const stageHook = async (
  root: string,
  source = fileURLToPath(
    new URL("../../../scripts/electron-active-hook.cjs", import.meta.url),
  ),
) => {
  await mkdir(root, { recursive: true });
  const hook = join(root, "electron-active-hook.cjs");
  await Promise.all([
    copyFile(source, hook),
    copyFile(
      join(dirname(source), "electron-active-hook-boundaries.cjs"),
      join(root, "electron-active-hook-boundaries.cjs"),
    ),
  ]);
  return hook;
};

const runNode = async (
  script: string,
  root: string,
  sourceHook?: string,
  nodeArguments: readonly string[] = [],
  preloadHook = true,
): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> => {
  const processes = createTestProcessRegistry();
  onTestFinished(() => processes.shutdown());
  return withVerifierCleanup(async () => {
    const hook = await stageHook(root, sourceHook);
    const result = await processes.run(
      process.execPath,
      [...nodeArguments, ...(preloadHook ? ["-r", hook] : []), script],
      { cwd: root, env: process.env },
    );
    return {
      code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }, [() => processes.shutdown()]);
};
