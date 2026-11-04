import { basename, isAbsolute } from "node:path";

import type { DesktopApplicationInventory } from "../../domain/desktop/desktopCapture.js";
import { isWithinAny } from "../../domain/desktop/desktopStateDiff.js";
import type { WindowMatching } from "../../desktop/DesktopSessionObservations.js";
import { canonicalPath } from "./DesktopCaptureOutput.js";
import type { CheckpointScope } from "./DesktopCheckpointRecorder.js";

const unique = (paths: readonly string[]) => [...new Set(paths)];

/** The checkpoint scope, and absolute arguments too broad to be part of it. */
export interface CaptureScope {
  readonly scope: CheckpointScope;
  /** `/` or a directory containing the home directory, named by `--argument`. */
  readonly broadArguments: readonly string[];
}

/**
 * Paths in their physical spelling, so walks and exclusions agree. An
 * absolute argument becomes a content root unless it is `/` or contains the
 * home directory, which would retain and walk whole trees.
 */
export const captureScope = async (
  request: {
    readonly arguments: readonly string[];
    readonly statePaths: readonly string[];
    readonly excludes: readonly string[];
    readonly maxEntries: number;
  },
  inventory: DesktopApplicationInventory,
  home: string,
  output: string,
): Promise<CaptureScope> => {
  const canonical = (paths: readonly string[]) =>
    Promise.all(paths.map((path) => canonicalPath(path)));
  const stateDirectories = await canonical(
    inventory.state_directories.map((entry) => entry.path),
  );
  const argumentPaths = await canonical(
    request.arguments.filter((value) => isAbsolute(value)),
  );
  const broadArguments = unique(
    argumentPaths.filter((path) => isWithinAny(home, [path])),
  );
  const contentRoots = unique([
    ...stateDirectories,
    ...(await canonical(request.statePaths)),
    ...argumentPaths.filter((path) => !broadArguments.includes(path)),
  ]);
  return {
    scope: {
      roots: unique([
        home,
        ...contentRoots.filter((path) => !isWithinAny(path, [home])),
      ]),
      contentRoots,
      stateDirectories,
      excluded: unique([output, ...(await canonical(request.excludes))]),
      maxEntries: request.maxEntries,
    },
    broadArguments,
  };
};

/**
 * Window names that mark a window as the application's: the entry's
 * `StartupWMClass`, its full id and last id part, the executable's name and a
 * flatpak's application id. A flatpak's window pids are sandbox pids, so its
 * windows are matched by name only.
 */
export const applicationWindowMatching = (
  inventory: DesktopApplicationInventory,
): WindowMatching => {
  const flatpak = inventory.package.kind === "flatpak";
  const executable = basename(inventory.executable.path);
  return {
    names: new Set(
      [
        inventory.desktop_entry?.startup_wm_class,
        flatpak && executable === "flatpak" ? null : executable,
        inventory.desktop_entry?.id,
        inventory.desktop_entry?.id?.split(".").at(-1),
        flatpak ? inventory.package.name : null,
      ]
        .filter(
          (name): name is string => typeof name === "string" && name.length > 0,
        )
        .map((name) => name.toLowerCase()),
    ),
    byPid: !flatpak,
  };
};
