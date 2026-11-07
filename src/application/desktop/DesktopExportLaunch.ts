import {
  capturedHomePath,
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
 * uncompressed text, which boot respells as UTF-8, but for the lock files
 * `isLeftOutLock` names, which the app holds while it runs: a copied one makes
 * the app find its profile or document in use, so those are left out.
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
      if (isTextualFormat(version.format) && version.compression === undefined)
        textSeeds.push(home);
    }
  }
  return { seeds, textSeeds: textSeeds.sort(), locks: locks.sort() };
};

/** Home paths of captured files and of settings directories, in either spelling. */
const capturedLaunchPaths = (
  capture: DesktopApplicationCapture,
  files: ReadonlyMap<string, StatePath>,
  homeOf: (path: string) => string | null,
): ((path: string) => boolean) => {
  const { home } = capture.host;
  const captured = new Set<string>(files.keys());
  const remember = (absolute: string) => {
    if (!absolute.startsWith(`${home}/`)) return;
    const relative = absolute.slice(home.length + 1);
    captured.add(relative);
    const spelled = homeOf(absolute);
    if (spelled !== null) captured.add(spelled);
  };
  for (const entry of capture.application.state_directories)
    remember(entry.path);
  for (const directory of capture.state.state_directories ?? [])
    remember(directory);
  for (const selected of capture.state.selected_paths ?? []) {
    remember(selected.path);
    remember(selected.physical);
  }
  for (const file of files.values()) remember(file.path);
  return (path) => captured.has(path);
};

/** The launch command, opening the seed's one document when the app takes files. */
export const planLaunch = (
  capture: DesktopApplicationCapture,
  electron: boolean,
  seeds: ReadonlyMap<string, SeedVersion>,
  files: ReadonlyMap<string, StatePath>,
): Pick<DesktopAppExportPlan, "command" | "opens"> => {
  const { application, host } = capture;
  const isDocument = (home: string) => files.get(home)?.role === "document";
  const homeOf = capturedHomePath(capture);
  const capturedDirectory = application.working_directory;
  const workingDirectory = (() => {
    if (!capturedDirectory.startsWith(`${host.home}/`))
      return capturedDirectory;
    const relative = capturedDirectory.slice(host.home.length + 1);
    const seed = homeOf(capturedDirectory) ?? relative;
    return seed === relative ? capturedDirectory : `${host.home}/${seed}`;
  })();
  const launch = openSeedDocument(
    electronLaunchArguments(application.argv, electron),
    {
      home: host.home,
      // Resolve captured relative arguments against the directory the app used,
      // then place the process in the seeded spelling of that directory.
      workingDirectory: capturedDirectory,
      launchDirectory: workingDirectory,
      exec: application.desktop_entry?.exec ?? null,
      documents: [...seeds.keys()].filter(isDocument).sort(),
      isDocument,
      isCaptured: capturedLaunchPaths(capture, files, homeOf),
      spell: (path) => homeOf(`${host.home}/${path}`) ?? path,
    },
  );
  return {
    command: launchCommand(launch.argv, host.home, workingDirectory),
    opens: launch.opens,
  };
};
