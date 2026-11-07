import {
  INSTALL_SCRIPT,
  type ExportAptSource,
  type ExportPackageFile,
} from "./appExportInstall.js";
import {
  PYTHON_DATA_HOOKS,
  PYTHON_HELPERS,
  PYTHON_IMPORTS,
  PYTHON_MODULE_NAMES,
  PYTHON_READY_CHECK,
} from "./appExportPython.js";
import {
  leftOutFiles,
  unownedReadmeNotes,
  type RuntimeSeeds,
} from "./appExportUnowned.js";
import type { DesktopApplicationCapture } from "./desktopCapture.js";
import type { DesktopApplicationState } from "./desktopState.js";
import { isWithinAny } from "./desktopStateDiff.js";
import { SQLITE_SIDECARS } from "./stateFormats.js";
import { SEED_HOME } from "./hostIdentity.js";
import type { LaunchDocument } from "./seedDocument.js";
import { roleFacts, stateDirectoryOf } from "./stateRoles.js";

/** agentenv-framework release the exported class was checked against. */
export const DESKTOP_EXPORT_FRAMEWORK_VERSION = "0.9.1431";

/** Everything the export renders, decided from a capture and its state view. */
export interface DesktopAppExportPlan {
  /** Environment and folder name. */
  readonly name: string;
  readonly className: string;
  readonly title: string;
  readonly aptPackage: string;
  /** The vendor release the package is taken from; null to install it by name. */
  readonly aptRelease: string | null;
  readonly packageVersion: string | null;
  /** Packages of the libraries the executable loads, installed after the app's own. */
  readonly libraryPackages: readonly string[];
  /** Vendor repositories to install from; empty for the Ubuntu archive. */
  readonly aptSources: readonly ExportAptSource[];
  /** The Debian architectures the app supports. */
  readonly architectures: readonly string[];
  /** The package file downloaded and installed in place of the app's apt package; null when apt installs it. */
  readonly packageFile: ExportPackageFile | null;
  /** The package of the program the desktop entry runs, installed by name after the app's; absent when the app's package owns it. */
  readonly executablePackage?: string;
  /** Packages installed beside the app because the export was asked for them; absent when none. */
  readonly extraPackages?: readonly string[];
  /** Whether the app is Electron, whose launch then runs without Chromium's sandbox. */
  readonly electron: boolean;
  readonly command: readonly string[];
  /** What the launch opens: the seed's one document, a file the captured command names, or nothing. */
  readonly opens: LaunchDocument;
  readonly windowClass: string;
  /** Home-relative paths the app owns for data add, get and reset. */
  readonly paths: readonly string[];
  readonly capturedHome: string;
  /** The checkpoint whose state the seed holds. */
  readonly seedCheckpoint: string;
  /** Whether the seed was made for the task, as in a build computer, rather than taken from the user's own data. */
  readonly syntheticSeed: boolean;
  /** Home-relative files copied into the computer's home before the first launch. */
  readonly seedFiles: readonly string[];
  /** Seed files read as text, which get the seed's home path respelled. */
  readonly textSeeds: readonly string[];
  /** Seed files' permission bits at the seed where the capture recorded them and they are not the 0644 a written file gets. */
  readonly seedModes: Readonly<Record<string, number>>;
  /** Files under the owned paths that existed before the capture but whose bytes were not retained. */
  readonly unseededFiles: readonly string[];
  /** Lock files under the owned paths at the seed, left out of it so a stale one cannot keep the app from starting. */
  readonly leftOutLocks: readonly string[];
  /** The app's logs in its own state, left out of the seed since they record facts about the capture host. */
  readonly leftOutLogs: readonly string[];
  /** Folders under the home where files changed during the capture that the bundle neither owns nor seeds. */
  readonly unownedFolders: readonly string[];
  /** Seed files the app keeps for its own running: web engine storage and caches. */
  readonly runtimeSeeds: readonly RuntimeSeeds[];
  /** `dconf dump` key file of the application's groups at the seed, or empty. */
  readonly dconf: string;
  readonly captureEvidenceId: string;
}

