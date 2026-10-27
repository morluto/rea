import { isAbsolute } from "node:path";
import { appendCallerPath } from "../filesystem/callerPath.js";

/** Per-user cache directory that REA owns for Kuna on this host. */
export const defaultKunaCacheDirectory = (
  home: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): string => {
  if (platform === "darwin")
    return appendCallerPath(home, "Library/Caches/rea/kuna", platform);
  const xdg = environment.XDG_CACHE_HOME;
  const root =
    xdg !== undefined && isAbsolute(xdg)
      ? xdg
      : appendCallerPath(home, ".cache", platform);
  return appendCallerPath(root, "rea/kuna", platform);
};
