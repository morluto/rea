import type { DesktopCaptureProvider } from "../ports/DesktopApplicationSession.js";
import {
  runDesktopSession,
  runningApplicationWindows,
} from "./DesktopApplicationSession.js";
import { DesktopContentStore } from "./DesktopContentStore.js";
import { walkHomeState } from "./HomeStateWalker.js";
import { inspectLinuxApplication } from "./LinuxApplicationInventory.js";
import { resolveProgram } from "./ProgramLookup.js";
import { X11WindowObserver } from "./X11WindowObserver.js";

/**
 * The desktop provider's implementation of the capture port: `xprop` window
 * observation, the supervised session runner, the home-folder walker and the
 * content-addressed store under the capture directory.
 */
export const createDesktopCaptureProvider = (): DesktopCaptureProvider => ({
  resolveProgram,
  inspectApplication: (request, signal) =>
    inspectLinuxApplication(request, signal),
  observeWindows: (xprop, environment) =>
    new X11WindowObserver(xprop, environment),
  runningApplicationWindows,
  runSession: runDesktopSession,
  walkHome: walkHomeState,
  openContentStore: async (directory, maxFileBytes, maxContentBytes) => {
    const store = new DesktopContentStore(
      directory,
      maxFileBytes,
      maxContentBytes,
    );
    await store.prepare();
    return store;
  },
});
