import type { JsonValue } from "../jsonValue.js";
import { SETTLE_TIMING } from "./appSettle.js";
import type { DesktopTask } from "./appTask.js";
import { PYTHON_POINTER } from "./appTaskPythonPointer.js";

/** The verifier's evaluator: the checks' semantics, kept equal to `evaluateTaskChecks`. */
export const PYTHON_TASK_EVALUATOR = String.raw`
MISSING = object()
INDEX = re.compile(r"0|[1-9][0-9]*")
VIEW_FORMATS = ("text", "json", "keyfile", "xml")
NUMERAL = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
WHITESPACE_RUN = re.compile(r"[ \t\r\n]+")


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


${PYTHON_POINTER}

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


def _selector_format(entry, view, pointer):
    if not isinstance(entry, dict) or entry.get("format") != "zip":
        return None if entry is None else entry.get("format")
    parts = pointer[1:].split("/")
    if len(parts) < 2 or parts[0] != "entries":
        return "zip"
    kind, item, _ = _locate(view, "/entries/" + parts[1], "zip")
    return item.get("format", "zip") if kind == "value" and isinstance(item, dict) else "zip"


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


def _xml_text(entry, view, pointer: str, found) -> bool:
    """Whether found is an XML element whose joined text is the number: an XML file, or an XML entry of a zip.
    A JSON object with the same shape is the value itself."""
    if not _is_element(found) or entry is None:
        return False
    form = entry.get("format")
    if form == "xml":
        return True
    if form != "zip":
        return False
    parts = pointer[1:].split("/")
    if len(parts) < 2 or parts[0] != "entries":
        return False
    kind, item, _ = _locate(view, "/entries/" + parts[1])
    return kind == "value" and isinstance(item, dict) and item.get("format") == "xml"


def _near(at: str, found, expected, tolerance, join: bool):
    """A value compared within a tolerance: numbers, and numeral strings, by their difference. An element's text is
    joined only when join says the view is XML."""
    read = _element_text(found) if join else found
    number = _number(read.strip() if isinstance(read, str) else read)
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
    kind, found, searched = ("none", None, []) if entry is None else _locate(view, check["pointer"], _selector_format(entry, view, check["pointer"]))
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
            # A cut element's kept runs can join into a number the file never held.
            join = _xml_text(entry, view, check["pointer"], found)
            if join and truncated:
                return _undecided(check)
            return _near(at, found, expected, check["tolerance"], join)
        if _same(found, check["value"]):
            return True, f"{at} is {_shown(check['value'])}"
        return False, f"{at} is {_shown(found)}, not {_shown(check['value'])}"
    if truncated:
        return _undecided(check)
    return (True, f"{at} has no value") if kind == "none" else (False, f"{at} is {_shown(found)}")


def _collapse_whitespace(text: str) -> str:
    """Each run of XML whitespace (space, tab, CR, LF) made one space, none at either end, as normalize-space()."""
    return WHITESPACE_RUN.sub(" ", text).strip(" ")


def _text_at(view, pointer: str) -> bool:
    """Whether a string a pointer reaches is text of the document: a member of an element's children (a text node)
    or attributes (an attribute's value), rather than an element's name or a field of the DOCTYPE."""
    segments = pointer.split("/")
    if len(segments) < 3 or segments[-2] not in ("children", "attributes"):
        return False
    kind, owner, _ = _locate(view, "/".join(segments[:-2]))
    return kind == "value" and _is_element(owner)


def _not_xml_entry(check, view):
    """Why a text check's pointer into an archive goes into no XML entry's view, or None when it does or names an
    entry not listed."""
    parts = check["pointer"].split("/")
    if len(parts) < 4 or parts[3] != "view":
        return f"{check['file']} at {check['pointer']} does not point into an entry's view"
    if parts[1] != "entries":
        return None
    kind, item, _ = _locate(view, "/entries/" + parts[2])
    if kind != "value" or not isinstance(item, dict) or item.get("format") == "xml":
        return None
    # An entry without a view failed before this, so its format is one with a view.
    name, form = (value if isinstance(value, str) else "" for value in (item.get("name"), item.get("format")))
    return f"{check['file']} entry {name} is read as {form}, not xml"


def _whole_text(check, entry):
    """An element's whole text, or a text node's, compared with the value or searched for it."""
    view, truncated, problem = _view_of(check, entry, None)
    if problem is not None:
        return False, problem
    at = f"{check['file']} at {check['pointer']}"
    if entry is None:
        return False, f"{at} has no value"
    form = entry.get("format")
    if form not in ("xml", "zip"):
        return False, f"{check['file']} is read as {form}, not xml"
    kind, found, searched = _locate(view, check["pointer"], _selector_format(entry, view, check["pointer"]))
    viewless = _viewless_entry(view, check["pointer"]) if form == "zip" else None
    if viewless is not None:
        return False, f"{check['file']} entry {viewless[0]} {viewless[1]}"
    if any(_array_leaves_out(form, view, array) for array in searched):
        return _undecided(check)
    problem = _not_xml_entry(check, view) if form == "zip" else None
    if problem is not None:
        return False, problem
    if kind == "unresolved":
        return False, f"{at}: {found}"
    if form == "zip":
        truncated = _zip_leaves_out(view, check["pointer"])
    if kind == "none":
        if truncated:
            return False, f"the view of {check['file']} is truncated, so what it leaves out is unknown ({check['pointer']})"
        return False, f"{at} has no value" if found is None else f"{at}: {found}"
    # Only an element has attributes of its own and of its descendants to join.
    attribute = check.get("text_attribute")
    if not ((attribute is None and _text_at(view, check["pointer"])) if isinstance(found, str) else _is_element(found)):
        what = "an element, a text node or an attribute value" if attribute is None else "an element"
        return False, f"{at} is {_shown(found)}, not {what}"
    # A text node is whole. An element's text in a cut view may lack what the cut dropped from its middle.
    if not isinstance(found, str) and truncated:
        return _undecided(check)
    return _compared_text(check, at, _element_text(found, attribute))


def _compared_text(check, at: str, found: str):
    """A text found at a pointer compared with the check's value or searched for it, both collapsed when it asks."""
    collapse = check.get("normalize_whitespace") is True
    text = _collapse_whitespace(found) if collapse else found
    value = _collapse_whitespace(check["value"]) if collapse else check["value"]
    attribute = check.get("text_attribute")
    read = "" if attribute is None else f" in its {attribute} values"
    how = read + (" with whitespace collapsed" if collapse else "")
    if check["kind"] == "text_equals":
        if text == value:
            return True, f"{at} has the text {_shown(value)}{how}"
        return False, f"{at} has the text {_shown(text)}{how}, not {_shown(value)}"
    if value in text:
        return True, f"{at} has text containing {_shown(value)}{how}"
    return False, f"{at} has the text {_shown(text)}{how}, without {_shown(value)}"


def _members(check, entry):
    """How many members of the array at a pointer, or of those a selector matches, compared with the expected
    number."""
    matching, pointer = check.get("matching"), check["pointer"]
    view, truncated, problem = _view_of(check, entry, None)
    if problem is not None:
        return False, problem
    form = None if entry is None else entry.get("format")
    # The empty pointer names the whole view, as a JSON file whose top level is an array.
    kind, found, searched = (("none", None, []) if entry is None else ("value", view, []) if pointer == ""
                             else _locate(view, pointer, _selector_format(entry, view, pointer)))
    at = check["file"] if pointer == "" else f"{check['file']} at {pointer}"
    viewless = _viewless_entry(view, pointer) if form == "zip" else None
    if viewless is not None:
        return False, f"{check['file']} entry {viewless[0]} {viewless[1]}"
    if any(_array_leaves_out(form, view, array) for array in searched):
        return _undecided(check)
    if kind == "unresolved":
        return False, f"{at}: {found}"
    if kind == "none":
        return False, f"{at} has no value" if found is None else f"{at}: {found}"
    if not isinstance(found, list):
        return False, f"{at} is {_shown(found)}, not an array"
    # A count is decided only on an array the view holds whole.
    if _array_leaves_out(form, view, pointer):
        return _undecided(check)
    # The parser refuses a matching that is no selector.
    conditions = None if matching is None else _selector(matching)
    n = len(found) if matching is None else sum(1 for item in found if conditions and _selects(item, conditions, _selector_format(entry, view, pointer)))
    return _compared(check, n, f"member(s) of {at}" + ("" if matching is None else f" matching {matching}"))


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
    if kind in ("text_equals", "text_contains"):
        return _whole_text(check, entry)
    if kind == "member_count":
        return _members(check, entry)
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

/** Seconds, as the verifier's constants spell them. */
const pythonSeconds = (ms: number): string =>
  Number.isInteger(ms / 1000) ? `${String(ms / 1000)}.0` : String(ms / 1000);

/** The verifier's reads of the app until its files settle, as `settledAppData` reads them for the witness. */
const PYTHON_SETTLE = String.raw`

