import { isAbsolute, join, posix, resolve, win32 } from "node:path";

import { windowsAppDataRoots } from "./MsixPackageStorage.js";

/**
 * Configuration roots that clients derive from environment variables. Each
 * function reproduces one reader's semantics for empty and relative values,
 * named after the code that owns them, so a client location states which rule
 * it follows instead of re-deriving it.
 */
export interface ClientRootContext {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

/**
 * `XDG_CONFIG_HOME || ~/.config`: an empty value is unset and a relative value
 * is kept, resolving against the reader's working directory. This is the
 * xdg-basedir package (OpenCode, Kilo) and VS Code's `getDefaultUserDataPath`
 * on Linux. Clients that do not document their reader also use it; it is not
 * established for them.
 */
export const xdgConfigHomeOrDefault = ({
  home,
  env,
}: Pick<ClientRootContext, "home" | "env">): string =>
  env.XDG_CONFIG_HOME || join(home, ".config");

/**
 * The XDG Base Directory rule: only an absolute `XDG_CONFIG_HOME` counts;
 * empty and relative values are invalid and fall back to `~/.config`. This is
 * Rust `dirs::config_dir` on Linux (Zed) and etcetera's XDG strategy (Goose).
 */
export const absoluteXdgConfigHome = ({
  home,
  env,
}: Pick<ClientRootContext, "home" | "env">): string => {
  const value = env.XDG_CONFIG_HOME;
  return value !== undefined && posix.isAbsolute(value)
    ? value
    : join(home, ".config");
};

/**
 * VS Code's `getUserDataPath`: non-empty `VSCODE_PORTABLE` selects portable
 * storage, then non-empty `VSCODE_APPDATA`, then the platform default. A
 * relative result resolves against `VSCODE_CWD`. Extensions such as Cline
 * keep their global storage under this directory.
 */
export const vscodeUserDirectory = ({
  home,
  platform,
  env,
}: ClientRootContext): string => {
  const userData = env.VSCODE_PORTABLE
    ? join(env.VSCODE_PORTABLE, "user-data")
    : env.VSCODE_APPDATA
      ? join(env.VSCODE_APPDATA, "Code")
      : platform === "win32"
        ? join(windowsAppDataRoots(home, env).roaming, "Code")
        : platform === "darwin"
          ? join(home, "Library", "Application Support", "Code")
          : join(xdgConfigHomeOrDefault({ home, env }), "Code");
  // The catalog can describe Windows clients on another host; retain its
  // drive-absolute paths instead of resolving them against that host cwd.
  const absoluteUserData =
    platform === "win32" && win32.isAbsolute(userData) && !isAbsolute(userData)
      ? userData
      : isAbsolute(userData)
        ? resolve(userData)
        : resolve(env.VSCODE_CWD || process.cwd(), userData);
  return join(absoluteUserData, "User");
};
