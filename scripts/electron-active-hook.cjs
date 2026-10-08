"use strict";

const {
  createElectronActiveBoundaryPatches,
} = require("./electron-active-hook-boundaries.cjs");

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
// Budget serialized data and estimated retained object/array storage together.
const retentionBudgetBytes = 16 * 1024 * 1024;
const snapshotEnvelopeReserveBytes = 1024;
let estimatedRetainedBytes = 0;
let serializedBytes = 0;
let observed = 0;
let observedIpc = 0;
let observedRuntime = 0;
let dropped = 0;
let droppedIpc = 0;
let droppedRuntime = 0;
const droppedFamilies = new Map();
const droppedRoles = new Map();
let sequence = 0;
let correlationSequence = 0;

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

// Measure JSON strings without allocating an encoded copy of a caller value.
const jsonStringBytes = (value) => {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) bytes += 2;
    else if (
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    )
      bytes += 2;
    else if (code <= 0x1f) bytes += 6;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 6;
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6;
    else if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else bytes += 3;
    if (bytes > retentionBudgetBytes) return bytes;
  }
  return bytes;
};

const jsonScalarBytes = (value) => {
  if (value === null) return 4;
  if (typeof value === "string") return jsonStringBytes(value);
  if (typeof value === "boolean") return value ? 4 : 5;
  return String(value).length;
};

const eventFamily = (kind, processTypeValue) => {
  if (kind === "preload" && processTypeValue === "main")
    return "preload-configuration";
  if (kind.startsWith("ipc-renderer"))
    return processTypeValue === "renderer" ? "renderer-ipc" : "ipc";
  return ipcEventKinds.has(kind) ? "ipc" : kind;
};

