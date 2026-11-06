import type { JsonValue } from "../jsonValue.js";
import type { DesktopTask } from "./appTask.js";

/** The verifier's evaluator: the checks' semantics, kept equal to `evaluateTaskChecks`. */
export const PYTHON_TASK_EVALUATOR = String.raw`
MISSING = object()
INDEX = re.compile(r"0|[1-9][0-9]*")
VIEW_FORMATS = ("text", "json", "keyfile", "xml")
NUMERAL = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")


def _shown(value) -> str:
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return text if len(text) <= 200 else text[:200] + "…"


def _same(actual, expected) -> bool:
    """JSON equality: numbers by value but never a boolean for a number, objects by their keys, arrays in order."""
    if isinstance(expected, list):
        return (isinstance(actual, list) and len(actual) == len(expected)
                and all(_same(item, wanted) for item, wanted in zip(actual, expected)))
    if isinstance(expected, dict):
        return (isinstance(actual, dict) and len(actual) == len(expected)
                and all(key in actual and _same(actual[key], value) for key, value in expected.items()))
    if isinstance(expected, bool) or isinstance(actual, bool):
        return isinstance(expected, bool) and isinstance(actual, bool) and actual == expected
    if isinstance(expected, (int, float)):
        return isinstance(actual, (int, float)) and actual == expected
    return type(actual) is type(expected) and actual == expected


def _bracketed(token: str) -> bool:
    return len(token) >= 2 and token.startswith("[") and token.endswith("]")


def _selector(token: str):
    """A selector's conditions, [KEY=VALUE] or [@KEY=VALUE] one or more times, or None when the token is not one."""
    if not _bracketed(token):
        return None
    conditions = []
    for part in token[1:-1].split("]["):
        key, equals, value = part.partition("=")
        name = key[1:] if key.startswith("@") else key
        if not equals or not name:
            return None
        conditions.append((key.startswith("@"), name, value))
    return conditions


def _selects(member, conditions) -> bool:
    """Whether an array member meets every condition; selectors compare strings only."""
    if not isinstance(member, dict):
        return False
    for attribute, key, value in conditions:
        fields = member.get("attributes") if attribute else member
        if not isinstance(fields, dict) or not isinstance(fields.get(key), str) or fields[key] != value:
            return False
    return True


def _step(items: list, token: str, last: bool):
    """One step into an array, by index or by a selector that must match one member, or none when it is the last."""
    if INDEX.fullmatch(token):
        return ("member", items[int(token)]) if int(token) < len(items) else ("none", None)
    conditions = _selector(token)
    if conditions is None:
        return ("unresolved", f"{token} is not a selector of the form [KEY=VALUE]") if _bracketed(token) else (
            "none", None)
    matched = [item for item in items if _selects(item, conditions)]
    if len(matched) == 1:
        return "member", matched[0]
    if len(matched) > 1:
        return "unresolved", f"{token} matches {len(matched)} members, not one"
    return ("none" if last else "unresolved"), f"{token} matches no member"


def _locate(view, pointer: str):
    """Where a pointer leads: ("value", value), ("none", why or None) or ("unresolved", problem), with the pointers
    to the arrays a selector searched on the way."""
    current, searched = view, []
    segments = pointer[1:].split("/")
    for position, segment in enumerate(segments):
        token = segment.replace("~1", "/").replace("~0", "~")
        if isinstance(current, list):
            if not INDEX.fullmatch(token) and _selector(token) is not None:
                searched.append("".join("/" + part for part in segments[:position]))
            kind, found = _step(current, token, position == len(segments) - 1)
            if kind != "member":
                return kind, found, searched
            current = found
        elif isinstance(current, dict) and token in current:
            current = current[token]
        else:
            return "none", None, searched
    return "value", current, searched


def _number(value):
    """A number, or a numeral string read as one; None for anything else, a boolean, or a numeral past the doubles."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    if not isinstance(value, str) or not NUMERAL.fullmatch(value):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _entry_leaves_out(entry) -> bool:
    return isinstance(entry, dict) and (isinstance(entry.get("view_error"), str) or (
        entry.get("format") in ("text", "xml") and isinstance(entry.get("view"), dict)
        and entry["view"].get("truncated") is True))


def _viewless_entry(view, pointer: str):
    """The name of the entry whose view a pointer goes into when it has none, so its null is no JSON value, and
    why: binary, unread, or of a format without a view; None when it has one."""
    parts = pointer[1:].split("/")
    if len(parts) < 3 or parts[0] != "entries" or parts[2] != "view":
        return None
    kind, item, _ = _locate(view, "/entries/" + parts[1])
    if kind != "value" or not isinstance(item, dict):
        return None
    if isinstance(item.get("view_error"), str):
        reason = f"has no view: {item['view_error']}"
    elif item.get("format") == "binary":
        reason = "is binary and has no view"
    elif item.get("format") not in VIEW_FORMATS:
        reason = "has no view"
    else:
        return None
    return (item["name"] if isinstance(item.get("name"), str) else ""), reason


def _array_leaves_out(form, view, array: str) -> bool:
    """Whether an array a selector searched may lack members: in a zip the listing or its entry's view, else the
    view's own truncation."""
    if form != "zip":
        return _truncated(form, view)
    if array == "/entries":
        return isinstance(view, dict) and view.get("truncated") is True
    return _zip_leaves_out(view, array)


def _zip_leaves_out(view, pointer: str) -> bool:
    """Whether a zip view leaves out what a pointer reaches: for a pointer into one listed entry, only that entry."""
    if not isinstance(view, dict):
        return False
    parts = pointer[1:].split("/")
    if parts[0] == "entries" and len(parts) > 1:
        kind, entry, _ = _locate(view, "/entries/" + parts[1])
        return _entry_leaves_out(entry) if kind == "value" else view.get("truncated") is True
    entries = view.get("entries") if isinstance(view.get("entries"), list) else []
    return view.get("truncated") is True or any(_entry_leaves_out(entry) for entry in entries)


def _truncated(form, view) -> bool:
    if not isinstance(view, dict):
        return False
    if form in ("text", "xml"):
        return view.get("truncated") is True
    if form != "sqlite":
        return False
    tables = view.get("tables")
    return view.get("tables_truncated") is True or any(
        isinstance(table, dict) and (table.get("truncated") is True or isinstance(table.get("error"), str))
        for table in (tables.values() if isinstance(tables, dict) else []))


def _view_of(check, entry, form):
    """The view, whether it is truncated, and why the check cannot read it; an absent file reads as empty."""
    if entry is None:
        return None, False, None
    if isinstance(entry.get("error"), str):
        return None, False, f"{check['file']} has no view: {entry['error']}"
    if entry.get("format") in (None, "binary"):
        return None, False, f"{check['file']} is binary and has no view"
    if form is not None and entry.get("format") != form:
        return None, False, f"{check['file']} is read as {entry.get('format')}, not {form}"
    return entry.get("view"), _truncated(entry.get("format"), entry.get("view")), None


def _undecided(check):
    return False, f"the view of {check['file']} is truncated, so what it leaves out is unknown"


def _compared(check, n: int, what: str):
    operator = next(key for key in ("equals", "at_least", "at_most") if check.get(key) is not None)
    expected = check[operator]
    met = n == expected if operator == "equals" else n >= expected if operator == "at_least" else n <= expected
    return met, f"{n} {what}, expected {operator.replace('_', ' ')} {expected}"


def _lines(check, entry):
    view, truncated, problem = _view_of(check, entry, "text")
    if problem is not None:
        return False, problem
    lines = view.get("lines") if isinstance(view, dict) and isinstance(view.get("lines"), list) else []
    lines = [line for line in lines if isinstance(line, str)]
    file = check["file"]
    if check["kind"] == "lines_present":
        missing = next((line for line in check["lines"] if line not in lines), None)
        return (True, f"{file} has the line(s) {_shown(check['lines'])}") if missing is None else (
            False, f"{file} has no line {_shown(missing)}")
    if truncated:
        return _undecided(check)
    if check["kind"] == "lines_absent":
        found = next((line for line in check["lines"] if line in lines), None)
        return (True, f"{file} has none of the lines {_shown(check['lines'])}") if found is None else (
            False, f"{file} still has the line {_shown(found)}")
    if check.get("contains") is not None:
        n = sum(1 for line in lines if check["contains"] in line)
        return _compared(check, n, f"line(s) of {file} contain {_shown(check['contains'])}")
    n = sum(1 for line in lines if line == check["exact"])
    return _compared(check, n, f"line(s) of {file} match {_shown(check['exact'])}")


def _near(at: str, found, expected, tolerance):
    """A value compared within a tolerance: numbers, and numeral strings, by their difference."""
    number = _number(found)
    within = f"within {_shown(tolerance)} of {_shown(expected)}"
    if number is None:
        return False, f"{at} is {_shown(found)}, not a number"
    if abs(number - expected) <= tolerance:
        return True, f"{at} is {_shown(found)}, {within}"
    return False, f"{at} is {_shown(found)}, not {within}"


def _value(check, entry):
    view, truncated, problem = _view_of(check, entry, None)
    if problem is not None:
        return False, problem
    kind, found, searched = ("none", None, []) if entry is None else _locate(view, check["pointer"])
    at = f"{check['file']} at {check['pointer']}"
    viewless = _viewless_entry(view, check["pointer"]) if entry is not None and entry.get("format") == "zip" else None
    if viewless is not None:
        return False, f"{check['file']} entry {viewless[0]} {viewless[1]}"
    # A selector tells one member from several only in an array the view holds whole.
    if any(_array_leaves_out(entry.get("format"), view, array) for array in searched):
        return _undecided(check)
    if kind == "unresolved":
        return False, f"{at}: {found}"
    if entry is not None and entry.get("format") == "zip":
        truncated = _zip_leaves_out(view, check["pointer"])
    if check["kind"] == "value_equals" and isinstance(check["value"], (dict, list)) and truncated:
        return _undecided(check)
    if check["kind"] == "value_equals":
        if kind == "none":
            return False, f"{at} has no value" if found is None else f"{at}: {found}"
        expected = check["value"]
        if check.get("tolerance") is not None and isinstance(expected, (int, float)) and not isinstance(expected, bool):
            return _near(at, found, expected, check["tolerance"])
        if _same(found, check["value"]):
            return True, f"{at} is {_shown(check['value'])}"
        return False, f"{at} is {_shown(found)}, not {_shown(check['value'])}"
    if truncated:
        return _undecided(check)
    return (True, f"{at} has no value") if kind == "none" else (False, f"{at} is {_shown(found)}")


def _rows(check, entry):
    view, _, problem = _view_of(check, entry, "sqlite")
    if problem is not None:
        return False, problem
    view = view if isinstance(view, dict) else {}
    tables = view.get("tables") if isinstance(view.get("tables"), dict) else {}
    table = tables[check["table"]] if check["table"] in tables else MISSING
    name = f"{check['file']} table {check['table']}"
    if table is MISSING and view.get("tables_truncated") is True:
        return _undecided(check)
    table = table if isinstance(table, dict) else {}
    if isinstance(table.get("error"), str):
        return False, f"{name} could not be read: {table['error']}"
    columns = table.get("columns") if isinstance(table.get("columns"), list) else []
    rows = table.get("rows") if isinstance(table.get("rows"), list) else []
    where = check.get("where") or {}

    def matches(row) -> bool:
        return isinstance(row, list) and all(
            column in columns and columns.index(column) < len(row) and _same(row[columns.index(column)], value)
            for column, value in where.items())

    n = sum(1 for row in rows if matches(row))
    if check["kind"] == "row_present":
        return (n > 0, f"{name} has a row with {_shown(where)}" if n > 0 else f"{name} has no row with {_shown(where)}")
    if table.get("truncated") is True:
        return _undecided(check)
    if check["kind"] == "row_absent":
        return (True, f"{name} has no row with {_shown(where)}") if n == 0 else (
            False, f"{name} has {n} row(s) with {_shown(where)}")
    return _compared(check, n, f"row(s) of {name}" + (f" with {_shown(where)}" if "where" in check else ""))


def _verdict(check, entry):
    kind = check["kind"]
    if kind == "file_present":
        return (entry is not None, f"{check['file']} exists" if entry is not None else f"{check['file']} does not exist")
    if kind == "file_absent":
        return (entry is None, f"{check['file']} does not exist" if entry is None else f"{check['file']} exists")
    if kind in ("lines_present", "lines_absent", "line_count"):
        return _lines(check, entry)
    if kind in ("value_equals", "value_absent"):
        return _value(check, entry)
    return _rows(check, entry)


def evaluate(checks: list, views: dict) -> list:
    """One result per check against the views data/get returned, by home path."""
    results = []
    for check in checks:
        passed, description = _verdict(check, views.get(check["file"]))
        results.append({"id": check["id"], "result": passed, "description": description})
    return results
`;

