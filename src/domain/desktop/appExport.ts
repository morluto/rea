import { isWithinAny } from "./desktopStateDiff.js";

/** agentenv-framework release the exported class was checked against. */
export const DESKTOP_EXPORT_FRAMEWORK_VERSION = "0.9.1431";

/** Everything the export renders, decided from a capture and its state view. */
export interface DesktopAppExportPlan {
  /** Environment and folder name. */
  readonly name: string;
  readonly className: string;
  readonly title: string;
  readonly aptPackage: string;
  readonly packageVersion: string | null;
  readonly command: readonly string[];
  readonly windowClass: string;
  /** Home-relative folders the app owns for data add, get and reset. */
  readonly paths: readonly string[];
  readonly capturedHome: string;
  /** Home-relative files copied into the computer's home before the first launch. */
  readonly seedFiles: readonly string[];
  /** Seed files read as text, which get the captured home path respelled. */
  readonly textSeeds: readonly string[];
  /** Files under the owned paths that existed before the capture but whose bytes were not retained. */
  readonly unseededFiles: readonly string[];
  /** `dconf dump` key file of the application's groups at the baseline, or empty. */
  readonly dconf: string;
  readonly captureEvidenceId: string;
}

/** A lowercase environment name built from a desktop entry id or program. */
export const environmentName = (source: string): string =>
  source
    .split(".")
    .at(-1)
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48) || "app";

/** Capitalized names Python reserves, which a class cannot take. */
const PYTHON_RESERVED = new Set(["None", "True", "False"]);

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
  return PYTHON_RESERVED.has(candidate) ? `${candidate}App` : candidate;
};

/**
 * The folders the app owns: the state directory holding each state file, or
 * a document's folder. Nested folders collapse into the outermost one.
 */
export const ownedPaths = (
  stateFiles: readonly string[],
  documents: readonly string[],
  stateDirectories: readonly string[],
): readonly string[] => {
  const folders = new Set<string>();
  // A file directly in the home is owned as itself, since its folder is the home.
  const folderOf = (file: string) =>
    file.includes("/") ? file.split("/").slice(0, -1).join("/") : file;
  for (const file of stateFiles) {
    const directory = stateDirectories.find((candidate) =>
      isWithinAny(file, [candidate]),
    );
    folders.add(directory ?? folderOf(file));
  }
  for (const file of documents) folders.add(folderOf(file));
  const sorted = [...folders].filter((folder) => folder.length > 0).sort();
  return sorted.filter(
    (folder) =>
      !sorted.some((other) => other !== folder && isWithinAny(folder, [other])),
  );
};

