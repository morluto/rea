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
 * uncompressed text, which boot respells as UTF-8, but for those `isLeftOut`
 * names: lock files the app holds while it runs, since a copied one makes it
 * find its profile or document in use, and its logs, which record facts about
 * the capture host.
 */
export const seedVersions = (
  files: ReadonlyMap<string, StatePath>,
  paths: readonly string[],
  seed: number,
  isLeftOut: (home: string) => boolean,
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
    if (isLeftOut(home)) locks.push(home);
    else if (version.sha256 !== null) {
      seeds.set(home, { sha256: version.sha256, format: version.format });
      if (isTextualFormat(version.format) && version.compression === undefined)
        textSeeds.push(home);
    }
  }
  return { seeds, textSeeds: textSeeds.sort(), locks: locks.sort() };
};

/**
 * Each seed file's permission bits at the seed, from the last change the
 * capture recorded at or before it, or else the state the first later change
 * started from, but for the 0644 a written file gets anyway. A file the
 * capture saw no change to has no recorded mode.
 */
export const seedModes = (
  capture: DesktopApplicationCapture,
  seeds: ReadonlyMap<string, SeedVersion>,
  files: ReadonlyMap<string, StatePath>,
  seed: number,
): Readonly<Record<string, number>> => {
  const modes = new Map<string, number | null>();
  capture.state.checkpoints.forEach(({ changes }, index) => {
    for (const { path, before, after } of changes)
      if (index <= seed) modes.set(path, after?.mode ?? null);
      else if (!modes.has(path)) modes.set(path, before?.mode ?? null);
  });
  return Object.fromEntries(
    [...seeds.keys()].sort().flatMap((home) => {
      const mode = modes.get(files.get(home)?.path ?? "");
      return mode === undefined || mode === null || (mode & 0o777) === 0o644
        ? []
        : [[home, mode & 0o777] as const];
    }),
  );
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
  const known = [...captured];
  // A settings folder between a selected root and a captured file is a path
  // too. An option value that merely resolves under the home is not.
  return (path) =>
    captured.has(path) || known.some((file) => isWithinAny(file, [path]));
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