/** A reverse-DNS id, such as `org.xfce.mousepad`, whose last part names the app. */
const REVERSE_DNS = /^[a-z][\w-]*(?:\.[a-z][\w-]*)+\.([^.]+)$/iu;
/** A version at the end of another id, such as `-3.0` in `glabels-3.0`. */
const TRAILING_VERSION = /(?<=.)[-_]\d+(?:\.\d+)*$/u;

/**
 * A lowercase environment name from a desktop entry id or program: a
 * reverse-DNS id's last part, or else the whole id without a trailing
 * version; prefixed `app-` when the name check refuses it.
 */
export const environmentName = (
  source: string,
  accepted: (name: string) => boolean,
): string => {
  const name =
    (REVERSE_DNS.exec(source)?.[1] ?? source.replace(TRAILING_VERSION, ""))
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+/u, "")
      .slice(0, 48)
      .replace(/-+$/u, "") || "app";
  return accepted(name) ? name : `app-${name}`;
};

/** Names a class cannot take: Python's capitalized keywords and the module's own names. */
const TAKEN_NAMES = new Set(["None", "True", "False", ...PYTHON_MODULE_NAMES]);

/** A Python class name for the environment. */
export const className = (name: string): string => {
  const candidate =
    name
      .split("-")
      .map((part) =>
        part.length === 0 ? "" : `${part[0]?.toUpperCase()}${part.slice(1)}`,
      )
      .join("")
      .replace(/^(?=\d)/u, "App") || "App";
  return TAKEN_NAMES.has(candidate) ? `${candidate}App` : candidate;
};

/** The class module's file; the framework imports it under its stem, which must not shadow another module. */
export const appModuleFile = (name: string): string =>
  `${name.replaceAll("-", "_")}_app.py`;

/** Home folders other applications keep files in too, so an app never owns one whole. */
const SHARED_FOLDERS = new Set([
  "",
  ".config",
  ".local",
  ".local/share",
  ".local/state",
  ".cache",
]);

/**
 * The paths the app owns: the state directory holding each state file, in
 * the file's letter case, or a document's folder; a file directly in the home
 * or a shared folder is owned as itself. Nested paths collapse into the
 * outermost one.
 */
export const ownedPaths = (
  stateFiles: readonly string[],
  documents: readonly string[],
  stateDirectories: readonly string[],
): readonly string[] => {
  const folders = new Set<string>();
  const owner = (file: string, folder: string) =>
    SHARED_FOLDERS.has(folder) ? file : folder;
  const folderOf = (file: string) => file.split("/").slice(0, -1).join("/");
  for (const file of stateFiles)
    folders.add(
      owner(file, stateDirectoryOf(file, stateDirectories) ?? folderOf(file)),
    );
  for (const file of documents) folders.add(owner(file, folderOf(file)));
  const sorted = [...folders].filter((folder) => folder.length > 0).sort();
  return sorted.filter(
    (folder) =>
      !sorted.some((other) => other !== folder && isWithinAny(folder, [other])),
  );
};

/** A captured path's home-relative path, in the innermost walked state directory's own spelling unless that leaves the home. */
export const capturedHomePath = (
  capture: DesktopApplicationCapture,
): ((path: string) => string | null) => {
  const { home } = capture.host;
  const relative = (path: string) =>
    path.startsWith(`${home}/`) ? path.slice(home.length + 1) : null;
  const logical = capture.application.state_directories;
  const walked = capture.state.state_directories ?? [];
  // The capture records one walked spelling per state directory, in order; lists of other lengths cannot be paired.
  const renamed = (walked.length === logical.length ? walked : [])
    .flatMap((physical, index) => {
      const path = logical[index]?.path;
      return path === undefined || path === physical
        ? []
        : [{ physical, logical: path }];
    })
    .sort((left, right) => right.physical.length - left.physical.length);
  const selections = [...(capture.state.selected_paths ?? [])];
  // The longest physical path wins, whether it is a selected link or a walked
  // settings folder. A broad selection of ~/settings must not hide
  // ~/.config/notes when that folder was walked at ~/settings/notes.
  const spellings = [
    ...selections.map(({ physical, path: logical }) => ({ physical, logical })),
    ...renamed,
    ...selections.flatMap((selection) =>
      SQLITE_SIDECARS.map(({ suffix }) => ({
        physical: `${selection.physical}${suffix}`,
        logical: `${selection.path}${suffix}`,
      })),
    ),
  ].sort((left, right) => right.physical.length - left.physical.length);
  return (path) => {
    for (const { physical, logical } of spellings) {
      if (!isWithinAny(path, [physical])) continue;
      const spelled = relative(`${logical}${path.slice(physical.length)}`);
      if (spelled !== null) return spelled;
    }
    return relative(path);
  };
};