/** Text safe inside a Python triple-quoted docstring. */
const docText = (value: string): string => value.replace(/["\\]/gu, "'");

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`;

/**
 * The launch command for the computer. Arguments under the captured home are
 * respelled under the computer user's `$HOME` through `sh -c`, since the
 * declared command is not expanded by a shell.
 */
export const launchCommand = (
  argv: readonly string[],
  capturedHome: string,
  workingDirectory: string,
): readonly string[] => {
  const prefix = `${capturedHome}/`;
  const respell = (path: string) =>
    path === capturedHome
      ? `"$HOME"`
      : path.startsWith(prefix)
        ? `"$HOME"/${shellQuote(path.slice(prefix.length))}`
        : shellQuote(path);
  // A relative argument meant the captured working directory, so start there.
  const directory =
    workingDirectory === capturedHome ? undefined : respell(workingDirectory);
  if (
    directory === undefined &&
    !argv.some((argument) => argument.startsWith(prefix))
  )
    return argv;
  const command = `exec ${argv.map(respell).join(" ")}`;
  return [
    "sh",
    "-c",
    directory === undefined ? command : `cd ${directory} && ${command}`,
  ];
};

/** A Python string literal; JSON escapes are valid Python escapes. */
const py = (value: string): string => JSON.stringify(value);
const pyList = (values: readonly string[]): string =>
  `[${values.map(py).join(", ")}]`;

/** The bundle's env.toml: a computer app deployed alone on the X11 base. */
export const renderEnvToml = (plan: DesktopAppExportPlan): string =>
  [
    `type = "computer_app"`,
    `module = ${py(`${plan.name}.py:${plan.className}`)}`,
    `computer = "ubuntu-24.04"`,
    `driver = "reference"`,
    "",
  ].join("\n");

/** Python helpers the class uses to seed the home and read typed views. */
const PYTHON_HELPERS = String.raw`
XML_SUFFIXES = (".xml", ".xbel", ".plist", ".svg", ".ui")
KEYFILE_SUFFIXES = (".ini", ".conf", ".cfg", ".desktop", ".keyfile", ".rc")
MAX_ROWS = 500
MAX_LINES = 5000


def _seed_home(home: Path) -> None:
    """Copy the captured files into this computer's home; only text files have the captured home path respelled."""
    seed = HERE / "seed"
    for source in sorted(seed.rglob("*")) if seed.is_dir() else []:
        if not source.is_file():
            continue
        relative = source.relative_to(seed).as_posix()
        target = home / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        data = source.read_bytes()
        if relative in TEXT_SEEDS:
            data = data.decode("utf-8").replace(CAPTURED_HOME, str(home)).encode("utf-8")
        target.write_bytes(data)


def _load_dconf(home: Path) -> None:
    """Load the application's dconf keys as they were before the capture."""
    if DCONF:
        subprocess.run(["dconf", "load", "/"], input=DCONF.replace(CAPTURED_HOME, str(home)), text=True, check=False)


def _cell(value):
    return {"blob_hex": value.hex()} if isinstance(value, bytes) else value


def _sqlite(path: Path) -> dict:
    tables, truncated = {}, False
    with sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True) as db:
        names = [row[0] for row in db.execute("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")]
        for name in names:
            quoted = '"' + name.replace('"', '""') + '"'
            cursor = db.execute(f"select * from {quoted} limit {MAX_ROWS + 1}")
            rows = [[_cell(value) for value in row] for row in cursor]
            tables[name] = {"columns": [column[0] for column in cursor.description],
                            "rows": rows[:MAX_ROWS], "truncated": len(rows) > MAX_ROWS}
            truncated = truncated or len(rows) > MAX_ROWS
    return {"format": "sqlite", "view": {"tables": tables}, "truncated": truncated}


def _view(path: Path) -> dict:
    """A typed JSON view of one file, read the way REA's state view reads it; truncated says the view is partial."""
    data = path.read_bytes()
    if data.startswith(b"SQLite format 3\x00"):
        return _sqlite(path)
    if b"\x00" in data[:8192]:
        return {"format": "binary", "view": None, "truncated": False}
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return {"format": "binary", "view": None, "truncated": False}
    stripped, name = text.lstrip(), path.name.lower()
    if name.endswith(".json") or stripped[:1] in ("{", "["):
        try:
            return {"format": "json", "view": json.loads(text), "truncated": False}
        except ValueError:
            pass
    if name.endswith(XML_SUFFIXES) or stripped.startswith("<?xml"):
        try:
            return {"format": "xml", "view": _xml(ElementTree.fromstring(text)), "truncated": False}
        except ElementTree.ParseError:
            pass
    if name.endswith(KEYFILE_SUFFIXES) or any(line.strip().startswith("[") and line.strip().endswith("]") for line in text.splitlines()):
        return {"format": "keyfile", "view": {"groups": _keyfile(text)}, "truncated": False}
    lines = text.splitlines()
    return {"format": "text", "view": {"lines": lines[:MAX_LINES], "line_count": len(lines)},
            "truncated": len(lines) > MAX_LINES}


def _xml(element) -> dict:
    """An element with its attributes, text and children, keeping text that follows a child."""
    children = []
    if element.text and element.text.strip():
        children.append(element.text)
    for child in element:
        children.append(_xml(child))
        if child.tail and child.tail.strip():
            children.append(child.tail)
    return {"name": element.tag, "attributes": dict(element.attrib), "children": children}


def _keyfile(text: str) -> dict:
    groups, group = {}, ""
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line[0] in "#;":
            continue
        if line.startswith("[") and line.endswith("]"):
            group = line[1:-1]
            groups.setdefault(group, {})
        elif "=" in line:
            key, _, value = line.partition("=")
            groups.setdefault(group, {})[key.strip()] = value.strip()
    return groups


def _views(home: Path, paths: list) -> dict:
    """A view of every file under the app's paths, keyed by its home-relative path."""
    files = {}
    for owned in paths:
        root = home / owned
        candidates = [root] if root.is_file() else sorted(root.rglob("*")) if root.is_dir() else []
        for path in candidates:
            if path.is_file() and not path.is_symlink():
                try:
                    files[str(path.relative_to(home))] = _view(path)
                except (OSError, sqlite3.Error) as error:
                    files[str(path.relative_to(home))] = {"format": None, "view": None, "error": str(error)}
    return files
`;

/** The computer app class: install, launch, owned paths, seed and data hooks. */
const DATA_HOOKS = `
    @add_data
    async def add_files(self, parts: list) -> None:
        await add(parts, self.paths)

    @get_data
    async def get_files(self, write_namespace=None) -> list:
        files = await get(self.paths, write_namespace)
        return [*files, DataPart(data={"state": _views(Path.home(), self.paths)})]

    @reset_data
    async def reset_files(self) -> None:
        await reset(self.paths)
`;

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
${DATA_HOOKS}`;
  if (plan.dconf.length > 0)
    return `    """${title}, launched at boot with its captured settings. It owns no files, so it serves no data operations."""

    def __init__(self) -> None:
        super().__init__()
        _load_dconf(Path.home())
`;
  return `    """${title}, launched at boot. No state was observed, so it serves no data operations."""\n`;
};

