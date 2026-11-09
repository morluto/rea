import { XML_ELEMENT_OPENING } from "../xmlDocument.js";
import { PYTHON_JSON_READER } from "./appExportPythonJson.js";
import { PYTHON_XML_READER } from "./appExportPythonXml.js";
import { PYTHON_ZIP_HELPERS } from "./appExportPythonZip.js";

/** The generated module's imports. */
/** The class method that holds readiness until the app's own window shows, not a splash screen with its class. */
export const PYTHON_READY_CHECK = `
    @ready_check
    def main_window_shown(self) -> bool:
        """A window of the app's class that the taskbar lists is shown, not only a splash screen or a dialog."""
        return _taskbar_window(WINDOW_CLASS)
`;

export const PYTHON_IMPORTS = `from __future__ import annotations

from array import array
import binascii
import contextlib
import copy
import hashlib
import io
import json
import math
import os
import re
import sqlite3
import struct
import subprocess
import sys
import tempfile
import zipfile
import zlib
from pathlib import Path
from xml.parsers import expat

from agentenv_protocol import add_data, get_data, reset_data
from agentenv_protocol.computer import AptSource, ComputerAppEnvironment, Download, Launch, Packages, Ready, RunScript, computer_app, linux, ready_check
from agentenv_protocol.computer.app_data import INITIAL, add, get, in_thread, keep_initial, reset
from agentenv_protocol.computer.dataplane import file_parts
from agentenv_protocol.types import DataPart
`;

/** Translate the shared XML grammar's code point escapes into Python regex escapes. */
const PYTHON_XML_ELEMENT_OPENING = XML_ELEMENT_OPENING.replaceAll(
  /\\u\{([0-9a-f]+)\}/giu,
  (_, code: string) => `\\U${code.padStart(8, "0")}`,
);

