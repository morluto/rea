import {
  launchCommand,
  type DesktopAppExportPlan,
} from "../../domain/desktop/appExport.js";
import { electronLaunchArguments } from "../../domain/desktop/appExportInstall.js";
import type { DesktopApplicationCapture } from "../../domain/desktop/desktopCapture.js";
import {
  versionAt,
  type DesktopApplicationState,
} from "../../domain/desktop/desktopState.js";
import { isWithinAny } from "../../domain/desktop/desktopStateDiff.js";
import { openSeedDocument } from "../../domain/desktop/seedDocument.js";
import { isTextualFormat } from "../../domain/desktop/stateFormats.js";
import type { SeedVersion } from "./DesktopExportFiles.js";

type StatePath = DesktopApplicationState["paths"][number];

/**
 * The owned files present at the seed with their digests, and those read as
 * text, but for the lock files `isLeftOutLock` names, which the app holds
 * while it runs: a copied one makes the app find its profile or document in
 * use, so those are left out.
 */
export const seedVersions = (
  files: ReadonlyMap<string, StatePath>,
  paths: readonly string[],
  seed: number,
  isLeftOutLock: (home: string) => boolean,
): {
  readonly seeds: ReadonlyMap<string, SeedVersion>;
  readonly textSeeds: readonly string[];
  readonly locks: readonly string[];
} => {
  const seeds = new Map<string, SeedVersion>();
  const textSeeds: string[] = [];
  const locks: string[] = [];
  for (const [home, path] of files) {
    const version = versionAt(path, seed);
    if (!isWithinAny(home, paths) || version?.present !== true) continue;
    if (isLeftOutLock(home)) locks.push(home);
    else if (version.sha256 !== null) {
      seeds.set(home, { sha256: version.sha256, format: version.format });
      if (isTextualFormat(version.format)) textSeeds.push(home);
    }
  }
  return { seeds, textSeeds: textSeeds.sort(), locks: locks.sort() };
};

/** The launch command, opening the seed's one document when the app takes files. */
export const planLaunch = (
  { application, host }: DesktopApplicationCapture,
  electron: boolean,
  seeds: ReadonlyMap<string, SeedVersion>,
  files: ReadonlyMap<string, StatePath>,
): Pick<DesktopAppExportPlan, "command" | "opens"> => {
  const isDocument = (home: string) => files.get(home)?.role === "document";
  const launch = openSeedDocument(
    electronLaunchArguments(application.argv, electron),
    {
      home: host.home,
      workingDirectory: application.working_directory,
      exec: application.desktop_entry?.exec ?? null,
      documents: [...seeds.keys()].filter(isDocument).sort(),
      isDocument,
    },
  );
  return {
    command: launchCommand(
      launch.argv,
      host.home,
      application.working_directory,
    ),
    opens: launch.opens,
  };
};
