import { PYTHON_EXACT_JSON_NUMBER } from "./pythonExactJsonNumber.js";

/** JSON parsing and bounded retained-view checks for exported desktop environments. */
export const PYTHON_JSON_READER = String.raw`
#: A JSON token after any whitespace, by group: an opening, a closing, a comma, a colon, a string's quote, or a number
#: or literal. Strings are read by json's scanner, since a pattern repeating per escape holds memory for each.
JSON_TOKEN = re.compile(r'[ \t\n\r]*(?:([\[{])|([\]}])|(,)|(:)|(")|(-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?'
                        r"|true|false|null))")
JSON_SPACE = re.compile(r"[ \t\n\r]*")


${PYTHON_EXACT_JSON_NUMBER}
_INEXACT = object()
_DEEP = object()
_DEEP_INEXACT = object()
_LEVEL_END = object()
_INVALID_JSON = object()
JSON_ATOMS = {"true": True, "false": False, "null": None}


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
        item = next(levels[-1], _LEVEL_END)
        if item is _LEVEL_END:
            levels.pop()
        elif item is _INEXACT or item is _DEEP_INEXACT:
            return True
        elif isinstance(item, dict):
            levels.append(iter(item.values()))
        elif isinstance(item, list):
            levels.append(iter(item))
    return False


def _deeper_than(root, limit: int) -> bool:
    """Whether a parsed JSON value nests deeper than a limit, as REA checks it: a value's depth is the number of
    iterators open above it, one per nesting level, so no child list is copied."""
    levels = [iter((root,))]
    while levels:
        item = next(levels[-1], _LEVEL_END)
        if item is _LEVEL_END:
            levels.pop()
        elif item is _DEEP or item is _DEEP_INEXACT:
            return True
        elif len(levels) - 1 > limit:
            return True
        elif isinstance(item, dict):
            levels.append(iter(item.values()))
        elif isinstance(item, list):
            levels.append(iter(item))
    return False


def _read_json(text: str, build: bool = True):
    """One JSON value, or _INVALID_JSON, read without recursion so duplicate keys settle before depth is checked.
    Deep containers are summarized rather than built; exact-number marks still follow last-key-wins semantics.
    With build=False, only syntax is checked: one byte per open container and one decoded string at a time."""
    containers, expect, empty, at = bytearray(), "value", False, 0
    values, keys, root = [], [], _INVALID_JSON
    deep_bad, deep_key_at, bad_keys = bytearray(), array("I"), {}

    def keep(value) -> None:
        nonlocal root
        if not values:
            root = value
        elif containers[-1] == ord("["):
            values[-1].append(value)
        else:
            values[-1][keys[-1]] = value

    def record_deep(bad: bool) -> None:
        """Summarize a finished child; keep only object keys with live inexact values."""
        depth = len(deep_bad) - 1
        if containers[-1] == ord("["):
            deep_bad[-1] |= 2 | bad
            return
        marked = bad_keys.get(depth)
        if bad or marked is not None:
            key, _ = json.decoder.scanstring(text, deep_key_at[-1])
            if bad:
                if marked is None:
                    marked = key
                elif isinstance(marked, str):
                    if marked != key:
                        marked = {marked, key}
                else:
                    marked.add(key)
            else:
                if isinstance(marked, str):
                    if marked == key:
                        marked = None
                else:
                    marked.discard(key)
                    if len(marked) == 1:
                        marked = next(iter(marked))
            if marked is None:
                bad_keys.pop(depth, None)
            else:
                bad_keys[depth] = marked
            deep_bad[-1] = 2 | (marked is not None)
        else:
            deep_bad[-1] |= 2

    while True:
        token = JSON_TOKEN.match(text, at)
        if token is None:
            break
        kind, at = token.lastindex, token.end()
        if kind == 5:
            string_at = at
            try:
                value, at = json.decoder.scanstring(text, at)
            except ValueError:
                return _INVALID_JSON
        if kind == 1 and expect == "value":
            if build:
                if deep_bad or len(containers) >= MAX_JSON_VIEW_DEPTH:
                    deep_bad.append(0)
                    deep_key_at.append(0)
                else:
                    value = [] if text[at - 1] == "[" else {}
                    keep(value)
                    values.append(value)
                    keys.append(None)
            containers.append(ord(text[at - 1]))
            expect, empty = ("value" if text[at - 1] == "[" else "key"), True
        # A closing bracket's code is its opening's plus two.
        elif kind == 2 and (expect == "after" or empty) and containers and containers[-1] == ord(text[at - 1]) - 2:
            opening = containers.pop()
            if build:
                if deep_bad:
                    state = deep_bad.pop()
                    bad = bool(state & 1)
                    deep_key_at.pop()
                    bad_keys.pop(len(deep_bad), None)
                    if deep_bad:
                        record_deep(bad)
                    else:
                        keep((_DEEP_INEXACT if bad else _DEEP) if state & 2 else ([] if opening == ord("[") else {}))
                else:
                    values.pop()
                    keys.pop()
            expect, empty = "after", False
        elif kind == 3 and expect == "after" and containers:
            expect = "value" if containers[-1] == ord("[") else "key"
        elif kind == 4 and expect == "colon":
            expect = "value"
        elif kind >= 5 and (expect == "value" or (kind == 5 and expect == "key")):
            if build:
                if expect == "key":
                    if deep_bad:
                        deep_key_at[-1] = string_at
                    else:
                        keys[-1] = value
                else:
                    if kind == 6:
                        value = JSON_ATOMS.get(token[6], _INVALID_JSON)
                        if value is _INVALID_JSON:
                            value = _number_or_mark(token[6])
                    if deep_bad:
                        record_deep(value is _INEXACT)
                    else:
                        keep(value)
            expect, empty = ("colon" if expect == "key" else "after"), False
        else:
            return _INVALID_JSON
    if expect != "after" or containers or JSON_SPACE.fullmatch(text, at) is None:
        return _INVALID_JSON
    return root if build else True


def _json_view(text: str, size: int):
    """A JSON text's format and view, or why it has none, as REA reads it; None when it is not JSON. Text over the
    parsed-view limit is told apart without building its value."""
    if size > MAX_PARSED_BYTES:
        valid = _read_json(text, build=False) is not _INVALID_JSON
        return {"format": "json", "view": None, "error": PARSED_TOO_LARGE} if valid else None
    # The whole text must parse, and duplicate keys settle, before an inexact number makes it JSON with an error.
    view = _read_json(text)
    if view is _INVALID_JSON:
        return None
    if _holds_inexact(view):
        return {"format": "json", "view": None,
                "error": "a number in it cannot be read exactly, such as an integer above 2^53"}
    if _deeper_than(view, MAX_JSON_VIEW_DEPTH):
        return {"format": "json", "view": None, "error": JSON_TOO_DEEP}
    return {"format": "json", "view": view, "truncated": False}

`;
