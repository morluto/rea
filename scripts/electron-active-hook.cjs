"use strict";

const maxEvents = Number.isInteger(
  Number(process.env.REA_ELECTRON_ACTIVE_MAX_IPC_EVENTS),
)
  ? Math.max(1, Number(process.env.REA_ELECTRON_ACTIVE_MAX_IPC_EVENTS))
  : 2_000;
const events = [];
let observed = 0;
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

const record = (event) => {
  observed += 1;
  if (events.length >= maxEvents) {
    truncated = true;
    return null;
  }
  const recorded = { sequence: ++sequence, ...event };
  events.push(recorded);
  return recorded;
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
              const recorded = recordInvocation(kind, channel, args);
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
              const recorded = recordInvocation(kind, channel, args);
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

const recordInvocation = (kind, channel, args) =>
  record({
    kind,
    channel: typeof channel === "string" ? channel : null,
    argument_shapes: args.map((value) => shape(value)),
    result_shape: null,
    process_type: "main",
    error: false,
  });

const patchUtilityProcess = (utilityProcess) => {
  const original = utilityProcess.fork;
  if (typeof original !== "function") return;
  utilityProcess.fork = function patchedFork(...args) {
    const child = original.apply(this, args);
    record({
      kind: "utility-process-fork",
      channel: null,
      argument_shapes: args.map((value) => shape(value)),
      result_shape: null,
      process_type: "utility",
      error: false,
    });
    if (child && typeof child.postMessage === "function") {
      const postMessage = child.postMessage.bind(child);
      child.postMessage = (...messageArgs) => {
        record({
          kind: "utility-process-message",
          channel: null,
          argument_shapes: messageArgs.map((value) => shape(value)),
          result_shape: null,
          process_type: "utility",
          error: false,
        });
        return postMessage(...messageArgs);
      };
    }
    return child;
  };
};

try {
  const { ipcMain, utilityProcess } = require("electron");
  patchIpcMain(ipcMain);
  patchUtilityProcess(utilityProcess);
} catch {
  globalThis.__reaElectronActiveHookError = true;
}

globalThis.__reaElectronActiveSnapshot = () => ({
  events: events.slice(),
  observed,
  truncated,
  hook_error: globalThis.__reaElectronActiveHookError === true,
});