def _files(answer) -> list:
    """Each file data/get returned, by its home path or its place among the parts, with the SHA-256 of its bytes as
    sent: what changes when the app saves."""
    files = []
    for index, part in enumerate(answer.parts):
        if part.kind != "file":
            continue
        marker = (getattr(part, "metadata", None) or {}).get(DATA_OBJECTS)
        path = marker.get("path") if isinstance(marker, dict) else None
        content = getattr(part.file, "bytes", None) or getattr(part.file, "uri", None) or ""
        files.append((path if isinstance(path, str) else f"#{index}", hashlib.sha256(content.encode()).hexdigest()))
    return sorted(files)


async def _read(url):
    answer = await protocol.get_data(url, timeout=120)
    states = [part.data["state"] for part in answer.parts
              if part.kind == "data" and isinstance(part.data.get("state"), dict)]
    if not states:
        raise RuntimeError(f"the {APP} app's data/get returned no state views")
    return states[0], _files(answer)


async def _settled_views(url):
    """The app's views once each file's bytes have held for SETTLE_WINDOW_S, counted from the read that returned them,
    read every SETTLE_INTERVAL_S; else the last completed read's. No read starts SETTLE_BOUND_S or more after the first
    began, and one still running then is cut. Also whether the files had held, and whether a read was cut."""
    start = time.monotonic()
    # The first read is the one a grade needs, so only its own timeout bounds it.
    views, files = await _read(url)
    # Offsets from the first read's start: when the last completed read began, and when a read first returned the
    # bytes it holds.
    began, since = 0.0, time.monotonic() - start
    while began - since < SETTLE_WINDOW_S:
        # Reads come an interval apart, and the one that can settle the files as soon as the window allows.
        at = max(min(began + SETTLE_INTERVAL_S, since + SETTLE_WINDOW_S), time.monotonic() - start)
        if at >= SETTLE_BOUND_S:
            return views, False, False
        await asyncio.sleep(max(0.0, at - (time.monotonic() - start)))
        at = max(at, time.monotonic() - start)
        if at >= SETTLE_BOUND_S:
            return views, False, False
        try:
            latest_views, latest = await asyncio.wait_for(_read(url), SETTLE_BOUND_S - at)
        except asyncio.TimeoutError:
            return views, False, True
        began, views = at, latest_views
        if latest != files:
            since, files = time.monotonic() - start, latest
    return views, True, False
