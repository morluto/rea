import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { afterEach, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const temporary: string[] = [];

const electronModuleSource = `const { EventEmitter } = require("node:events");
const app = new EventEmitter();
app.isReady = () => true;
app.relaunch = () => undefined;
app.setAsDefaultProtocolClient = () => true;
app.setLoginItemSettings = () => undefined;
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
const shell = { openExternal: () => Promise.resolve(), openPath: () => Promise.resolve() };
const createSession = () => {
  const value = new EventEmitter();
  value.setPermissionRequestHandler = () => undefined;
  value.setPermissionCheckHandler = () => undefined;
  value.setCertificateVerifyProc = () => undefined;
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
electron.session.defaultSession.emit("will-download", window.webContents, { cancel() {} });
electron.session.fromPartition("persist:custom").emit("will-download", window.webContents, { cancel() {} });
const defaultPopupDecision = window.webContents.windowOpenHandler({ url: "https://default-popup.invalid" });
window.webContents.setWindowOpenHandler(() => ({ action: "allow" }));
const popupDecision = window.webContents.windowOpenHandler({ url: "https://popup.invalid" });
electron.shell.openExternal("https://example.invalid").catch(() => undefined);
electron.app.relaunch();
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
process.stdout.write(JSON.stringify({ snapshot, default_popup_decision: defaultPopupDecision, popup_decision: popupDecision }) + "\\n");
})();
`;

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

it("retains active hook evidence within its event-retention budget", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-");
  temporary.push(root);
  await writeFile(join(root, "electron.js"), electronModuleSource);
  const script = join(root, "exercise.cjs");
  await writeFile(script, activeCaptureSource);
  const hook = join(process.cwd(), "scripts/electron-active-hook.cjs");
  const execution = await runNode(hook, script, root, root);
  expect(execution.code, execution.stderr).toBe(0);
  const result = JSON.parse(
    execution.stdout.trim().split("\n").at(-1) ?? "null",
  ) as {
    readonly default_popup_decision: { readonly action: string };
    readonly popup_decision: { readonly action: string };
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

  expect(snapshot.hook_error).toBe(false);
  expect(snapshot.events).toHaveLength(snapshot.retained);
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
      expect.objectContaining({ kind: "updater", phase: "blocked" }),
      expect.objectContaining({ kind: "native-addon" }),
      expect.objectContaining({ kind: "popup-attempt", phase: "blocked" }),
    ]),
  );
  expect(result.default_popup_decision).toEqual({ action: "deny" });
  expect(result.popup_decision).toEqual({ action: "deny" });
  expect(
    snapshot.events.filter(
      (event) => event.kind === "download" && event.phase === "blocked",
    ),
  ).toHaveLength(2);
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

it("preserves fatal process termination after recording uncaught exceptions", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-fatal-");
  temporary.push(root);
  const script = join(root, "fatal.cjs");
  await writeFile(script, 'throw new Error("fatal-hook-secret");\n');
  const hook = join(process.cwd(), "scripts/electron-active-hook.cjs");
  const result = await runNode(hook, script, root, root);

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("fatal-hook-secret");
});

const runNode = (
  hook: string,
  script: string,
  moduleRoot: string,
  cwd: string,
): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-r", hook, script], {
      cwd,
      env: {
        ...process.env,
        NODE_PATH: moduleRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
