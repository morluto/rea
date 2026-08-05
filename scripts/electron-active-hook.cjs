"use strict";

const {
  createElectronActiveBoundaryPatches,
} = require("./electron-active-hook-boundaries.cjs");

const boundedEnvironmentNumber = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value)
    ? Math.min(20_000, Math.max(1, value))
    : fallback;
};

const MAX_EVENT_NAME_LENGTH = 128;
const MAX_CHANNEL_LENGTH = 1_024;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_ARGUMENT_SHAPES = 32;
const maxEvents = boundedEnvironmentNumber(
  "REA_ELECTRON_ACTIVE_MAX_RUNTIME_EVENTS",
  5_000,
);
const ipcEventKinds = new Set([
  "main-handler-invocation",
  "main-event-invocation",
  "utility-process-fork",
  "utility-process-message",
  "ipc-main-to-renderer",
  "ipc-utility-to-main",
  "ipc-renderer-send",
  "ipc-renderer-invoke",
  "ipc-renderer-post-message",
]);
const events = [];
let observed = 0;
let observedIpc = 0;
let observedRuntime = 0;
let truncated = false;
let sequence = 0;
let correlationSequence = 0;

const boundedString = (value, maximum) =>
  typeof value === "string" ? value.slice(0, maximum) : null;

const shape = (value, depth = 0) => {
  if (depth > 2 || value === null) return value === null ? "null" : "nested";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "undefined":
      return "undefined";
    case "function":
      return "function";
    case "object":
      return "object";
    default:
      return "unknown";
  }
};

