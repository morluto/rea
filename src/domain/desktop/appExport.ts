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
import type { DesktopApplicationCapture } from "./desktopCapture.js";
import type { DesktopApplicationState } from "./desktopState.js";
import { isWithinAny } from "./desktopStateDiff.js";
import { SEED_HOME } from "./hostIdentity.js";
import { stateDirectoryOf } from "./stateRoles.js";

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
  /** Whether the app is Electron, whose launch then runs without Chromium's sandbox. */
  readonly electron: boolean;
  readonly command: readonly string[];
  readonly windowClass: string;
  /** Home-relative paths the app owns for data add, get and reset. */
  readonly paths: readonly string[];
  readonly capturedHome: string;
  /** The checkpoint whose state the seed holds. */
  readonly seedCheckpoint: string;
  /** Home-relative files copied into the computer's home before the first launch. */
  readonly seedFiles: readonly string[];
  /** Seed files read as text, which get the seed's home path respelled. */
  readonly textSeeds: readonly string[];
  /** Files under the owned paths that existed before the capture but whose bytes were not retained. */
  readonly unseededFiles: readonly string[];
  /** `dconf dump` key file of the application's groups at the seed, or empty. */
  readonly dconf: string;
  readonly captureEvidenceId: string;
}

/** A lowercase environment name from a desktop entry id or program, prefixed `app-` when the name check refuses it. */
export const environmentName = (
  source: string,
  accepted: (name: string) => boolean,
): string => {
  const name =
    source
      .split(".")
      .at(-1)
      ?.toLowerCase()
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
  return (path) => {
    const directory = renamed.find(({ physical }) =>
      isWithinAny(path, [physical]),
    );
    const respelled =
      directory === undefined
        ? null
        : relative(
            `${directory.logical}${path.slice(directory.physical.length)}`,
          );
    return respelled ?? relative(path);
  };
};

type StatePath = DesktopApplicationState["paths"][number];

/** A state view file left out because another has the same home path. */
export interface HomePathCollision {
  readonly home: string;
  readonly kept: string;
  readonly dropped: string;
}

/** The state view's files by home path, dconf databases aside; of files sharing one, the first present before the capture is kept. */
export const stateFilesByHomePath = (
  paths: readonly StatePath[],
  homePath: (path: string) => string | null,
): {
  readonly files: ReadonlyMap<string, StatePath>;
  readonly collisions: readonly HomePathCollision[];
} => {
  const absent = (path: StatePath) =>
    path.versions[0]?.present === true ? 0 : 1;
  const files = new Map<string, StatePath>();
  const collisions: HomePathCollision[] = [];
  for (const path of [...paths].sort(
    (left, right) => absent(left) - absent(right),
  )) {
    const home = homePath(path.path);
    if (home === null || path.format === "dconf") continue;
    const kept = files.get(home);
    if (kept === undefined) files.set(home, path);
    else collisions.push({ home, kept: kept.path, dropped: path.path });
  }
  return { files, collisions };
};