type StatePath = DesktopApplicationState["paths"][number];

/** A state view file left out because another has the same home path. */
export interface HomePathCollision {
  readonly home: string;
  readonly kept: string;
  readonly dropped: string;
}

/**
 * The state view's files by home path, and its dconf databases apart, which
 * no file of the bundle holds; of files sharing one, the first present before
 * the capture is kept.
 */
export const stateFilesByHomePath = (
  paths: readonly StatePath[],
  homePath: (path: string) => string | null,
): {
  readonly files: ReadonlyMap<string, StatePath>;
  readonly dconf: ReadonlyMap<string, StatePath>;
  readonly collisions: readonly HomePathCollision[];
} => {
  const absent = (path: StatePath) =>
    path.versions[0]?.present === true ? 0 : 1;
  const files = new Map<string, StatePath>();
  const dconf = new Map<string, StatePath>();
  const collisions: HomePathCollision[] = [];
  for (const path of [...paths].sort(
    (left, right) => absent(left) - absent(right),
  )) {
    const home = homePath(path.path);
    if (home === null) continue;
    if (path.format === "dconf") {
      dconf.set(home, path);
      continue;
    }
    const kept = files.get(home);
    if (kept === undefined) files.set(home, path);
    else collisions.push({ home, kept: kept.path, dropped: path.path });
  }
  return { files, dconf, collisions };
};

/**
 * The state view's files and dconf databases by home path, the paths the app
 * owns, and which home files the seed leaves out as locks the app holds, as
 * the export decides them. A document or a file under a selected path is
 * seeded, except a lock beside its file, which stays out unless that lock
 * was the selected path.
 */
export const exportedStateFiles = (
  capture: DesktopApplicationCapture,
  state: DesktopApplicationState,
) => {
  const homePath = capturedHomePath(capture);
  const homePaths = (paths: readonly string[]) =>
    paths.map(homePath).filter((path): path is string => path !== null);
  const { files, dconf, collisions } = stateFilesByHomePath(
    state.paths,
    homePath,
  );
  const withRole = (role: string) =>
    [...files].filter(([, path]) => path.role === role).map(([home]) => home);
  const stateDirectories = homePaths([
    ...capture.application.state_directories.map((entry) => entry.path),
    ...(capture.state.state_directories ?? []),
  ]);
  const selected = homePaths(roleFacts(capture).selectedRoots);
  const usersOwn = [...withRole("document"), ...selected];
  const leftOut = leftOutFiles(files, stateDirectories, usersOwn, selected);
  // A lock or log directly in the home or a shared folder must not own that path, as Poedit's `~/poedit.lock` would. One inside the app's own folder still marks the folder, so settings beside the log stay seeded.
  const marksFolder = (home: string) => {
    const folder = home.split("/").slice(0, -1).join("/");
    return !SHARED_FOLDERS.has(folder);
  };
  const paths = ownedPaths(
    withRole("application_state").filter(
      (home) => !leftOut.isLeftOut(home) || marksFolder(home),
    ),
    withRole("document"),
    stateDirectories,
  );
  return { homePath, files, dconf, collisions, paths, ...leftOut };
};

