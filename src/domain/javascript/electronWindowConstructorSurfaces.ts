import type { ElectronWindowConstructor } from "./electronStaticAnalysisTypes.js";

/**
 * Electron modules that build a window-like `webContents` surface and the
 * surfaces each one exposes. One table so the construction inspector and the
 * scoped-IPC receiver resolver cannot disagree about which constructors carry
 * a preference, preload or `webContents` surface.
 */
export interface ElectronWindowConstructorSurface {
  /** The constructor accepts `webPreferences` in its options object. */
  readonly preferences: boolean;
  /** The instance owns `webContents`, and so `webContents.ipc`, directly. */
  readonly webContents: boolean;
  /** The instance exposes `loadFile`/`loadURL` on itself, not via contents. */
  readonly selfLoad: boolean;
}

export const ELECTRON_WINDOW_CONSTRUCTOR_SURFACES: Readonly<
  Record<ElectronWindowConstructor, ElectronWindowConstructorSurface>
> = {
  // A BrowserWindow is created with its own contents and preferences.
  BrowserWindow: { preferences: true, webContents: true, selfLoad: true },
  // BaseWindow owns native frame geometry; its contents live in separately
  // attached WebContentsViews, so it accepts no webPreferences and exposes no
  // webContents of its own.
  BaseWindow: { preferences: false, webContents: false, selfLoad: false },
  // A BrowserView is constructed with webPreferences and owns its webContents.
  BrowserView: { preferences: true, webContents: true, selfLoad: false },
  // A WebContentsView accepts preferences or an explicitly adopted webContents.
  WebContentsView: { preferences: true, webContents: true, selfLoad: false },
};

const CONSTRUCTOR_NAMES: ReadonlySet<string> = new Set(
  Object.keys(ELECTRON_WINDOW_CONSTRUCTOR_SURFACES),
);

/** Narrow an Electron export path segment to a modeled window constructor. */
export const electronWindowConstructor = (
  name: string,
): ElectronWindowConstructor | undefined =>
  CONSTRUCTOR_NAMES.has(name) ? (name as ElectronWindowConstructor) : undefined;