/** The computer app class: install, launch, owned paths, seed and data hooks. */
export const renderAppClass = (plan: DesktopAppExportPlan): string => {
  const hooks = classBody(plan);
  return `"""${docText(plan.title)} as an agentenv computer app, exported by REA from a desktop application capture.

Package: ${plan.aptPackage}${plan.packageVersion === null ? "" : ` (captured at ${plan.packageVersion})`}. Capture Evidence: ${plan.captureEvidenceId}.
The seed is the user's state before the capture: keep this bundle local.
"""

from __future__ import annotations

import json
import sqlite3
import subprocess
import xml.etree.ElementTree as ElementTree
from pathlib import Path

from agentenv_protocol import add_data, get_data, reset_data
from agentenv_protocol.computer import ComputerAppEnvironment, Launch, Packages, Ready, computer_app, linux
from agentenv_protocol.computer.app_data import INITIAL, add, get, keep_initial, reset
from agentenv_protocol.types import DataPart

HERE = Path(__file__).resolve().parent
CAPTURED_HOME = ${py(plan.capturedHome)}
PATHS = ${pyList(plan.paths)}
DCONF = ${py(plan.dconf)}
TEXT_SEEDS = frozenset(${pyList(plan.textSeeds)})
${PYTHON_HELPERS}

@computer_app(supports=[{"os": {"type": "linux", "display": ["x11"]}, "arch": ["amd64", "arm64"]}])
@linux(
    packages=Packages(apt=[${py(plan.aptPackage)}]),
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

/** The bundle README: what was exported, how to run it, and what to keep in mind. */
export const renderReadme = (plan: DesktopAppExportPlan): string =>
  `# ${plan.title} computer app

Exported by REA's \`export-desktop-application\` from a capture of the \`${plan.aptPackage}\` package
(capture Evidence \`${plan.captureEvidenceId}\`). It was checked against agentenv-framework
${DESKTOP_EXPORT_FRAMEWORK_VERSION}.

- \`envs/${plan.name}/\` is a computer app on the \`ubuntu-24.04\` base with the \`reference\` driver. It installs
  \`${plan.aptPackage}\` from the distribution archive, launches \`${plan.command.join(" ")}\` at boot and is ready
  when a window of class \`${plan.windowClass}\` appears.
- Owned paths: ${plan.paths.length === 0 ? "none" : plan.paths.map((path) => `\`~/${path}\``).join(", ")}.
  \`data/get\` returns their files and a typed JSON view of each; \`data/reset\` restores the seed.
- Seed: ${plan.seedFiles.length} file(s) from the user's home before the capture, with the captured home path
  respelled in text files${plan.dconf.length === 0 ? "" : ", and the application's dconf keys"}.${
    plan.unseededFiles.length === 0
      ? ""
      : `
- Not seeded, because the capture did not retain their starting bytes: ${plan.unseededFiles.map((path) => `\`~/${path}\``).join(", ")}.
  Capture again with \`--state-path\` naming them, or a larger \`--max-file-bytes\`, to include them.`
  }
- \`tasks/smoke.json\` deploys the app.

Run it with \`agent-env run <this folder>\`.

The seed is the user's real data. Keep this bundle local; do not publish it.
${plan.dconf.length === 0 ? "" : "dconf keys are loaded once when the app first starts; `data/reset` does not restore them.\n"}`;

/** A smoke task that deploys the app. */
export const renderSmokeTask = (plan: DesktopAppExportPlan): string =>
  `${JSON.stringify([{ id: "env", type: "deploy_env", env_id: plan.name }], null, 2)}\n`;