/** The state view's files by home path and the paths the app owns, as the export decides them. */
export const exportedStateFiles = (
  capture: DesktopApplicationCapture,
  state: DesktopApplicationState,
) => {
  const homePath = capturedHomePath(capture);
  const { files, collisions } = stateFilesByHomePath(state.paths, homePath);
  const withRole = (role: string) =>
    [...files].filter(([, path]) => path.role === role).map(([home]) => home);
  const paths = ownedPaths(
    withRole("application_state"),
    withRole("document"),
    [
      ...capture.application.state_directories.map((entry) => entry.path),
      ...(capture.state.state_directories ?? []),
    ]
      .map(homePath)
      .filter((path): path is string => path !== null),
  );
  return { homePath, files, collisions, paths };
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

/** The app's package, or a package file's dependencies, then its program's package, its library packages and dconf-cli when settings are loaded. */
const aptPackages = (plan: DesktopAppExportPlan): readonly string[] => [
  ...new Set([
    ...(plan.packageFile?.dependencies ?? [installName(plan)]),
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

/** The computer app class: install, launch, owned paths, seed and data hooks. */
export const renderAppClass = (plan: DesktopAppExportPlan): string => {
  const hooks = classBody(plan);
  return `"""${docText(plan.title)} as an agentenv computer app, exported by REA from a desktop application capture.

Package: ${plan.aptPackage}${plan.packageVersion === null ? "" : ` (captured at ${plan.packageVersion})`}. Capture Evidence: ${plan.captureEvidenceId}.
The seed is the user's state at checkpoint ${docText(plan.seedCheckpoint)}: keep this bundle local.
"""

${PYTHON_IMPORTS}
HERE = Path(__file__).resolve().parent
SEED_HOME = ${py(SEED_HOME)}
PATHS = ${pyList(plan.paths)}
DCONF = ${py(plan.dconf)}
TEXT_SEEDS = frozenset(${pyList(plan.textSeeds)})
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

/** Bundle files: seeds the export rewrote to remove the capture host's identity, and files that still hold it. */
export interface SeedScrubReport {
  readonly scrubbed: readonly string[];
  readonly unscrubbed: readonly string[];
}

const homeList = (paths: readonly string[]) =>
  paths.map((path) => `\`~/${path}\``).join(", ");

const bundleList = (paths: readonly string[]) =>
  paths.map((path) => `\`${path}\``).join(", ");

const scrubNotes = ({ scrubbed, unscrubbed }: SeedScrubReport): string =>
  [
    ...(scrubbed.length === 0
      ? []
      : [`\n  Rewritten: ${bundleList(scrubbed)}.`]),
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
  scrub: SeedScrubReport = { scrubbed: [], unscrubbed: [] },
): string =>
  `# ${plan.title} computer app

Exported by REA's \`export-desktop-application\` from a capture of the \`${plan.aptPackage}\` package
(capture Evidence \`${plan.captureEvidenceId}\`). It was checked against agentenv-framework
${DESKTOP_EXPORT_FRAMEWORK_VERSION}.

- \`envs/${plan.name}/\` is a computer app on the \`ubuntu-24.04\` base with the \`reference\` driver, for
  ${plan.architectures.map((architecture) => `\`${architecture}\``).join(" and ")}. It installs ${installs(plan)}, launches \`${plan.command.join(" ")}\` at boot and is ready
  when a window of class \`${plan.windowClass}\` appears.${installNotes(plan)}
- Owned paths: ${plan.paths.length === 0 ? "none" : plan.paths.map((path) => `\`~/${path}\``).join(", ")}.
  \`data/get\` returns their files and a typed JSON view of each; \`data/reset\` restores the seed.
- Seed: ${plan.seedFiles.length} file(s) from the user's home at checkpoint \`${plan.seedCheckpoint}\`${plan.dconf.length === 0 ? "" : ", and the application's dconf keys"}.
  Text files and dconf keys spell the capture host's name as \`localhost\`, \`user@host\` as \`user@localhost\`
  and the home as \`${SEED_HOME}\`, which the computer respells to its own at boot.${scrubNotes(scrub)}${
    plan.unseededFiles.length === 0
      ? ""
      : `
- Not seeded, because the capture did not retain their bytes at the seed: ${homeList(plan.unseededFiles)}.
  Capture again with \`--state-path\` naming them, or a larger \`--max-file-bytes\`, to include them.`
  }
- \`tasks/smoke.json\` deploys the app.

${taskSection.length === 0 ? "Run it with `agent-env run <this folder>`." : "Run the task with `agent-env run <this folder>`, or only the deploy with `--task smoke`."}

The seed is the user's real data. Keep this bundle local; do not publish it.
${plan.dconf.length === 0 ? "" : "dconf keys are compiled into the user's dconf database, with `dconf-cli`, once when the app first starts; `data/reset` does not restore them.\n"}${taskSection}`;

/** A smoke task that deploys the app. */
export const renderSmokeTask = (
  plan: Pick<DesktopAppExportPlan, "name">,
): string =>
  `${JSON.stringify([{ id: "env", type: "deploy_env", env_id: plan.name }], null, 2)}\n`;
