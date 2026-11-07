/** The verifier's XML elements, pointers and selectors, kept equal to `viewPointer`'s; it relies on `INDEX` and `_collapse_whitespace`. */
export const PYTHON_POINTER = String.raw`def _is_element(value) -> bool:
    return (isinstance(value, dict) and isinstance(value.get("name"), str) and isinstance(value.get("attributes"), dict)
            and isinstance(value.get("children"), list))


def _element_text(element, attribute=None) -> str:
    """An element's text as XPath's string() reads it from what the view keeps: every text node among its children
    and its descendants', in document order. With attribute, the values of that attribute on it and its descendants
    instead, in document order, and no text node."""
    parts, pending = [], [element]
    while pending:
        node = pending.pop()
        if isinstance(node, str):
            if attribute is None:
                parts.append(node)
        elif _is_element(node):
            if attribute is not None and isinstance(node["attributes"].get(attribute), str):
                parts.append(node["attributes"][attribute])
            pending.extend(reversed(node["children"]))
    return "".join(parts)


def _bracketed(token: str) -> bool:
    return len(token) >= 2 and token.startswith("[") and token.endswith("]")


def _selector(token: str):
    """A selector's conditions, [KEY=VALUE], [@KEY=VALUE] or [>KEY=VALUE] one or more times, or None when the token
    is not one."""
    if not _bracketed(token):
        return None
    conditions = []
    for part in token[1:-1].split("]["):
        key, equals, value = part.partition("=")
        prefix = key[:1] if key[:1] in ("@", ">") else ""
        name = key[len(prefix):]
        if not equals or not name:
            return None
        conditions.append((prefix, name, value))
    return conditions


_ISO_STAMP = re.compile(
    r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$"
)


def _text_without_stamps(node) -> str:
    """An element's text with ISO save-time leaves removed, matching the selector that named it."""
    if isinstance(node, str):
        return "" if _ISO_STAMP.fullmatch(node.strip()) else node
    if not _is_element(node):
        return ""
    return "".join(_text_without_stamps(child) for child in node["children"])


def _has_child_text(member, key: str, value: str) -> bool:
    """Whether an element has a child element named key whose text, its whitespace collapsed, is value."""
    return _is_element(member) and any(
        _is_element(child) and child["name"] == key and _collapse_whitespace(_text_without_stamps(child)) == value
        for child in member["children"])


def _selects(member, conditions) -> bool:
    """Whether an array member meets every condition; selectors compare strings only."""
    if not isinstance(member, dict):
        return False
    for prefix, key, value in conditions:
        if prefix == ">":
            if not _has_child_text(member, key, value):
                return False
            continue
        fields = member.get("attributes") if prefix == "@" else member
        if not isinstance(fields, dict) or not isinstance(fields.get(key), str) or fields[key] != value:
            return False
    return True


def _step(items: list, token: str, last: bool):
    """One step into an array, by index or by a selector that must match one member, or none when it is the last."""
    if INDEX.fullmatch(token):
        # A canonical decimal longer than the array length cannot name a member.
        if len(token) > len(str(len(items))):
            return "none", None
        index = int(token)
        return ("member", items[index]) if index < len(items) else ("none", None)
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
`;