/** Python helpers the class uses to seed the home, load dconf keys and read typed views. */
export const PYTHON_HELPERS = String.raw`
XML_SUFFIXES = (".xml", ".xbel", ".plist", ".svg", ".ui")
XML_ELEMENT_OPENING = re.compile(r"${PYTHON_XML_ELEMENT_OPENING}")
def _opens_element(text: str) -> bool:
    """Whether text opens with an element, after a DOCTYPE with no internal subset or none. A '[' inside a quoted id is not a subset."""
    if XML_ELEMENT_OPENING.match(text):
        return True
    declared = re.match(r"(?:<\?xml[^>]*>\s*)?<!DOCTYPE\b", text)
    if declared is None:
        return False
    quote = ""
    for index in range(declared.end(), len(text)):
        character = text[index]
        if quote:
            if character == quote:
                quote = ""
            continue
        if character in ('"', "'"):
            quote = character
        elif character == "[":
            return False
        elif character == ">":
            return XML_ELEMENT_OPENING.match(text[index + 1:].lstrip()) is not None
    return False
GROUP_HEADER = re.compile(r"^\[([^\]]+)\]$")
LINE_BREAK = re.compile(r"\r?\n")
SQLITE_HEADER = b"SQLite format 3\x00"
GVDB_HEADER = b"GVariant"
ZIP_HEADER = b"PK\x03\x04"
GZIP_HEADER = b"\x1f\x8b\x08"
XML_SPACE = "xml:space"
MAX_VIEW_BYTES = 64 * 1024 * 1024
MAX_SAFE_INTEGER = 2**53 - 1
MAX_TABLES = 64
MAX_ROWS = 500
MAX_LINES = 5000
MAX_XML_NODES = 5000
MAX_XML_DEPTH = 64
SQLITE_BUSY_S = 0.25
MAX_PARSED_BYTES = 4 * 1024 * 1024
PARSED_TOO_LARGE = "larger than the 4 MiB limit for JSON and key file views"
MAX_JSON_VIEW_DEPTH = 500
JSON_TOO_DEEP = f"nested deeper than the {MAX_JSON_VIEW_DEPTH} levels a JSON view keeps"


def _respelled(text: str, home: Path) -> str:
    """The seed's home path respelled to this computer's home, only where a whole path segment ends after it."""
    return re.sub(re.escape(SEED_HOME) + r"(?![\w.@+~-])", lambda _: str(home), text)


def _respelled_utf16(data: bytes, home: Path) -> bytes:
    """A UTF-16 text file with a byte-order mark respelled like a text seed, its mark kept; any other bytes as given."""
    for mark, codec in ((b"\xff\xfe", "utf-16-le"), (b"\xfe\xff", "utf-16-be")):
        if data.startswith(mark):
            try:
                text = data[len(mark):].decode(codec)
            except UnicodeDecodeError:
                return data
            return mark + _respelled(text, home).encode(codec) if SEED_HOME in text else data
    return data


#: What marks a window as not yet the app's own: skipping the taskbar, as splash screens and dialogs do, or a splash type.
SPLASH_MARKS = ("_NET_WM_STATE_SKIP_TASKBAR", "_NET_WM_WINDOW_TYPE_SPLASH")


def _taskbar_window(window_class: str) -> bool:
    """Whether a top-level window of the given class that the taskbar lists is shown; a splash screen or a dialog
    skips the taskbar."""
    def xprop(*args: str) -> str:
        done = subprocess.run(["xprop", *args], capture_output=True, text=True)
        return done.stdout if done.returncode == 0 else ""

    for window in re.findall(r"0x[0-9a-f]+", xprop("-root", "_NET_CLIENT_LIST").partition("#")[2]):
        props = xprop("-id", window, "WM_CLASS", "_NET_WM_STATE", "_NET_WM_WINDOW_TYPE")
        classes = re.findall(r'"((?:[^"\\]|\\.)*)"', props.partition("WM_CLASS")[2].split("\n", 1)[0])
        if window_class in classes and not any(mark in props for mark in SPLASH_MARKS):
            return True
    return False


def _seed_home(home: Path) -> None:
    """Copy the captured files into this computer's home; text files, UTF-16 ones too, have the seed's home path
    respelled."""
    seed = HERE / "seed"
    for source in sorted(seed.rglob("*")) if seed.is_dir() else []:
        if not source.is_file():
            continue
        relative = source.relative_to(seed).as_posix()
        target = home / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        data = source.read_bytes()
        if relative in TEXT_SEEDS:
            data = _respelled(data.decode("utf-8"), home).encode("utf-8")
        else:
            data = _respelled_utf16(data, home)
        target.write_bytes(data)
        mode = SEED_MODES.get(relative)
        if mode is not None:
            target.chmod(mode)


def _ensure_state_aliases(home: Path) -> None:
    """Restore selected aliases without replacing any existing user data."""
    aliases = sorted(STATE_ALIASES, key=lambda pair: len(Path(pair[0]).parts))
    for alias, target in aliases:
        link = home / alias
        destination = home / target
        has_children = any(Path(alias) in Path(child).parents for child, _ in aliases)
        if link.is_symlink() and link.resolve() == destination.resolve():
            if has_children:
                destination.mkdir(parents=True, exist_ok=True)
            continue
        if os.path.lexists(link):
            raise FileExistsError(f"Cannot restore selected state alias; path already exists: {link}")
        link.parent.mkdir(parents=True, exist_ok=True)
        if has_children:
            destination.mkdir(parents=True, exist_ok=True)
        link.symlink_to(destination)


def _dconf(arguments: list, environment: dict) -> str:
    return subprocess.run(["dconf", *arguments], env={**os.environ, **environment}, capture_output=True, text=True,
                          check=True).stdout


def _load_dconf(home: Path) -> None:
    """Compile the captured dconf keys into the user database without D-Bus, which is not up yet. Keys already there
    stay unless captured: dconf compile reads the key files in name order and a later file wins. A failure is
    reported and the app starts without them."""
    if not DCONF:
        return
    database = home / ".config" / "dconf" / "user"
    try:
        database.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=database.parent) as scratch:
            keyfiles = Path(scratch, "keyfiles")
            keyfiles.mkdir()
            if database.is_file():
                profile = Path(scratch, "profile")
                profile.write_text(f"file-db:{database}\n")
                existing = _dconf(["dump", "/"], {"DCONF_PROFILE": str(profile)})
                (keyfiles / "00-existing").write_text(existing)
            (keyfiles / "01-captured").write_text(_respelled(DCONF, home))
            _dconf(["compile", str(Path(scratch, "user")), str(keyfiles)], {})
            os.replace(Path(scratch, "user"), database)
    except (OSError, subprocess.CalledProcessError) as error:
        detail = (getattr(error, "stderr", None) or "").strip().splitlines()
        print(f"warning: the captured dconf settings were not loaded: {detail[-1] if detail else error}",
              file=sys.stderr)


def _sqlite_text(data: bytes, encoding: str):
    text = data.decode(encoding, "replace")
    return {"text": text, "bytes_hex": data.hex()} if "�" in text else text


def _cell(value, encoding: str):
    if isinstance(value, str):
        data = bytes.fromhex(value[1:])
        return _sqlite_text(data, encoding) if value[0] == "t" else {"blob_hex": data.hex()}
    if isinstance(value, int) and abs(value) > MAX_SAFE_INTEGER:
        return {"integer": str(value)}
    # JSON has no infinities or negative zero; REA's SQLite reader spells them as strings.
    if isinstance(value, float) and (math.isinf(value) or (value == 0 and math.copysign(1, value) < 0)):
        return "Infinity" if value == math.inf else "-Infinity" if value == -math.inf else "-0"
    return value


def _table(db, name: str, primary_key: list, encoding: str) -> dict:
    quoted = '"' + name.replace('"', '""') + '"'
    columns = [column[0] for column in db.execute(f"select * from main.{quoted} limit 0").description]
    # SQLite owns TEXT-to-BLOB conversion, so hex retains the database's original encoding.
    projected = []
    for name in columns:
        column = '"' + name.replace('"', '""') + '"'
        projected.append(f"CASE typeof({column}) WHEN 'text' THEN 't' || hex(CAST({column} AS BLOB)) "
                         f"WHEN 'blob' THEN 'b' || hex({column}) ELSE {column} END")
    cursor = db.execute(f"select {', '.join(projected)} from main.{quoted} not indexed limit {MAX_ROWS + 1}")
    rows = [[_cell(value, encoding) for value in row] for row in cursor]
    return {"columns": columns, "primary_key": primary_key,
            "rows": rows[:MAX_ROWS], "truncated": len(rows) > MAX_ROWS}


def _sqlite(path: Path) -> dict:
    """The database's ordinary tables, in schema order, up to REA's table and row limits."""
    with contextlib.closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=SQLITE_BUSY_S)) as db:
        kinds = dict(db.execute("select name, type from temp.pragma_table_list where schema = 'main'"))
        names = [name for (name,) in db.execute("select name from sqlite_schema where type = 'table'")
                 if kinds.get(name) == "table"]
        keys = {name: [key for (key,) in db.execute(
            "select name from temp.pragma_table_info(?, 'main') where pk > 0 order by pk", (name,))]
            for name in names[:MAX_TABLES]}
        encoding = {"UTF-8": "utf-8", "UTF-16le": "utf-16-le", "UTF-16be": "utf-16-be"}[
            db.execute("PRAGMA encoding").fetchone()[0]]
        tables = {name: _table(db, name, keys[name], encoding) for name in names[:MAX_TABLES]}
    cut = len(names) > MAX_TABLES
    return {"format": "sqlite", "view": {"tables": tables, "tables_truncated": cut},
            "truncated": cut or any(table["truncated"] for table in tables.values())}


def _text(text: str) -> dict:
    lines = LINE_BREAK.split(text)
    if lines[-1] == "":
        lines.pop()
    view = {"lines": lines[:MAX_LINES], "line_count": len(lines), "truncated": len(lines) > MAX_LINES}
    return {"format": "text", "view": view, "truncated": view["truncated"]}


def _keyfile_line(raw: str) -> tuple:
    """A key file line as REA reads it: skip (blank or comment), group, entry or other."""
    line = raw.strip()
    if not line or line[0] in "#;":
        return ("skip",)
    header = GROUP_HEADER.match(line)
    if header:
        return ("group", header.group(1))
    key, equals, value = raw.partition("=")
    key = key.strip()
    # Only ASCII space and tab immediately after '=' are padding.
    return ("entry", key, value.lstrip(" \t")) if equals and key else ("other",)


def _each_line(text: str):
    """Each line of text as REA splits them, one at a time."""
    start = 0
    for line_break in LINE_BREAK.finditer(text):
        yield text[start:line_break.start()]
        start = line_break.end()
    yield text[start:]


def _is_keyfile(text: str) -> bool:
    """REA's rule: at least one group, and nothing a key file view would drop. Lines are read one at a time, stopping
    at the first it would drop."""
    group = False
    for line in _each_line(text):
        kind = _keyfile_line(line)[0]
        if kind == "other":
            return False
        group = group or kind == "group"
    return group


def _keyfile(text: str) -> dict:
    groups, group = {}, ""
    for line in map(_keyfile_line, LINE_BREAK.split(text)):
        if line[0] == "group":
            group = line[1]
            groups.setdefault(group, {})
        elif line[0] == "entry":
            groups.setdefault(group, {})[line[1]] = line[2]
    return groups


${PYTHON_XML_READER}

${PYTHON_JSON_READER}

def _text_view(name: str, text: str, size: int) -> dict:
    """The format REA's state view detects for decoded text of size bytes, and its view; a JSON or key file over the
    parsed-view limit is refused before its value is built."""
    trimmed = re.sub(r"^[\s﻿]+", "", text)
    if name.lower().endswith(".json") or trimmed[:1] in ("[", "{"):
        view = _json_view(text, size)
        if view is not None:
            return view
    lowered = name.lower()
    # Text that opens with an element, after a DOCTYPE with no internal subset or none, is XML if it parses, whatever
    # the file is called, as a Freeplane map or KmPlot's <!DOCTYPE kmpdoc> plot.
    if lowered.endswith(XML_SUFFIXES) or trimmed.startswith("<?xml") or _opens_element(trimmed):
        view = _xml_view(text)
        return _text(text) if view is None else {"format": "xml", "view": view, "truncated": view["truncated"]}
    if _is_keyfile(text):
        if size > MAX_PARSED_BYTES:
            return {"format": "keyfile", "view": None, "error": PARSED_TOO_LARGE}
        return {"format": "keyfile", "view": {"groups": _keyfile(text)}, "truncated": False}
    return _text(text)


def _bytes_view(name: str, data: bytes) -> dict:
    """The view of a document that is no database or archive: its text's, or none when it is binary."""
    try:
        text = data.decode("utf-8-sig") if b"\x00" not in data[:8192] else None
    except UnicodeDecodeError:
        text = None
    if text is None:
        return {"format": "binary", "view": None, "truncated": False}
    return _text_view(name, text, len(data))


def _view(path: Path) -> dict:
    """A typed JSON view of one file in the shapes of REA's state view; truncated says the view is partial."""
    too_large = {"format": None, "view": None, "error": "larger than 64 MiB, the most the view reads"}
    if path.stat().st_size > MAX_VIEW_BYTES:
        return too_large
    with path.open("rb") as file:
        data = file.read(8192)
        whole = data.startswith(GZIP_HEADER) or (not data.startswith(SQLITE_HEADER) and b"\x00" not in data)
        data += file.read(MAX_VIEW_BYTES + 1 - len(data)) if whole else b""
    if data.startswith(SQLITE_HEADER):
        return _sqlite(path)
    if data.startswith(ZIP_HEADER):
        with path.open("rb") as file:
            return _zip(file, os.fstat(file.fileno()).st_size)
    if len(data) > MAX_VIEW_BYTES:
        return too_large
    if data.startswith(GZIP_HEADER):
        return _gzip(path.name, data)
    return _bytes_view(path.name, data)


def _write_withheld(home: Path, settings, withheld: dict) -> None:
    """Write each withheld file from its secret setting, its bytes in base64, readable by its owner alone."""
    for name, relative in withheld.items():
        target = home / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(binascii.a2b_base64(getattr(settings, name).get_secret_value(), strict_mode=True))
        target.chmod(0o600)


def _views(home: Path, paths: list, leaving_out=()) -> dict:
    """A view of every file under the app's paths but those it leaves out, keyed by its home-relative path."""
    files = {}
    for owned in paths:
        root = home / owned
        candidates = [root] if root.is_file() else sorted(root.rglob("*")) if root.is_dir() else []
        for path in candidates:
            if path.is_file() and not path.is_symlink():
                key = path.relative_to(home).as_posix()
                if key in leaving_out:
                    continue
                try:
                    files[key] = _view(path)
                except (OSError, ValueError, sqlite3.Error, RecursionError) as error:
                    files[key] = {"format": None, "view": None, "error": str(error)}
    return files
`.concat(PYTHON_ZIP_HELPERS);