/** A JSON value as a Python literal. */
export const pythonLiteral = (value: JsonValue): string => {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pythonLiteral).join(", ")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .map(([key, item]) => `${JSON.stringify(key)}: ${pythonLiteral(item)}`)
    .join(", ")}}`;
};

/** The verifier artifact: read the app's state through its data/get, then evaluate the task's checks. */
export const renderTaskVerifier = (task: DesktopTask, app: string): string =>
  `"""Checks of the task ${task.name} against the ${app} app's state, exported by REA from a desktop application capture.

It reads the app's data/get through the computer, takes the typed views of its files and evaluates each check: no
model, no code from the task. A failure to reach the app raises, so the run fails rather than scoring the agent.
"""
import json
import math
import re

from agentenv_protocol import client as protocol
from agentenv_protocol.types import RPC_PATH

APP = ${JSON.stringify(app)}
CHECKS = [
${task.checks.map((check) => `    ${pythonLiteral(check as unknown as JsonValue)},`).join("\n")}
]
${PYTHON_TASK_EVALUATOR}

async def verify(mcp_url, env_url):
    card = await protocol.get_card(env_url)
    child = protocol.find_child(card, APP)
    if child is None:
        raise RuntimeError(f"the computer at {env_url} lists no app named {APP}")
    answer = await protocol.get_data(env_url + (child.get("url") or RPC_PATH).removesuffix(RPC_PATH), timeout=120)
    states = [part.data["state"] for part in answer.parts
              if part.kind == "data" and isinstance(part.data.get("state"), dict)]
    if not states:
        raise RuntimeError(f"the {APP} app's data/get returned no state views")
    return evaluate(CHECKS, states[0])
