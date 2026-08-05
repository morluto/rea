"use strict";

// oxlint-disable-next-line max-lines-per-function -- all adapters must close over one bounded capture context.
const createElectronActiveBoundaryPatches = ({
  identity,
  patchEmitter,
  processType,
  recordIpc,
  recordRuntime,
  shape,
}) => {
  const patchedSessions = new WeakSet();
  const patchIpcRenderer = (ipcRenderer) => {
    if (ipcRenderer === null || ipcRenderer === undefined) return;
    for (const [method, kind] of [
      ["send", "ipc-renderer-send"],
      ["sendSync", "ipc-renderer-send"],
      ["invoke", "ipc-renderer-invoke"],
      ["postMessage", "ipc-renderer-post-message"],
    ]) {
      const original = ipcRenderer[method];
      if (typeof original !== "function") continue;
      ipcRenderer[method] = function patchedRendererIpc(channel, ...args) {
        const recorded = recordIpc(kind, channel, args, {
          direction: "renderer-to-main",
          sender: processType(),
          receiver: "main",
          frame: null,
          process_type: processType(),
          error: false,
        });
        try {
          const result = original.call(this, channel, ...args);
          if (result !== null && typeof result?.then === "function")
            return result.then(
              (value) => {
                if (recorded !== null) recorded.result_shape = shape(value);
                return value;
              },
              (cause) => {
                if (recorded !== null) recorded.error = true;
                throw cause;
              },
            );
          if (recorded !== null) recorded.result_shape = shape(result);
          return result;
        } catch (cause) {
          if (recorded !== null) recorded.error = true;
          throw cause;
        }
      };
    }
  };

  const patchContextBridge = (contextBridge) => {
    if (contextBridge === null || contextBridge === undefined) return;
    for (const method of ["exposeInMainWorld", "exposeInIsolatedWorld"]) {
      const original = contextBridge[method];
      if (typeof original !== "function") continue;
      contextBridge[method] = function patchedContextBridge(...args) {
        const target = typeof args[0] === "string" ? args[0] : null;
        recordRuntime("preload", "context-bridge-exposure", "attempted", {
          target,
          argument_shapes: args.map((value) => shape(value)),
          process_type: processType(),
        });
        try {
          const result = original.apply(this, args);
          recordRuntime("preload", "context-bridge-exposure", "completed", {
            target,
            process_type: processType(),
          });
          return result;
        } catch (cause) {
          recordRuntime("preload", "context-bridge-exposure", "failed", {
            target,
            error: true,
            process_type: processType(),
          });
          throw cause;
        }
      };
    }
  };

  const patchSession = (session) => {
    if (session === null || session === undefined) return;
    if (
      (typeof session !== "object" && typeof session !== "function") ||
      patchedSessions.has(session)
    )
      return;
    patchedSessions.add(session);
    patchEmitter(session, (event, args) => {
      const kind =
        event === "will-download"
          ? "download"
          : event.includes("certificate") || event.includes("permission")
            ? "permission"
            : event.includes("window") || event.includes("popup")
              ? "popup-attempt"
              : "web-contents-lifecycle";
      if (event === "will-download") {
        const cancel = args[1]?.cancel;
        if (typeof cancel === "function") cancel.call(args[1]);
      }
      recordRuntime(
        kind,
        event,
        event === "will-download" ? "blocked" : "observed",
        {
          target: identity(args[0], "webContents"),
          argument_shapes: args.map((value) => shape(value)),
          error: event === "will-download",
        },
      );
    });
    const originalPermissionRequest = session.setPermissionRequestHandler;
    if (typeof originalPermissionRequest === "function")
      session.setPermissionRequestHandler =
        function blockedPermissionRequest() {
          return originalPermissionRequest.call(
            this,
            (webContents, permission, callback) => {
              recordRuntime("permission", "permission-request", "blocked", {
                target: identity(webContents, "webContents"),
                argument_shapes: [shape(permission)],
                error: true,
              });
              if (typeof callback === "function") callback(false);
            },
          );
        };
    const originalPermissionCheck = session.setPermissionCheckHandler;
    if (typeof originalPermissionCheck === "function")
      session.setPermissionCheckHandler = function blockedPermissionCheck() {
        return originalPermissionCheck.call(this, (webContents, permission) => {
          recordRuntime("permission", "permission-check", "blocked", {
            target: identity(webContents, "webContents"),
            argument_shapes: [shape(permission)],
            error: true,
          });
          return false;
        });
      };
    const originalCertificate = session.setCertificateVerifyProc;
    if (typeof originalCertificate === "function")
      session.setCertificateVerifyProc = function blockedCertificate() {
        return originalCertificate.call(this, (request, callback) => {
          recordRuntime("permission", "certificate-error", "blocked", {
            argument_shapes: [shape(request)],
            error: true,
          });
          if (typeof callback === "function") callback(-2);
        });
      };
  };

  const patchWindowOpenHandler = (webContents, contentsId) => {
    if (webContents === null || webContents === undefined) return;
    const original = webContents.setWindowOpenHandler;
    if (typeof original !== "function") return;
    webContents.setWindowOpenHandler = function blockedWindowOpenHandler(
      handler,
    ) {
      const guarded = (...args) => {
        try {
          if (typeof handler === "function") handler(...args);
        } catch {
          recordRuntime("popup-attempt", "window-open-handler", "failed", {
            target: contentsId,
            argument_shapes: args.map((value) => shape(value)),
            error: true,
          });
          return { action: "deny" };
        }
        recordRuntime("popup-attempt", "window-open-handler", "blocked", {
          target: contentsId,
          argument_shapes: args.map((value) => shape(value)),
          error: true,
        });
        return { action: "deny" };
      };
      return original.call(this, guarded);
    };
  };

  const patchSessionManager = (sessionModule) => {
    if (sessionModule === null || sessionModule === undefined) return;
    patchSession(sessionModule.defaultSession);
    for (const method of ["fromPartition", "fromPath"]) {
      const original = sessionModule[method];
      if (typeof original !== "function") continue;
      sessionModule[method] = function patchedSessionFactory(...args) {
        const session = original.apply(this, args);
        patchSession(session);
        return session;
      };
    }
  };

  const patchApplicationEffects = (app) => {
    if (app === null || app === undefined) return;
    for (const method of [
      "relaunch",
      "setAsDefaultProtocolClient",
      "setLoginItemSettings",
    ]) {
      const original = app[method];
      if (typeof original !== "function") continue;
      app[method] = function blockedApplicationEffect(...args) {
        recordRuntime(
          method === "relaunch" ? "updater" : "protocol",
          method,
          "blocked",
          { argument_shapes: args.map((value) => shape(value)), error: true },
        );
        return method === "setAsDefaultProtocolClient" ? false : undefined;
      };
    }
  };

  const patchNativeAddonLoading = () => {
    const original = process.dlopen;
    if (typeof original !== "function") return;
    process.dlopen = function patchedDlopen(module, filename, ...args) {
      let digest = null;
      try {
        const fs = require("node:fs");
        const crypto = require("node:crypto");
        const stat = fs.statSync(filename);
        if (stat.isFile() && stat.size <= 16 * 1024 * 1024)
          digest = crypto
            .createHash("sha256")
            .update(fs.readFileSync(filename))
            .digest("hex");
      } catch {
        digest = null;
      }
      recordRuntime("native-addon", "dlopen", "attempted", {
        artifact_path: typeof filename === "string" ? filename : null,
        artifact_sha256: digest,
        argument_shapes: [
          shape(module),
          shape(filename),
          ...args.map((value) => shape(value)),
        ],
      });
      try {
        const result = original.call(this, module, filename, ...args);
        recordRuntime("native-addon", "dlopen", "completed", {
          artifact_path: typeof filename === "string" ? filename : null,
          artifact_sha256: digest,
        });
        return result;
      } catch (cause) {
        recordRuntime("native-addon", "dlopen", "failed", {
          artifact_path: typeof filename === "string" ? filename : null,
          artifact_sha256: digest,
          error: true,
        });
        throw cause;
      }
    };
  };

  const patchUtilityProcess = (utilityProcess) => {
    if (utilityProcess === null || utilityProcess === undefined) return;
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
    if (shell === null || shell === undefined) return;
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

  return {
    patchApplicationEffects,
    patchChildProcess,
    patchContextBridge,
    patchIpcRenderer,
    patchNativeAddonLoading,
    patchSession,
    patchSessionManager,
    patchShell,
    patchWindowOpenHandler,
    patchUtilityProcess,
  };
};

module.exports = { createElectronActiveBoundaryPatches };