/** Text safe inside a Python triple-quoted docstring. */
const docText = (value: string): string => value.replace(/["\\]/gu, "'");

/** A value as one single-quoted shell word. */
export const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`;

/**
 * The launch command for the computer, through `sh -c` since the declared
 * command is not expanded by a shell. It starts in the captured working
 * directory, which the framework would otherwise replace with the app's own
 * folder, where an open or save dialog would show build files. That
 * directory, arguments that are or start with a path under the captured home,
 * and `<option>=<path>` values that do, are respelled under the computer
 * user's `$HOME`.
 */
export const launchCommand = (
  argv: readonly string[],
  capturedHome: string,
  workingDirectory: string,
): readonly string[] => {
  const underHome = (path: string) =>
    path === capturedHome
      ? `"$HOME"`
      : path.startsWith(`${capturedHome}/`)
        ? `"$HOME"/${shellQuote(path.slice(capturedHome.length + 1))}`
        : undefined;
  const respell = (argument: string) => {
    const equals = argument.indexOf("=");
    const value =
      equals > 0 ? underHome(argument.slice(equals + 1)) : undefined;
    return (
      underHome(argument) ??
      (value === undefined
        ? undefined
        : `${shellQuote(argument.slice(0, equals + 1))}${value}`)
    );
  };
  const respelled = argv.map(respell);
  const command = `exec ${argv.map((argument, index) => respelled[index] ?? shellQuote(argument)).join(" ")}`;
  const directory = underHome(workingDirectory) ?? shellQuote(workingDirectory);
  // A missing working directory must not stop the boot.
  return ["sh", "-c", `cd ${directory} 2>/dev/null; ${command}`];
};

/** A Python string literal; JSON escapes are valid Python escapes. */
export const py = (value: string): string => JSON.stringify(value);
export const pyList = (values: readonly string[]): string =>
  `[${values.map(py).join(", ")}]`;

/** The bundle's env.toml: a computer app deployed alone on the X11 base. */
export const renderEnvToml = (
  plan: Pick<DesktopAppExportPlan, "name" | "className">,
): string =>
  [
    `type = "computer_app"`,
    `module = ${py(`${appModuleFile(plan.name)}:${plan.className}`)}`,
    `computer = "ubuntu-24.04"`,
    `driver = "reference"`,
    "",
  ].join("\n");

/** The class body: data hooks only for owned paths, and captured settings either way. */
const classBody = (plan: DesktopAppExportPlan): string => {
  const title = docText(plan.title);
  if (plan.paths.length > 0)
    return `    """${title}, launched at boot with the captured state in its home.

    Declaring data hooks switches off agentenv's default data plane, so these call its helpers: the seed is kept as
    the initial state, reset restores it, add writes files under PATHS, and get returns those files plus a typed JSON
    view of each.
    """

    def __init__(self) -> None:
        super().__init__()
        if not INITIAL.exists():
            _seed_home(Path.home())
            _load_dconf(Path.home())
        keep_initial(self.paths)
${PYTHON_DATA_HOOKS}${PYTHON_READY_CHECK}`;
  if (plan.dconf.length > 0)
    return `    """${title}, launched at boot with its captured settings. It owns no files, so it serves no data operations."""

    def __init__(self) -> None:
        super().__init__()
        _load_dconf(Path.home())
${PYTHON_READY_CHECK}`;
  return `    """${title}, launched at boot. No state was observed, so it serves no data operations."""\n${PYTHON_READY_CHECK}`;
};

/** The package as apt takes it: `name`, or `name/release` for a vendor release. */
const installName = (plan: DesktopAppExportPlan): string =>
  plan.aptRelease === null
    ? plan.aptPackage
    : `${plan.aptPackage}/${plan.aptRelease}`;

/** The app's package, or a package file's dependencies, then the extra packages, its program's package, its library packages and dconf-cli when settings are loaded. */
const aptPackages = (plan: DesktopAppExportPlan): readonly string[] => [
  ...new Set([
    ...(plan.packageFile?.dependencies ?? [installName(plan)]),
    ...(plan.extraPackages ?? []),
    ...(plan.executablePackage === undefined ? [] : [plan.executablePackage]),
    ...plan.libraryPackages,
    ...(plan.dconf.length === 0 ? [] : ["dconf-cli"]),
  ]),
];

/** The decorator's `sources=` line for vendor repositories, or nothing for the archive. */
export const aptSources = (
  plan: Pick<DesktopAppExportPlan, "aptSources">,
): string =>
  plan.aptSources.length === 0
    ? ""
    : `\n    sources=[${plan.aptSources
        .map(
          (source) =>
            `AptSource(apt=${py(source.uri)}, suite=${py(source.suite)}, components=${pyList(source.components)}, key=${py(source.keyFile)})`,
        )
        .join(", ")}],`;

/** A package file is downloaded when the bundle is put and installed by the run script once the apt packages are in. */
const packageFileInstall = ({ packageFile: file }: DesktopAppExportPlan) =>
  file === null
    ? ""
    : `\n    downloads=[Download(url=${py(file.url)}, sha256=${py(file.sha256)}, to=${py(file.path)}, arch=${py(file.architecture)})],\n    run=[RunScript(script=${py(INSTALL_SCRIPT)})],`;

/** The run script: agentenv runs it as root from the app's folder, with the network off, after the apt packages and the download are in. */
export const renderInstallScript = (file: ExportPackageFile): string =>
  [
    "#!/bin/sh",
    "set -eu",
    `dpkg -i ${shellQuote(file.path)}`,
    `rm -f ${shellQuote(file.path)}`,
    "",
  ].join("\n");

/** How the class and README say where the seed came from: made for the task, or the user's own data, kept local. */
export const seedWording = ({
  name,
  seedCheckpoint,
  syntheticSeed,
}: Pick<DesktopAppExportPlan, "name" | "seedCheckpoint" | "syntheticSeed">) =>
  syntheticSeed
    ? {
        docstring: `The seed was made for the task, as saved at checkpoint ${docText(seedCheckpoint)}.`,
        origin: `made for the task, as saved at checkpoint \`${seedCheckpoint}\``,
        notice: `The seed was made for this task, not taken from a user's own data; read \`envs/${name}/seed/\` before publishing the bundle.`,
      }
    : {
        docstring: `The seed is the user's state at checkpoint ${docText(seedCheckpoint)}: keep this bundle local.`,
        origin: `from the user's home at checkpoint \`${seedCheckpoint}\``,
        notice:
          "The seed is the user's real data. Keep this bundle local; do not publish it.",
      };

/** The computer app class: install, launch, owned paths, seed and data hooks. */
export const renderAppClass = (plan: DesktopAppExportPlan): string => {
  const hooks = classBody(plan);
  return `"""${docText(plan.title)} as an agentenv computer app, exported by REA from a desktop application capture.

Package: ${plan.aptPackage}${plan.packageVersion === null ? "" : ` (captured at ${plan.packageVersion})`}. Capture Evidence: ${plan.captureEvidenceId}.
${seedWording(plan).docstring}
"""

${PYTHON_IMPORTS}
HERE = Path(__file__).resolve().parent
SEED_HOME = ${py(SEED_HOME)}
PATHS = ${pyList(plan.paths)}
DCONF = ${py(plan.dconf)}
TEXT_SEEDS = frozenset(${pyList(plan.textSeeds)})
SEED_MODES = {${Object.entries(plan.seedModes)
    .map(([home, mode]) => `${py(home)}: 0o${mode.toString(8)}`)
    .join(", ")}}
WINDOW_CLASS = ${py(plan.windowClass)}
${PYTHON_HELPERS}

@computer_app(supports=[{"os": {"type": "linux", "display": ["x11"]}, "arch": ${pyList(plan.architectures)}}])
@linux(
    packages=Packages(apt=${pyList(aptPackages(plan))}),${aptSources(plan)}${packageFileInstall(plan)}
    launch=Launch(at="boot", command=${pyList(plan.command)}, window={"class": ${py(plan.windowClass)}}, ready=Ready(window=True)),
    paths=PATHS,
    skill="SKILL.md",
)
class ${plan.className}(ComputerAppEnvironment):
${hooks}`;
};

/** The skill an agent reads before using the app. */
export const renderSkill = (plan: DesktopAppExportPlan): string =>
  `---
description: Use ${plan.title} on this Linux desktop; its window has class ${plan.windowClass}.
---

# ${plan.title}

${plan.title} is open on the desktop at boot. Its window's class is \`${plan.windowClass}\`.
${
  plan.paths.length === 0
    ? ""
    : `
Its files live under ${plan.paths.map((path) => `\`~/${path}\``).join(", ")}. Work through the application's own
window and dialogs; the result is read from those files.
`
}`;

const installedFrom = (plan: DesktopAppExportPlan): string =>
  plan.aptSources.length === 0
    ? "the distribution archive"
    : plan.aptSources
        .map(
          (source) =>
            `the apt repository \`${source.uri}\` (suite \`${source.suite}\`${source.components.length === 0 ? "" : `, components \`${source.components.join(" ")}\``}), trusting \`${source.keyFile}\`, the key that verified its release on the capture host`,
        )
        .join(" and ");

