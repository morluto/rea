import type { JsonValue } from "../jsonValue.js";
import type { DesktopTask } from "./appTask.js";

/** The verifier's evaluator: the checks' semantics, kept equal to `evaluateTaskChecks`. */
export const PYTHON_TASK_EVALUATOR = String.raw`
MISSING = object()


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


def _resolve(view, pointer: str):
    current = view
    for raw in pointer[1:].split("/"):
        token = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(current, list):
            if not re.fullmatch(r"0|[1-9][0-9]*", token) or int(token) >= len(current):
                return MISSING
            current = current[int(token)]
        elif isinstance(current, dict) and token in current:
            current = current[token]
        else:
            return MISSING
    return current


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


def _value(check, entry):
    view, truncated, problem = _view_of(check, entry, None)
    if problem is not None:
        return False, problem
    found = MISSING if entry is None else _resolve(view, check["pointer"])
    at = f"{check['file']} at {check['pointer']}"
    if check["kind"] == "value_equals" and isinstance(check["value"], (dict, list)) and truncated:
        return _undecided(check)
    if check["kind"] == "value_equals":
        if found is not MISSING and _same(found, check["value"]):
            return True, f"{at} is {_shown(check['value'])}"
        return False, f"{at} has no value" if found is MISSING else f"{at} is {_shown(found)}, not {_shown(check['value'])}"
    if truncated:
        return _undecided(check)
    return (True, f"{at} has no value") if found is MISSING else (False, f"{at} is {_shown(found)}")


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