/** Constants the class module assigns before the helpers. */
const PYTHON_CONSTANTS = [
  "HERE",
  "SEED_HOME",
  "PATHS",
  "DCONF",
  "TEXT_SEEDS",
  "SEED_MODES",
  "STATE_ALIASES",
  "WINDOW_CLASS",
  "WITHHELD",
] as const;

/** Names a Python source binds at its top level: imports, assignments, functions and classes. */
const boundNames = (source: string): readonly string[] => [
  ...[...source.matchAll(/^(?:from \S+ )?import (?<names>.+)$/gmu)].flatMap(
    (match) =>
      (match.groups?.names ?? "")
        .split(",")
        .map(
          (name) =>
            name
              .trim()
              .split(/\s+as\s+/u)
              .at(-1) ?? "",
        )
        .map((name) => name.split(".")[0] ?? ""),
  ),
  ...[
    ...source.matchAll(/^(?:def |class )?(?<name>[A-Za-z_]\w*)(?: =|\()/gmu),
  ].map((match) => match.groups?.name ?? ""),
];

/** Every name the generated module binds besides the app class, which the class must not take. */
export const PYTHON_MODULE_NAMES: ReadonlySet<string> = new Set([
  ...boundNames(PYTHON_IMPORTS),
  ...boundNames(PYTHON_HELPERS),
  ...PYTHON_CONSTANTS,
]);

/** The data hooks of an app whose withheld files no get serves: neither as parts nor in the views. */
export const PYTHON_WITHHELD_DATA_HOOKS = `
    @add_data
    async def add_files(self, parts: list) -> None:
        await add(parts, self.paths)

    @get_data
    async def get_files(self, write_namespace=None) -> list:
        files = await file_parts(Path.home(), self.paths, write_namespace, list(WITHHELD.values()))
        views = await in_thread(_views, Path.home(), self.paths, list(WITHHELD.values()))
        return [*files, DataPart(data={"state": views})]

    @reset_data
    async def reset_files(self) -> None:
        await reset(self.paths)
`;

/** The data hooks of an app that owns paths; `_views` reads files, so it runs in a thread. */
export const PYTHON_DATA_HOOKS = `
    @add_data
    async def add_files(self, parts: list) -> None:
        await add(parts, self.paths)

    @get_data
    async def get_files(self, write_namespace=None) -> list:
        files = await get(self.paths, write_namespace)
        views = await in_thread(_views, Path.home(), self.paths)
        return [*files, DataPart(data={"state": views})]

    @reset_data
    async def reset_files(self) -> None:
        await reset(self.paths)
`;