/** What the computer installs, and from where. */
const installs = (plan: DesktopAppExportPlan): string =>
  plan.packageFile === null
    ? `\`${installName(plan)}\` from ${installedFrom(plan)}`
    : `\`${plan.aptPackage}\`${plan.packageVersion === null ? "" : ` ${plan.packageVersion}`} from its package file, downloaded from
  \`${plan.packageFile.url}\` when the bundle is put and refused unless its SHA-256 is \`${plan.packageFile.sha256}\``;

const packageFileNotes = ({ packageFile: file }: DesktopAppExportPlan) =>
  file === null
    ? []
    : [
        `- The bundle does not contain the package: \`${INSTALL_SCRIPT}\` installs \`${file.path}\` with dpkg once the apt packages
  it depends on are in${file.dependencies.length === 0 ? "" : ` (${file.dependencies.map((name) => `\`${name}\``).join(", ")})`}, so the computer runs exactly the captured version, on \`${file.architecture}\` only.`,
        "- Vendor sites may refuse automated downloads, so the URL must point at a copy of the file the operator may use.\n  The package's licence, such as a trial's terms, is the operator's to check.",
      ];

const installNotes = (plan: DesktopAppExportPlan): string =>
  [
    ...packageFileNotes(plan),
    ...(plan.extraPackages === undefined
      ? []
      : [
          `- Installed beside the app because the export was asked for them with \`--extra-package\`, as a build computer asks
  for the packages its request named: ${plan.extraPackages.map((name) => `\`${name}\``).join(", ")}.`,
        ]),
    ...(plan.executablePackage === undefined
      ? []
      : [
          `- \`${plan.executablePackage}\`, which owns the program the desktop entry runs, is installed with it.`,
        ]),
    ...(plan.libraryPackages.length === 0
      ? []
      : [
          `- Library packages, which own the shared libraries the executable loaded on the capture host, are installed with it:
  ${plan.libraryPackages.map((name) => `\`${name}\``).join(", ")}.`,
        ]),
    ...(plan.electron
      ? [
          "- Chromium's sandbox is off (`--no-sandbox`): it needs user namespaces the computer's container does not grant,\n  and Electron exits without them.",
        ]
      : []),
  ]
    .map((line) => `\n${line}`)
    .join("");

/** The start of the limitation of a launch that opens no document; its reason follows. */
export const NO_LAUNCH_DOCUMENT = "The app opens no document at launch";

/** The limitation of a launch that opens no document; none when it opens one. */
export const launchDocumentLimitation = (
  opens: LaunchDocument,
): string | undefined =>
  opens.kind === "none"
    ? `${NO_LAUNCH_DOCUMENT}, since ${opens.reason}.`
    : undefined;

/** The README line on what the launch opens; none when the captured command names its own file. */
export const launchDocumentNote = ({
  opens,
}: Pick<DesktopAppExportPlan, "opens">): string =>
  opens.kind === "seed"
    ? `\n- At launch the app opens \`~/${opens.document}\`, the seed's one document.`
    : opens.kind === "none"
      ? `\n- ${launchDocumentLimitation(opens)}`
      : "";