const isAllowedNavigation = (value) => {
  if (typeof value !== "string") return true;
  try {
    const parsed = new URL(value);
    if (["file:", "data:", "about:"].includes(parsed.protocol)) return true;
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      ["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
};

const processType = () =>
  typeof process.type === "string" && process.type.length > 0
    ? process.type.slice(0, MAX_IDENTIFIER_LENGTH)
    : "main";

const identity = (value, prefix) => {
  if (value === null || value === undefined) return null;
  const id = value.id;
  const processId = value.pid;
  return typeof id === "string" || typeof id === "number"
    ? `${prefix}:${String(id)}`.slice(0, MAX_IDENTIFIER_LENGTH)
    : typeof processId === "number"
      ? `${prefix}:pid:${String(processId)}`.slice(0, MAX_IDENTIFIER_LENGTH)
      : null;
};

const frameIdentity = (event) => {
  const frame = event?.senderFrame ?? event?.frame;
  const id = frame?.frameTreeNodeId ?? frame?.routingId ?? frame?.id;
  return typeof id === "string" || typeof id === "number"
    ? `frame:${String(id)}`.slice(0, MAX_IDENTIFIER_LENGTH)
    : null;
};

const record = (event) => {
  observed += 1;
  if (ipcEventKinds.has(event.kind)) observedIpc += 1;
  else observedRuntime += 1;
  if (events.length >= maxEvents) {
    truncated = true;
    return null;
  }
  const raw = {
    sequence: ++sequence,
    correlation_id:
      typeof event.correlation_id === "string"
        ? event.correlation_id
        : `capture:${process.pid}:${++correlationSequence}`,
    event: null,
    phase: "observed",
    channel: null,
    channel_truncated: false,
    direction: null,
    sender: null,
    receiver: null,
    frame: null,
    target: null,
    argument_shapes: [],
    argument_shapes_truncated: false,
    result_shape: null,
    process_type: processType(),
    source: "electron-active-hook",
    capture_method: "api-wrapper",
    artifact_path: null,
    artifact_sha256: null,
    error: false,
    ...event,
  };
  const argumentShapes = Array.isArray(raw.argument_shapes)
    ? raw.argument_shapes
    : [];
  events.push({
    ...raw,
    correlation_id: boundedString(raw.correlation_id, MAX_IDENTIFIER_LENGTH),
    event: boundedString(raw.event, MAX_EVENT_NAME_LENGTH),
    channel: boundedString(raw.channel, MAX_CHANNEL_LENGTH),
    channel_truncated:
      raw.channel_truncated === true ||
      (typeof raw.channel === "string" &&
        raw.channel.length > MAX_CHANNEL_LENGTH),
    sender: boundedString(raw.sender, MAX_IDENTIFIER_LENGTH),
    receiver: boundedString(raw.receiver, MAX_IDENTIFIER_LENGTH),
    frame: boundedString(raw.frame, MAX_IDENTIFIER_LENGTH),
    target: boundedString(raw.target, MAX_IDENTIFIER_LENGTH),
    argument_shapes: argumentShapes
      .slice(0, MAX_ARGUMENT_SHAPES)
      .map((value) => boundedString(value, 64) ?? "unknown"),
    argument_shapes_truncated:
      raw.argument_shapes_truncated === true ||
      argumentShapes.length > MAX_ARGUMENT_SHAPES,
    result_shape: boundedString(raw.result_shape, 64),
    process_type: boundedString(raw.process_type, MAX_IDENTIFIER_LENGTH),
    artifact_path: boundedString(raw.artifact_path, 16_384),
    artifact_sha256: boundedString(raw.artifact_sha256, 64),
  });
  return events.at(-1);
};

const recordRuntime = (kind, event, phase, details = {}) =>
  record({ kind, event, phase, ...details });

const recordIpc = (kind, channel, args, details = {}) =>
  (() => {
    const values = Array.isArray(args) ? args : [];
    return record({
      kind,
      channel: typeof channel === "string" ? channel : null,
      argument_shapes: values
        .slice(0, MAX_ARGUMENT_SHAPES)
        .map((value) => shape(value)),
      argument_shapes_truncated: values.length > MAX_ARGUMENT_SHAPES,
      ...details,
    });
  })();

const patchEmitter = (emitter, observeEvent) => {
  if (emitter === null || emitter === undefined) return;
  const original = emitter.emit;
  if (typeof original !== "function") return;
  if (emitter.__reaElectronActiveEmitPatched === true) return;
  try {
    emitter.__reaElectronActiveEmitPatched = true;
    emitter.emit = function patchedEmit(event, ...args) {
      if (typeof event === "string") observeEvent.call(this, event, args);
      return original.call(this, event, ...args);
    };
  } catch {
    globalThis.__reaElectronActiveHookError = true;
  }
};

const recordInvocation = (kind, channel, event, args) =>
  recordIpc(kind, channel, args, {
    direction: "renderer-to-main",
    sender: identity(event?.sender, "webContents"),
    receiver: "main",
    frame: frameIdentity(event),
    process_type: "main",
    error: false,
  });

const patchIpcMain = (ipcMain) => {
  if (ipcMain === null || ipcMain === undefined) return;
  for (const [method, kind] of [
    ["handle", "main-handler-invocation"],
    ["on", "main-event-invocation"],
    ["once", "main-event-invocation"],
  ]) {
    const original = ipcMain[method];
    if (typeof original !== "function") continue;
    ipcMain[method] = function patchedIpcMain(channel, listener) {
      if (typeof listener !== "function")
        return original.call(this, channel, listener);
      const wrapped =
        kind === "main-handler-invocation"
          ? async function wrappedHandler(event, ...args) {
              const recorded = recordInvocation(kind, channel, event, args);
              try {
                const result = await listener.call(this, event, ...args);
                if (recorded !== null) recorded.result_shape = shape(result);
                return result;
              } catch (cause) {
                if (recorded !== null) recorded.error = true;
                throw cause;
              }
            }
          : function wrappedEventListener(event, ...args) {
              const recorded = recordInvocation(kind, channel, event, args);
              try {
                return listener.call(this, event, ...args);
              } catch (cause) {
                if (recorded !== null) recorded.error = true;
                throw cause;
              }
            };
      return original.call(this, channel, wrapped);
    };
  }
};

const patchNavigationMethods = (webContents, contentsId) => {
  for (const method of ["loadURL", "loadFile", "loadDataURL"]) {
    const original = webContents[method];
    if (typeof original !== "function") continue;
    webContents[method] = function patchedNavigation(...args) {
      recordRuntime("navigation", method, "attempted", {
        target: contentsId,
        argument_shapes: args.map((value) => shape(value)),
      });
      if (method === "loadURL" && !isAllowedNavigation(args[0])) {
        recordRuntime("navigation", method, "blocked", {
          target: contentsId,
          error: true,
        });
        return Promise.reject(new Error("External navigation is blocked"));
      }
      try {
        const result = original.apply(this, args);
        if (result !== null && typeof result?.then === "function")
          return result.then(
            (value) => {
              recordRuntime("navigation", method, "completed", {
                target: contentsId,
              });
              return value;
            },
            (cause) => {
              recordRuntime("navigation", method, "failed", {
                target: contentsId,
                error: true,
              });
              throw cause;
            },
          );
        recordRuntime("navigation", method, "completed", {
          target: contentsId,
        });
        return result;
      } catch (cause) {
        recordRuntime("navigation", method, "failed", {
          target: contentsId,
          error: true,
        });
        throw cause;
      }
    };
  }
};

const patchWebContentsIpc = (webContents, contentsId) => {
  const originalSend = webContents.send;
  if (typeof originalSend === "function")
    webContents.send = function patchedSend(channel, ...args) {
      const recorded = recordIpc("ipc-main-to-renderer", channel, args, {
        direction: "main-to-renderer",
        sender: "main",
        receiver: contentsId,
        target: contentsId,
        process_type: "main",
        error: false,
      });
      try {
        const result = originalSend.call(this, channel, ...args);
        if (recorded !== null) recorded.result_shape = shape(result);
        return result;
      } catch (cause) {
        if (recorded !== null) recorded.error = true;
        throw cause;
      }
    };
  const originalPostMessage = webContents.postMessage;
  if (typeof originalPostMessage === "function")
    webContents.postMessage = function patchedPostMessage(
      channel,
      message,
      transfer,
    ) {
      const recorded = recordIpc(
        "ipc-main-to-renderer",
        channel,
        [message, transfer],
        {
          direction: "main-to-renderer",
          sender: "main",
          receiver: contentsId,
          target: contentsId,
          process_type: "main",
          error: false,
        },
      );
      try {
        const result = originalPostMessage.call(
          this,
          channel,
          message,
          transfer,
        );
        if (recorded !== null) recorded.result_shape = shape(result);
        return result;
      } catch (cause) {
        if (recorded !== null) recorded.error = true;
        throw cause;
      }
    };
};

const patchWebContents = (webContents, windowId) => {
  if (webContents === null || webContents === undefined) return;
  const contentsId = identity(webContents, "webContents");
  patchEmitter(webContents, (event, args) => {
    const navigation = [
      "did-start-loading",
      "did-stop-loading",
      "did-finish-load",
      "did-fail-load",
      "did-frame-finish-load",
      "will-navigate",
      "will-redirect",
    ].includes(event);
    const kind = navigation
      ? "navigation"
      : [
            "console-message",
            "render-process-gone",
            "crashed",
            "unresponsive",
            "responsive",
          ].includes(event)
        ? "error"
        : event === "did-create-window"
          ? "popup-attempt"
          : "web-contents-lifecycle";
    if (event === "will-navigate" || event === "will-redirect") {
      if (!isAllowedNavigation(args[1])) {
        const preventDefault = args[0]?.preventDefault;
        if (typeof preventDefault === "function") preventDefault.call(args[0]);
        recordRuntime("navigation", event, "blocked", {
          target: contentsId,
          sender: windowId,
          argument_shapes: args.map((value) => shape(value)),
          error: true,
        });
        return;
      }
    }
    recordRuntime(kind, event, "observed", {
      target: contentsId,
      sender: windowId,
      argument_shapes: args.map((value) => shape(value)),
      error: kind === "error",
    });
    if (event === "did-create-window") {
      const childWindow = args[0];
      patchWebContents(
        childWindow?.webContents,
        identity(childWindow, "window"),
      );
    }
  });
  patchNavigationMethods(webContents, contentsId);
  patchWebContentsIpc(webContents, contentsId);
  boundaries.patchWindowOpenHandler(webContents, contentsId);
};

const patchBrowserWindow = (electron) => {
  const original = electron.BrowserWindow;
  if (typeof original !== "function") return;
  electron.BrowserWindow = new Proxy(original, {
    construct(target, args, newTarget) {
      const window = Reflect.construct(target, args, newTarget);
      const targetId = identity(window, "window");
      recordRuntime("window-lifecycle", "created", "completed", {
        target: targetId,
        argument_shapes: args.map((value) => shape(value)),
      });
      const preload = args[0]?.webPreferences?.preload;
      if (typeof preload === "string")
        recordRuntime("preload", "configured", "completed", {
          target: targetId,
          artifact_path: preload,
        });
      patchEmitter(window, (event) =>
        recordRuntime("window-lifecycle", event, "observed", {
          target: targetId,
        }),
      );
      patchWebContents(window.webContents, targetId);
      return window;
    },
  });
};

const boundaries = createElectronActiveBoundaryPatches({
  identity,
  patchEmitter,
  processType,
  recordIpc,
  recordRuntime,
  shape,
});

try {
  const electron = require("electron");
  patchEmitter(electron.app, (event, args) =>
    recordRuntime(
      event === "open-url" || event === "second-instance"
        ? "protocol"
        : "app-lifecycle",
      event,
      "observed",
      {
        target: "app",
        argument_shapes: args.map((value) => shape(value)),
        process_type: "main",
      },
    ),
  );
  patchIpcMain(electron.ipcMain);
  boundaries.patchIpcRenderer(electron.ipcRenderer);
  boundaries.patchContextBridge(electron.contextBridge);
  patchBrowserWindow(electron);
  boundaries.patchUtilityProcess(electron.utilityProcess);
  boundaries.patchShell(electron.shell);
  boundaries.patchSessionManager(electron.session);
  boundaries.patchApplicationEffects(electron.app);
  boundaries.patchNativeAddonLoading();
  boundaries.patchChildProcess();
  process.once("uncaughtException", (cause, origin) => {
    recordRuntime("process-lifecycle", "uncaught-exception", "observed", {
      argument_shapes: [shape(cause), shape(origin)],
      error: true,
    });
    throw cause;
  });
  process.once("unhandledRejection", (reason, promise) => {
    recordRuntime("process-lifecycle", "unhandled-rejection", "observed", {
      argument_shapes: [shape(reason), shape(promise)],
      error: true,
    });
    throw reason;
  });
} catch {
  globalThis.__reaElectronActiveHookError = true;
}

globalThis.__reaElectronActiveSnapshot = () => ({
  events: events.slice(),
  observed,
  observed_ipc: observedIpc,
  observed_runtime: observedRuntime,
  truncated,
  hook_error: globalThis.__reaElectronActiveHookError === true,
});