`;

/** Where the verifier's evaluator begins. The task description is everything before it. */
const VERIFIER_EVALUATOR = "\nMISSING = object()\n";
/** The index helper this REA ships, and the one an older export wrote. The older one also accepts a leading zero. */
const CURRENT_INDEX = 'INDEX = re.compile(r"0|[1-9][0-9]*")';
const OLDER_INDEX = 'INDEX = re.compile(r"[0-9]+")';
/** A pointer segment the older index helper reads as an array index and this one does not, such as `01`. */
const LEADING_ZERO_SEGMENT = /^0\d+$/u;

/**
 * The task a verifier states: the app, the checks and the settle timing,
 * without the evaluator that runs them.
 */
export const taskVerifierDescription = (source: string): string | undefined => {
  const at = source.indexOf(VERIFIER_EVALUATOR);
  return at < 0 ? undefined : source.slice(0, at + 1);
};

/** The evaluator, from `MISSING` through `verify`, or undefined when that marker is absent. */
const verifierEvaluator = (source: string): string | undefined => {
  const at = source.indexOf(VERIFIER_EVALUATOR);
  return at < 0 ? undefined : source.slice(at);
};

/** Read one Python literal that `pythonLiteral` wrote, from `source` at `index`. */
const readPythonLiteral = (
  source: string,
  index: number,
): { readonly value: JsonValue; readonly index: number } | undefined => {
  let cursor = index;
  while (cursor < source.length && /\s/u.test(source[cursor] ?? ""))
    cursor += 1;
  const character = source[cursor];
  if (source.startsWith("None", cursor))
    return { value: null, index: cursor + 4 };
  if (source.startsWith("True", cursor))
    return { value: true, index: cursor + 4 };
  if (source.startsWith("False", cursor))
    return { value: false, index: cursor + 5 };
  if (character === '"' || character === "'") {
    let end = cursor + 1;
    let escaped = false;
    while (end < source.length) {
      const next = source[end] ?? "";
      if (escaped) escaped = false;
      else if (next === "\\") escaped = true;
      else if (next === character) break;
      end += 1;
    }
    if (source[end] !== character) return undefined;
    const token = source.slice(cursor, end + 1);
    const value =
      character === '"'
        ? (JSON.parse(token) as string)
        : token.slice(1, -1).replaceAll("\\'", "'");
    return { value, index: end + 1 };
  }
  if (character === "[") {
    const items: JsonValue[] = [];
    cursor += 1;
    while (cursor < source.length) {
      while (cursor < source.length && /\s/u.test(source[cursor] ?? ""))
        cursor += 1;
      if (source[cursor] === "]") return { value: items, index: cursor + 1 };
      const item = readPythonLiteral(source, cursor);
      if (item === undefined) return undefined;
      items.push(item.value);
      cursor = item.index;
      while (cursor < source.length && /\s/u.test(source[cursor] ?? ""))
        cursor += 1;
      if (source[cursor] === ",") cursor += 1;
    }
    return undefined;
  }
  if (character === "{") {
    const record: Record<string, JsonValue> = {};
    cursor += 1;
    while (cursor < source.length) {
      while (cursor < source.length && /\s/u.test(source[cursor] ?? ""))
        cursor += 1;
      if (source[cursor] === "}") return { value: record, index: cursor + 1 };
      const key = readPythonLiteral(source, cursor);
      if (key === undefined || typeof key.value !== "string") return undefined;
      cursor = key.index;
      while (cursor < source.length && /\s/u.test(source[cursor] ?? ""))
        cursor += 1;
      if (source[cursor] !== ":") return undefined;
      const item = readPythonLiteral(source, cursor + 1);
      if (item === undefined) return undefined;
      record[key.value] = item.value;
      cursor = item.index;
      while (cursor < source.length && /\s/u.test(source[cursor] ?? ""))
        cursor += 1;
      if (source[cursor] === ",") cursor += 1;
    }
    return undefined;
  }
  const number = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
    source.slice(cursor),
  );
  if (number?.[0] === undefined) return undefined;
  return { value: Number(number[0]), index: cursor + number[0].length };
};

/** Pointers of the checks a verifier states. A pointer inside a check's value is not one. */
const describedPointers = (description: string): readonly string[] => {
  const at = description.indexOf("CHECKS = ");
  if (at < 0) return [];
  const parsed = readPythonLiteral(description, at + "CHECKS = ".length);
  if (parsed === undefined || !Array.isArray(parsed.value)) return [];
  return parsed.value.flatMap((check) =>
    typeof check === "object" &&
    check !== null &&
    !Array.isArray(check) &&
    typeof check.pointer === "string"
      ? [check.pointer]
      : [],
  );
};

/**
 * Whether two verifiers grade the same task the same way. The description must
 * match. The evaluator must be this REA's, or the older index helper alone
 * when no pointer segment is a leading-zero number, which that helper would
 * index and this one would not.
 */
export const sameTaskVerifier = (hosted: string, bundled: string): boolean => {
  const expected = taskVerifierDescription(hosted);
  const found = taskVerifierDescription(bundled);
  if (expected === undefined || expected !== found) return false;
  const hostedBody = verifierEvaluator(hosted);
  const bundledBody = verifierEvaluator(bundled);
  if (hostedBody === undefined || bundledBody === undefined) return false;
  if (hostedBody === bundledBody) return true;
  const indexed = describedPointers(expected).some((pointer) =>
    pointer.split("/").some((segment) => LEADING_ZERO_SEGMENT.test(segment)),
  );
  return (
    bundledBody === hostedBody.replace(CURRENT_INDEX, OLDER_INDEX) && !indexed
  );
};

/** The verifier artifact: read the app's state through its data/get once its files settle, then evaluate the task's checks. */
export const renderTaskVerifier = (task: DesktopTask, app: string): string =>
  `"""Checks of the task ${task.name} against the ${app} app's state, exported by REA from a desktop application capture.

It reads the app's data/get through the computer, takes the typed views of its files and evaluates each check: no
model, no code from the task. It grades once the app's files settle, since an app can save a few seconds after the
last change: each result's settled says whether they had held for SETTLE_WINDOW_S, or had not by SETTLE_BOUND_S and
the last completed read was graded, and read_cut whether a read still running at SETTLE_BOUND_S was cut. A failure to
reach the app raises, so the run fails rather than scoring the agent.
"""
import asyncio
import hashlib
import json
import math
import re
import time