/**
 * Bundle files: seeds the export rewrote to remove the capture host's
 * identity, gzip seeds it compressed again only to clear their headers,
 * files that still hold the identity, and seeds it left LibreOffice's
 * recovery list out of.
 */
export interface SeedScrubReport {
  readonly scrubbed: readonly string[];
  readonly recompressed: readonly string[];
  readonly unscrubbed: readonly string[];
  /** Seeds whose LibreOffice recovery list was left out, as `~/<path>`. */
  readonly recovered?: readonly string[];
}

const homeList = (paths: readonly string[]) =>
  paths.map((path) => `\`~/${path}\``).join(", ");

const bundleList = (paths: readonly string[]) =>
  paths.map((path) => `\`${path}\``).join(", ");

const scrubNotes = ({
  scrubbed,
  recompressed,
  unscrubbed,
  recovered = [],
}: SeedScrubReport): string =>
  [
    ...(scrubbed.length === 0
      ? []
      : [`\n  Rewritten: ${bundleList(scrubbed)}.`]),
    ...(recompressed.length === 0
      ? []
      : [
          `\n  ${String(recompressed.length)} gzip file(s) were compressed again only to clear their headers, their content unchanged.`,
        ]),
    ...(recovered.length === 0
      ? []
      : [
          `\n- LibreOffice's list of the documents it had open, which would start it into document recovery instead of
  its window, is left out of ${bundleList(recovered)}.`,
        ]),
    ...(unscrubbed.length === 0
      ? []
      : [
          `\n- Still holding the capture host's name, user@host or home, in their name or in content REA does not rewrite:
  ${bundleList(unscrubbed)}. Read them before sharing the bundle.`,
        ]),
  ].join("");

