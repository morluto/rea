/** The generated module's imports. */
export const PYTHON_IMPORTS = `from __future__ import annotations

import contextlib
import json
import math
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ElementTree
from pathlib import Path

from agentenv_protocol import add_data, get_data, reset_data
from agentenv_protocol.computer import ComputerAppEnvironment, Launch, Packages, Ready, computer_app, linux
from agentenv_protocol.computer.app_data import INITIAL, add, get, in_thread, keep_initial, reset
from agentenv_protocol.types import DataPart
`;

/** Python helpers the class uses to seed the home, load dconf keys and read typed views. */
export const PYTHON_HELPERS = String.raw`
XML_SUFFIXES = (".xml", ".xbel", ".plist", ".svg", ".ui")
GROUP_HEADER = re.compile(r"^\[([^\]]+)\]$")
LINE_BREAK = re.compile(r"\r?\n")
SQLITE_HEADER = b"SQLite format 3\x00"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"
MAX_VIEW_BYTES = 64 * 1024 * 1024
MAX_SAFE_INTEGER = 2**53 - 1
MAX_TABLES = 64
MAX_ROWS = 500
MAX_LINES = 5000
MAX_XML_NODES = 5000
MAX_XML_DEPTH = 64


def _respelled(text: str, home: Path) -> str:
    """The captured home path respelled to this computer's home, only where a whole path segment ends after it."""
    return re.sub(re.escape(CAPTURED_HOME) + r"(?![\w.@+~-])", lambda _: str(home), text)


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
            data = _respelled(data.decode("utf-8"), home).encode("utf-8")
        target.write_bytes(data)


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


def _sqlite_text(data: bytes):
    text = data.decode("utf-8", "replace")
    return {"text": text, "bytes_hex": data.hex()} if "�" in text else text


def _cell(value):
    if isinstance(value, bytes):
        return {"blob_hex": value.hex()}
    if isinstance(value, int) and abs(value) > MAX_SAFE_INTEGER:
        return {"integer": str(value)}
    # JSON has no infinities or negative zero; REA's SQLite reader spells them as strings.
    if isinstance(value, float) and (math.isinf(value) or (value == 0 and math.copysign(1, value) < 0)):
        return "Infinity" if value == math.inf else "-Infinity" if value == -math.inf else "-0"
    return value


def _table(db, name: str, primary_key: list) -> dict:
    quoted = '"' + name.replace('"', '""') + '"'
    cursor = db.execute(f"select * from main.{quoted} not indexed limit {MAX_ROWS + 1}")
    rows = [[_cell(value) for value in row] for row in cursor]
    return {"columns": [column[0] for column in cursor.description], "primary_key": primary_key,
            "rows": rows[:MAX_ROWS], "truncated": len(rows) > MAX_ROWS}


def _sqlite(path: Path) -> dict:
    """The database's ordinary tables, in schema order, up to REA's table and row limits."""
    with contextlib.closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        kinds = dict(db.execute("select name, type from pragma_table_list where schema = 'main'"))
        names = [name for (name,) in db.execute("select name from sqlite_schema where type = 'table'")
                 if kinds.get(name) == "table"]
        keys = {name: [key for (key,) in db.execute(
            "select name from pragma_table_info(?, 'main') where pk > 0 order by pk", (name,))]
            for name in names[:MAX_TABLES]}
        db.text_factory = _sqlite_text
        tables = {name: _table(db, name, keys[name]) for name in names[:MAX_TABLES]}
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
    key, equals, value = line.partition("=")
    return ("entry", key.strip(), value.strip()) if equals and key else ("other",)


def _is_keyfile(text: str) -> bool:
    """REA's rule: at least one group, and nothing a key file view would drop."""
    kinds = {_keyfile_line(line)[0] for line in LINE_BREAK.split(text)}
    return "group" in kinds and "other" not in kinds


def _keyfile(text: str) -> dict:
    groups, group = {}, ""
    for line in map(_keyfile_line, LINE_BREAK.split(text)):
        if line[0] == "group":
            group = line[1]
            groups.setdefault(group, {})
        elif line[0] == "entry":
            groups.setdefault(group, {})[line[1]] = line[2]
    return groups


class _XmlTree(ElementTree.TreeBuilder):
    """Keeps comments and processing instructions, which REA's node limit counts, and refuses DOCTYPEs as REA does."""

    def __init__(self) -> None:
        super().__init__(insert_comments=True, insert_pis=True)

    def doctype(self, name, pubid, system) -> None:
        raise ValueError("the document declares a DOCTYPE")


def _xml_children(element) -> list:
    nodes = [element.text] if element.text else []
    for child in element:
        nodes.append(child)
        if child.tail:
            nodes.append(child.tail)
    return nodes


def _xml(node, depth: int, budget: dict, scope: tuple):
    """A node as REA's XML view keeps it: an element with its attributes and children, or its text; None when it is
    formatting whitespace, a comment, or past REA's node and depth limits."""
    if budget["remaining"] <= 0 or depth > MAX_XML_DEPTH:
        budget["truncated"] = True
        return None
    budget["remaining"] -= 1
    preserve, element_content = scope
    if isinstance(node, str):
        return None if not node.strip() and element_content and not preserve else node
    if not isinstance(node.tag, str):
        return None
    space = node.get(XML_SPACE)
    nodes = _xml_children(node)
    inner = (space == "preserve" if space else preserve,
             any(not isinstance(child, str) and isinstance(child.tag, str) for child in nodes))
    children = [_xml(child, depth + 1, budget, inner) for child in nodes]
    return {"name": node.tag, "attributes": dict(node.attrib), "children": [c for c in children if c is not None]}


def _xml_view(text: str):
    parser = ElementTree.XMLParser(target=_XmlTree())
    try:
        parser.feed(text)
        root = parser.close()
    except (ElementTree.ParseError, ValueError):
        return None
    budget = {"remaining": MAX_XML_NODES, "truncated": False}
    tree = _xml(root, 0, budget, (False, False))
    return None if tree is None else {"root": tree, "truncated": budget["truncated"]}


def _not_json(constant: str):
    raise ValueError(f"{constant} is not JSON")


class _Inexact(Exception):
    """A JSON number that REA's state view refuses, since reading it would change it."""


def _digits(text: str) -> str:
    return re.split(r"[eE]", text.lstrip("-"))[0].replace(".", "").strip("0") or "0"


def _js_string(value: float) -> str:
    """How JavaScript's String() writes a finite double: an integer below 1e21 in full, any other in shortest form."""
    return str(int(value)) if value.is_integer() and abs(value) < 1e21 else repr(value)


def _safe_number(text: str) -> bool:
    """lossless-json's isSafeNumber: an integer spelling within 2^53, or a float spelling that keeps its digits."""
    if re.fullmatch(r"-?[0-9]+", text):
        return len(text.lstrip("-")) <= 16 and abs(int(text)) <= MAX_SAFE_INTEGER
    value = float(text)
    if not math.isfinite(value):
        return False
    written = _js_string(value)
    return written == text or _digits(written) == _digits(text)


def _exact_number(text: str):
    """A JSON number read only when reading it changes nothing, as REA's state view rules: its spelling and its
    written-back form both safe, and not -0."""
    value = float(text)
    if (not _safe_number(text) or not math.isfinite(value) or not _safe_number(_js_string(value))
            or (value == 0 and math.copysign(1, value) < 0)):
        raise _Inexact(text)
    return int(text) if re.fullmatch(r"-?[0-9]+", text) else value


_INEXACT = object()
_INEXACT_END = object()


def _number_or_mark(spelling: str):
    """A JSON number read exactly, or a mark for one REA's state view refuses."""
    try:
        return _exact_number(spelling)
    except _Inexact:
        return _INEXACT


def _holds_inexact(value) -> bool:
    """Whether a parsed JSON value still holds a marked number once duplicate keys kept their last value; one
    iterator per nesting level, so no child list is copied."""
    levels = [iter((value,))]
    while levels:
        item = next(levels[-1], _INEXACT_END)
        if item is _INEXACT_END:
            levels.pop()
        elif item is _INEXACT:
            return True
        elif isinstance(item, dict):
            levels.append(iter(item.values()))
        elif isinstance(item, list):
            levels.append(iter(item))
    return False


def _text_view(name: str, text: str) -> dict:
    """The format REA's state view detects for decoded text, and its view."""
    trimmed = re.sub(r"^[\s﻿]+", "", text)
    if name.endswith(".json") or trimmed[:1] in ("[", "{"):
        # The whole text must parse, and duplicate keys settle, before an inexact number makes it JSON with an error.
        try:
            view = json.loads(text, parse_constant=_not_json, parse_float=_number_or_mark, parse_int=_number_or_mark)
        except ValueError:
            pass
        else:
            if _holds_inexact(view):
                return {"format": "json", "view": None,
                        "error": "a number in it cannot be read exactly, such as an integer above 2^53"}
            return {"format": "json", "view": view, "truncated": False}
    lowered = name.lower()
    if lowered.endswith(XML_SUFFIXES) or trimmed.startswith("<?xml"):
        view = _xml_view(text)
        return _text(text) if view is None else {"format": "xml", "view": view, "truncated": view["truncated"]}
    if _is_keyfile(text):
        return {"format": "keyfile", "view": {"groups": _keyfile(text)}, "truncated": False}
    return _text(text)


def _view(path: Path) -> dict:
    """A typed JSON view of one file in the shapes of REA's state view; truncated says the view is partial."""
    too_large = {"format": None, "view": None, "error": "larger than 64 MiB, the most the view reads"}
    if path.stat().st_size > MAX_VIEW_BYTES:
        return too_large
    with path.open("rb") as file:
        data = file.read(8192)
        whole = not data.startswith(SQLITE_HEADER) and b"\x00" not in data
        data += file.read(MAX_VIEW_BYTES + 1 - len(data)) if whole else b""
    if data.startswith(SQLITE_HEADER):
        return _sqlite(path)
    if len(data) > MAX_VIEW_BYTES:
        return too_large
    try:
        text = data.decode("utf-8-sig") if whole else None
    except UnicodeDecodeError:
        text = None
    return {"format": "binary", "view": None, "truncated": False} if text is None else _text_view(path.name, text)


def _views(home: Path, paths: list) -> dict:
    """A view of every file under the app's paths, keyed by its home-relative path."""
    files = {}
    for owned in paths:
        root = home / owned
        candidates = [root] if root.is_file() else sorted(root.rglob("*")) if root.is_dir() else []
        for path in candidates:
            if path.is_file() and not path.is_symlink():
                key = path.relative_to(home).as_posix()
                try:
                    files[key] = _view(path)
                except (OSError, ValueError, sqlite3.Error, RecursionError) as error:
                    files[key] = {"format": None, "view": None, "error": str(error)}
    return files
`;

/** Constants the class module assigns before the helpers. */
const PYTHON_CONSTANTS = [
  "HERE",
  "CAPTURED_HOME",
  "PATHS",
  "DCONF",
  "TEXT_SEEDS",
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