from agentenv_protocol import client as protocol
from agentenv_protocol.types import RPC_PATH

APP = ${JSON.stringify(app)}
CHECKS = [
${task.checks.map((check) => `    ${pythonLiteral(check as unknown as JsonValue)},`).join("\n")}
]
#: The app's data/get is read this often until its files settle.
SETTLE_INTERVAL_S = ${pythonSeconds(SETTLE_TIMING.intervalMs)}
#: How long each file's bytes must hold, from the read that returned them, before the views are graded.
SETTLE_WINDOW_S = ${pythonSeconds(SETTLE_TIMING.windowMs)}
#: After the first read began: no read starts then or later, one still running is cut, and the last completed read is
#: graded though the files are still changing.
SETTLE_BOUND_S = ${pythonSeconds(SETTLE_TIMING.boundMs)}
#: Where a data/get file part names its path in the home.
DATA_OBJECTS = "urn:agentenv:data-objects/v1"
${PYTHON_TASK_EVALUATOR}${PYTHON_SETTLE}

async def verify(mcp_url, env_url):
    card = await protocol.get_card(env_url)
    child = protocol.find_child(card, APP)
    if child is None:
        raise RuntimeError(f"the computer at {env_url} lists no app named {APP}")
    views, settled, read_cut = await _settled_views(env_url + (child.get("url") or RPC_PATH).removesuffix(RPC_PATH))
    return [{**result, "settled": settled, "read_cut": read_cut} for result in evaluate(CHECKS, views)]
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