`;

/** The artifact folder of a task's verifier. */
export const taskVerifierArtifact = (task: DesktopTask): string =>
  `${task.name}-check`;

/** The task's steps, as agentenv's desktop example runs a computer-use agent and grades its outcome. */
export const renderTaskSteps = (task: DesktopTask, app: string): string => {
  const steps = [
    { id: "env", type: "deploy_env", env_id: app },
    { id: "agent", type: "deploy_agent", env_ids: [app] },
    { id: "skills", type: "add_skills", env_ids: [app] },
    {
      id: "record",
      type: "start_computer_recording",
      env_id: app,
      name: "agent",
      depends_on: ["env"],
    },
    {
      id: "task",
      type: "prompt_agent",
      depends_on: ["skills", "record"],
      prompt: task.prompt,
    },
    {
      id: "check",
      type: "env_outcome_verifier",
      env_id: app,
      file_artifact_id: taskVerifierArtifact(task),
      verifier_id: task.name,
      depends_on: ["task"],
    },
    {
      id: "end",
      type: "end_computer_recording",
      name: "agent",
      depends_on: ["task"],
    },
  ];
  return `[\n${steps.map((step) => `  ${JSON.stringify(step)}`).join(",\n")}\n]\n`;
};

/** The bundle's eval: its tasks, without the smoke task. */
export const renderTaskEval = (tasks: readonly DesktopTask[]): string =>
  `tasks = [${tasks.map((task) => JSON.stringify(task.name)).join(", ")}]\n`;
