import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { afterEach, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

it("keeps active hook lifecycle and IPC evidence bounded at the process boundary", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-");
  temporary.push(root);
  await writeFile(
    join(root, "electron.js"),
    `const { EventEmitter } = require("node:events");
const app = new EventEmitter();
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
}
class BrowserWindow extends EventEmitter {
  constructor(options) {
    super();
    this.id = 3;
    this.webContents = new WebContents();
    this.options = options;
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
const session = new EventEmitter();
session.setPermissionRequestHandler = () => undefined;
session.setPermissionCheckHandler = () => undefined;
session.setCertificateVerifyProc = () => undefined;
session.setWindowOpenHandler = () => undefined;
const contextBridge = {
  exposeInMainWorld: () => undefined,
  exposeInIsolatedWorld: () => undefined,
};
module.exports = {
  app,
  BrowserWindow,
  contextBridge,
  ipcMain,
  ipcRenderer,
  session: { defaultSession: session },
  shell,
  utilityProcess,
};
`,
  );
  const script = join(root, "exercise.cjs");
  await writeFile(
    script,
    `(async () => {
const electron = require("electron");
const window = new electron.BrowserWindow({ webPreferences: { preload: "/approved/preload.js" } });
const channel = "x".repeat(2048);
electron.ipcMain.handle(channel, async () => ({ ok: true }));
await electron.ipcMain.handlers.get(channel)({ sender: { id: 9 }, senderFrame: { routingId: 7 } }, ...Array.from({ length: 40 }, () => ({ value: true })));
window.webContents.send("main-to-renderer", { value: true });
window.webContents.emit("render-process-gone", { reason: "crashed" });
const utility = electron.utilityProcess.fork("utility.js");
utility.emit("message", { data: { value: true } });
utility.postMessage({ value: true });
electron.session.defaultSession.emit("will-download", window.webContents, { cancel() {} });
electron.shell.openExternal("https://example.invalid").catch(() => undefined);
electron.app.relaunch();
electron.contextBridge.exposeInMainWorld("api", { value: true });
window.webContents.loadURL("https://example.invalid").catch(() => undefined);
try { process.dlopen({}, "/missing/native.node"); } catch {}
process.stdout.write(JSON.stringify(globalThis.__reaElectronActiveSnapshot()) + "\\n");
})();
`,
  );
  const hook = join(process.cwd(), "scripts/electron-active-hook.cjs");
  const output = await runNode(hook, script, root, root);
  const snapshot = JSON.parse(output.trim().split("\n").at(-1) ?? "null") as {
    readonly hook_error: boolean;
    readonly events: readonly Record<string, unknown>[];
  };

  expect(snapshot.hook_error).toBe(false);
  expect(snapshot.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "window-lifecycle", event: "created" }),
      expect.objectContaining({ kind: "preload", event: "configured" }),
      expect.objectContaining({ kind: "shell-attempt", phase: "blocked" }),
      expect.objectContaining({ kind: "updater", phase: "blocked" }),
      expect.objectContaining({ kind: "native-addon" }),
    ]),
  );
  const ipc = snapshot.events.find(
    (event) => event.kind === "main-handler-invocation",
  );
  expect(ipc).toMatchObject({
    channel_truncated: true,
    argument_shapes_truncated: true,
    direction: "renderer-to-main",
    sender: "webContents:9",
    frame: "frame:7",
  });
  expect(ipc?.channel).toHaveLength(1_024);
  expect(ipc?.argument_shapes).toHaveLength(32);
});

const runNode = (
  hook: string,
  script: string,
  moduleRoot: string,
  cwd: string,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-r", hook, script], {
      cwd,
      env: {
        ...process.env,
        NODE_PATH: moduleRoot,
        REA_ELECTRON_ACTIVE_MAX_RUNTIME_EVENTS: "200",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        const text = Buffer.concat(stdout).toString("utf8");
        if (text.length > 0) resolve(text);
        else
          reject(
            new Error(
              `hook fixture produced no output: ${Buffer.concat(stderr).toString("utf8")}`,
            ),
          );
      } else
        reject(
          new Error(
            `hook fixture exited with ${String(code)}: ${Buffer.concat(stderr).toString("utf8")}`,
          ),
        );
    });
  });
