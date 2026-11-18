/** Number parsing shared by exported state views and task readers. */
export const PYTHON_EXACT_JSON_NUMBER = String.raw`
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


`;
