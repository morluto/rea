"use strict";

const boundedEnvironmentNumber = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) ? Math.max(1, value) : fallback;
};

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
]);
const events = [];
let observed = 0;
let observedIpc = 0;
let observedRuntime = 0;
let truncated = false;
let sequence = 0;

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

const processType = () =>
  typeof process.type === "string" && process.type.length > 0
    ? process.type
    : "main";

const identity = (value, prefix) => {
  if (value === null || value === undefined) return null;
  const id = value.id;
  return typeof id === "string" || typeof id === "number"
    ? `${prefix}:${String(id)}`
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
  const recorded = {
    sequence: ++sequence,
    event: null,
    phase: "observed",
    channel: null,
    direction: null,
    sender: null,
    receiver: null,
    target: null,
    argument_shapes: [],
    result_shape: null,
    process_type: processType(),
    error: false,
    ...event,
  };
  events.push(recorded);
  return recorded;
};

const recordRuntime = (kind, event, phase, details = {}) =>
  record({ kind, event, phase, ...details });

const recordIpc = (kind, channel, args, details = {}) =>
  record({
    kind,
    channel: typeof channel === "string" ? channel : null,
    argument_shapes: args.map((value) => shape(value)),
    ...details,
  });

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

const patchIpcMain = (ipcMain) => {
  for (const [method, kind] of [
    ["handle", "main-handler-invocation"],
    ["on", "main-event-invocation"],
  ]) {
    const original = ipcMain[method];
    if (typeof original !== "function") continue;
    ipcMain[method] = function patched(channel, listener) {
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

const recordInvocation = (kind, channel, event, args) =>
  recordIpc(kind, channel, args, {
    direction: "renderer-to-main",
    sender: identity(event?.sender, "webContents"),
    receiver: "main",
    process_type: "main",
    error: false,
  });

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

const patchWebContents = (webContents, windowId) => {
  if (webContents === null || webContents === undefined) return;
  const contentsId = identity(webContents, "webContents");
  patchEmitter(webContents, (event, args) => {
    recordRuntime(
      event === "did-start-loading" ||
        event === "did-stop-loading" ||
        event === "did-finish-load" ||
        event === "did-fail-load" ||
        event === "did-frame-finish-load"
        ? "navigation"
        : "web-contents-lifecycle",
      event,
      "observed",
      {
        target: contentsId,
        sender: windowId,
        argument_shapes: args.map((value) => shape(value)),
      },
    );
  });
  for (const method of ["loadURL", "loadFile", "loadDataURL"]) {
    const original = webContents[method];
    if (typeof original !== "function") continue;
    webContents[method] = function patchedNavigation(...args) {
      recordRuntime("navigation", method, "attempted", {
        target: contentsId,
        argument_shapes: args.map((value) => shape(value)),
      });
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
};

const patchUtilityProcess = (utilityProcess) => {
  const original = utilityProcess.fork;
  if (typeof original !== "function") return;
  utilityProcess.fork = function patchedFork(...args) {
    recordRuntime("process-lifecycle", "utility-process-fork", "attempted", {
      argument_shapes: args.map((value) => shape(value)),
      process_type: "main",
    });
    const child = original.apply(this, args);
    const childId = identity(child, "utility");
    recordRuntime("process-lifecycle", "utility-process-fork", "completed", {
      target: childId,
      process_type: "main",
    });
    patchEmitter(child, (event, eventArgs) => {
      if (event === "message") {
        recordIpc("ipc-utility-to-main", null, eventArgs, {
          direction: "utility-to-main",
          sender: childId,
          receiver: "main",
          target: childId,
          process_type: "main",
          error: false,
        });
        return;
      }
      recordRuntime("process-lifecycle", `utility.${event}`, "observed", {
        target: childId,
        process_type: "utility",
        argument_shapes: eventArgs.map((value) => shape(value)),
      });
    });
    if (child && typeof child.postMessage === "function") {
      const postMessage = child.postMessage.bind(child);
      child.postMessage = (...messageArgs) => {
        const recorded = recordIpc(
          "utility-process-message",
          null,
          messageArgs,
          {
            direction: "main-to-utility",
            sender: "main",
            receiver: childId,
            target: childId,
            process_type: "main",
            error: false,
          },
        );
        try {
          const result = postMessage(...messageArgs);
          if (recorded !== null) recorded.result_shape = shape(result);
          return result;
        } catch (cause) {
          if (recorded !== null) recorded.error = true;
          throw cause;
        }
      };
    }
    return child;
  };
};

const patchShell = (shell) => {
  for (const method of ["openExternal", "openPath"]) {
    const original = shell[method];
    if (typeof original !== "function") continue;
    shell[method] = function blockedShellCall(...args) {
      recordRuntime("shell-attempt", method, "blocked", {
        argument_shapes: args.map((value) => shape(value)),
        error: true,
      });
      return Promise.reject(new Error("External shell effects are blocked"));
    };
  }
};

const patchChildProcess = () => {
  const childProcess = require("node:child_process");
  for (const method of ["spawn", "fork", "exec", "execFile"]) {
    const original = childProcess[method];
    if (typeof original !== "function") continue;
    childProcess[method] = function patchedChildProcess(...args) {
      recordRuntime("process-lifecycle", `child.${method}`, "attempted", {
        argument_shapes: args.map((value) => shape(value)),
      });
      const child = original.apply(this, args);
      const childId = identity(child, "child");
      recordRuntime("process-lifecycle", `child.${method}`, "completed", {
        target: childId,
      });
      patchEmitter(child, (event, eventArgs) =>
        recordRuntime("process-lifecycle", `child.${event}`, "observed", {
          target: childId,
          argument_shapes: eventArgs.map((value) => shape(value)),
        }),
      );
      return child;
    };
  }
};

try {
  const electron = require("electron");
  patchEmitter(electron.app, (event, args) =>
    recordRuntime("app-lifecycle", event, "observed", {
      target: "app",
      argument_shapes: args.map((value) => shape(value)),
      process_type: "main",
    }),
  );
  patchIpcMain(electron.ipcMain);
  patchBrowserWindow(electron);
  patchUtilityProcess(electron.utilityProcess);
  patchShell(electron.shell);
  patchChildProcess();
  process.on("uncaughtException", () =>
    recordRuntime("process-lifecycle", "uncaught-exception", "observed", {
      error: true,
    }),
  );
  process.on("unhandledRejection", () =>
    recordRuntime("process-lifecycle", "unhandled-rejection", "observed", {
      error: true,
    }),
  );
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