const noteDropped = (kind, processTypeValue, isIpc) => {
  dropped += 1;
  if (isIpc) droppedIpc += 1;
  else droppedRuntime += 1;
  const family = eventFamily(kind, processTypeValue);
  droppedFamilies.set(family, (droppedFamilies.get(family) ?? 0) + 1);
  if (typeof processTypeValue === "string")
    droppedRoles.set(
      processTypeValue,
      (droppedRoles.get(processTypeValue) ?? 0) + 1,
    );
  if (kind === "window-lifecycle")
    droppedRoles.set("window", (droppedRoles.get("window") ?? 0) + 1);
  if (kind === "web-contents-lifecycle" || kind === "navigation")
    droppedRoles.set(
      "web_contents",
      (droppedRoles.get("web_contents") ?? 0) + 1,
    );
  if (kind === "preload" && processTypeValue === "preload")
    droppedRoles.set("preload", (droppedRoles.get("preload") ?? 0) + 1);
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
    ? process.type
    : "main";

const identity = (value, prefix) => {
  if (value === null || value === undefined) return null;
  const id = value.id;
  const processId = value.pid;
  return typeof id === "string" || typeof id === "number"
    ? `${prefix}:${String(id)}`
    : typeof processId === "number"
      ? `${prefix}:pid:${String(processId)}`
      : null;
};

const frameIdentity = (event) => {
  const frame = event?.senderFrame ?? event?.frame;
  const id = frame?.frameTreeNodeId ?? frame?.routingId ?? frame?.id;
  return typeof id === "string" || typeof id === "number"
    ? `frame:${String(id)}`
    : null;
};

const record = (event) => {
  observed += 1;
  const isIpc = ipcEventKinds.has(event.kind);
  if (isIpc) observedIpc += 1;
  else observedRuntime += 1;
  const raw = {
    sequence: ++sequence,
    correlation_id:
      typeof event.correlation_id === "string"
        ? event.correlation_id
        : `capture:${process.pid}:${++correlationSequence}`,
    event: null,
    phase: "observed",
    channel: null,
    direction: null,
    sender: null,
    receiver: null,
    frame: null,
    target: null,
    argument_shapes: [],
    result_shape: null,
    process_type: processType(),
    source: "electron-active-hook",
    capture_method: "api-wrapper",
    artifact_path: null,
    artifact_sha256: null,
    error: false,
    ...event,
  };
  const shapeGroups = Array.isArray(raw.argument_shape_value_groups)
    ? raw.argument_shape_value_groups.filter(Array.isArray)
    : Array.isArray(raw.argument_shape_values)
      ? [raw.argument_shape_values]
      : [];
  const existingShapes = Array.isArray(raw.argument_shapes)
    ? raw.argument_shapes
    : [];
  const retainedEvent = {
    ...raw,
    correlation_id: raw.correlation_id,
    event: typeof raw.event === "string" ? raw.event : null,
    channel: typeof raw.channel === "string" ? raw.channel : null,
    sender: typeof raw.sender === "string" ? raw.sender : null,
    receiver: typeof raw.receiver === "string" ? raw.receiver : null,
    frame: typeof raw.frame === "string" ? raw.frame : null,
    target: typeof raw.target === "string" ? raw.target : null,
    argument_shapes: [],
    result_shape:
      typeof raw.result_shape === "string" ? raw.result_shape : null,
    process_type:
      typeof raw.process_type === "string" ? raw.process_type : null,
    artifact_path:
      typeof raw.artifact_path === "string" ? raw.artifact_path : null,
    artifact_sha256:
      typeof raw.artifact_sha256 === "string" ? raw.artifact_sha256 : null,
  };
  delete retainedEvent.argument_shape_values;
  delete retainedEvent.argument_shape_value_groups;

  // All event values are JSON scalars except argument_shapes. Measure them
  // incrementally so large channels, paths, or shape lists never require a
  // full JSON.stringify temporary allocation before the budget decision.
  let eventBytes = 2;
  let argumentShapeCount = 0;
  const eventKeys = Object.keys(retainedEvent);
  for (let index = 0; index < eventKeys.length; index += 1) {
    const key = eventKeys[index];
    const value = retainedEvent[key];
    if (index > 0) eventBytes += 1;
    eventBytes += jsonStringBytes(key) + 1;
    if (key === "argument_shapes") {
      eventBytes += 2;
      let shapeOverflow = false;
      const countShape = (argument) => {
        const encodedShapeBytes = jsonStringBytes(shape(argument));
        eventBytes += encodedShapeBytes + (argumentShapeCount === 0 ? 0 : 1);
        argumentShapeCount += 1;
        shapeOverflow =
          eventBytes + estimatedRetainedBytes + snapshotEnvelopeReserveBytes >
          retentionBudgetBytes;
      };
      for (const group of shapeGroups)
        for (const argument of group) {
          countShape(argument);
          if (shapeOverflow) break;
        }
      if (shapeOverflow) {
        noteDropped(raw.kind, retainedEvent.process_type, isIpc);
        return null;
      }
      for (const valueShape of existingShapes)
        if (!shapeOverflow) {
          eventBytes +=
            jsonStringBytes(
              typeof valueShape === "string" ? valueShape : "unknown",
            ) + (argumentShapeCount++ === 0 ? 0 : 1);
          shapeOverflow =
            eventBytes + estimatedRetainedBytes + snapshotEnvelopeReserveBytes >
            retentionBudgetBytes;
        }
      if (shapeOverflow) {
        noteDropped(raw.kind, retainedEvent.process_type, isIpc);
        return null;
      }
    } else eventBytes += jsonScalarBytes(value);
    if (
      eventBytes + estimatedRetainedBytes + snapshotEnvelopeReserveBytes >
      retentionBudgetBytes
    ) {
      noteDropped(raw.kind, retainedEvent.process_type, isIpc);
      return null;
    }
  }
  // Reserve room for the only fields mutated after recording: result_shape and
  // error. The shape vocabulary's longest value is "undefined".
  const reservedMutationBytes = retainedEvent.result_shape === null ? 7 : 0;
  // Include one byte for the event-array separator and reserve space for the
  // snapshot's counters and JSON delimiters.
  // One retained event, one defensive snapshot copy, and up to two serialized
  // result views (timeline plus IPC), with per-object and per-array-slot costs.
  const eventEstimateBytes = eventBytes * 3 + 512 + argumentShapeCount * 16;
  const retainedEventBytes = eventEstimateBytes + reservedMutationBytes + 1;
  if (
    estimatedRetainedBytes + retainedEventBytes + snapshotEnvelopeReserveBytes >
    retentionBudgetBytes
  ) {
    noteDropped(raw.kind, retainedEvent.process_type, isIpc);
    return null;
  }
  for (const group of shapeGroups)
    for (const argument of group)
      retainedEvent.argument_shapes.push(shape(argument));
  for (const valueShape of existingShapes)
    retainedEvent.argument_shapes.push(
      typeof valueShape === "string" ? valueShape : "unknown",
    );
  events.push(retainedEvent);
  estimatedRetainedBytes += retainedEventBytes;
  serializedBytes += eventBytes + reservedMutationBytes + 1;
  return retainedEvent;
};

const recordRuntime = (kind, event, phase, details = {}) =>
  record({ kind, event, phase, ...details });

const recordIpc = (kind, channel, args, details = {}) =>
  (() => {
    const values = Array.isArray(args) ? args : [];
    return record({
      kind,
      channel: typeof channel === "string" ? channel : null,
      argument_shape_values: values,
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
        argument_shape_values: args,
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
          argument_shape_values: args,
          error: true,
        });
        return;
      }
    }
    recordRuntime(kind, event, "observed", {
      target: contentsId,
      sender: windowId,
      argument_shape_values: args,
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
        argument_shape_values: args,
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
        argument_shape_values: args,
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
      argument_shape_values: [cause, origin],
      error: true,
    });
    throw cause;
  });
  process.once("unhandledRejection", (reason, promise) => {
    recordRuntime("process-lifecycle", "unhandled-rejection", "observed", {
      argument_shape_values: [reason, promise],
      error: true,
    });
    throw reason;
  });
} catch {
  globalThis.__reaElectronActiveHookError = true;
}

globalThis.__reaElectronActiveSnapshot = () => ({
  events: events.map((event) => ({
    ...event,
    argument_shapes: [...event.argument_shapes],
  })),
  retention_budget_bytes: retentionBudgetBytes,
  estimated_retained_bytes: estimatedRetainedBytes,
  event_serialized_byte_upper_bound: serializedBytes,
  retained: events.length,
  dropped,
  dropped_ipc: droppedIpc,
  dropped_runtime: droppedRuntime,
  dropped_event_families: [...droppedFamilies].map(([family, count]) => ({
    family,
    count,
  })),
  dropped_event_roles: [...droppedRoles].map(([role, count]) => ({
    role,
    count,
  })),
  observed,
  observed_ipc: observedIpc,
  observed_runtime: observedRuntime,
  hook_error: globalThis.__reaElectronActiveHookError === true,
});
