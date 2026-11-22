import { WindowsShortcutService } from "../../application/binaryDiagnostics/WindowsShortcutService.js";
import { WindowsShortcutProvider } from "../../native/windows/WindowsShortcutProvider.js";

/** Portable Shell Link inspection with no COM, engine or target resolution. */
export const createWindowsShortcutService = (): WindowsShortcutService =>
  new WindowsShortcutService(new WindowsShortcutProvider());