/** The bundle README: what was exported, how to run it, and what to keep in mind; a task's section follows. */
export const renderReadme = (
  plan: DesktopAppExportPlan,
  taskSection = "",
  scrub: SeedScrubReport = { scrubbed: [], recompressed: [], unscrubbed: [] },
): string =>
  `# ${plan.title} computer app

Exported by REA's \`export-desktop-application\` from a capture of the \`${plan.aptPackage}\` package
(capture Evidence \`${plan.captureEvidenceId}\`). It was checked against agentenv-framework
${DESKTOP_EXPORT_FRAMEWORK_VERSION}.

- \`envs/${plan.name}/\` is a computer app on the \`ubuntu-24.04\` base with the \`reference\` driver, for
  ${plan.architectures.map((architecture) => `\`${architecture}\``).join(" and ")}. It installs ${installs(plan)}, launches \`${plan.command.join(" ")}\` at boot and is ready
  when a window of class \`${plan.windowClass}\` appears.${installNotes(plan)}${launchDocumentNote(plan)}
- Owned paths: ${plan.paths.length === 0 ? "none" : plan.paths.map((path) => `\`~/${path}\``).join(", ")}.
  \`data/get\` returns their files and a typed JSON view of each; \`data/reset\` restores the seed.
- Seed: ${plan.seedFiles.length} file(s) ${seedWording(plan).origin}${plan.dconf.length === 0 ? "" : ", and the application's dconf keys"}.
  Text files and dconf keys spell the capture host's name as \`localhost\`, \`user@host\` as \`user@localhost\`
  and the home as \`${SEED_HOME}\`, which the computer respells to its own at boot.${scrubNotes(scrub)}${
    plan.unseededFiles.length === 0
      ? ""
      : `
- Not seeded, because the capture did not retain their bytes at the seed: ${homeList(plan.unseededFiles)}.
  Capture again with \`--state-path\` naming them, or a larger \`--max-file-bytes\`, to include them.`
  }${unownedReadmeNotes(plan.unownedFolders, plan.runtimeSeeds, { locks: plan.leftOutLocks, logs: plan.leftOutLogs })}
- \`tasks/smoke.json\` deploys the app.

${taskSection.length === 0 ? "Run it with `agent-env run <this folder>`." : "Run the task with `agent-env run <this folder>`, or only the deploy with `--task smoke`."}

${seedWording(plan).notice}
${plan.dconf.length === 0 ? "" : "dconf keys are compiled into the user's dconf database, with `dconf-cli`, once when the app first starts; `data/reset` does not restore them.\n"}${taskSection}`;

/** A smoke task that deploys the app. */
export const renderSmokeTask = (
  plan: Pick<DesktopAppExportPlan, "name">,
): string =>
  `${JSON.stringify([{ id: "env", type: "deploy_env", env_id: plan.name }], null, 2)}\n`;
