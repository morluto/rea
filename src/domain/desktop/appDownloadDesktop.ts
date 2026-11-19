import {
  DESKTOP_ENTRY_GROUP,
  DESKTOP_GROUP,
  DESKTOP_KEY,
  DESKTOP_KEY_SEPARATOR,
  DESKTOP_VALUE_ESCAPE,
  DESKTOP_VALUE_ESCAPES,
  ENV_PREFIX,
  ENV_UNSET_NAME,
  ENV_WRAPPER,
  EXEC_LEXEME,
  QUOTED_ESCAPE,
} from "./desktopLaunchSyntax.js";
import { PYTHON_ECMASCRIPT_TRIM_CHARACTERS } from "./desktopTextSyntax.js";

const pythonJson = (value: unknown): string =>
  `json.loads(${JSON.stringify(JSON.stringify(value))})`;

/** Run the desktop launch grammar in Python, retaining raw source spans so
 * the installer can replace one program without reformatting its arguments. */
export const rewriteAppImageDesktop = String.raw`import json
import re
import sys
from pathlib import Path
from shutil import copyfile

source, destination, app_run, svg_icons, pixmaps = sys.argv[1:]
value_escapes = ${pythonJson(DESKTOP_VALUE_ESCAPES)}
value_lexeme = re.compile(${pythonJson(String.raw`${DESKTOP_VALUE_ESCAPE}|([\s\S])`)})
exec_lexeme = re.compile(${pythonJson(EXEC_LEXEME)})
quoted_escape = re.compile(${pythonJson(QUOTED_ESCAPE)})
env_wrapper = re.compile(${pythonJson(ENV_WRAPPER)})
env_unset_name = re.compile(${pythonJson(ENV_UNSET_NAME)})
env_phases = ${pythonJson(ENV_PREFIX)}
group_header = re.compile(${pythonJson(DESKTOP_GROUP)})
entry_key = re.compile(${pythonJson(`(${DESKTOP_KEY})${DESKTOP_KEY_SEPARATOR}`)})
desktop_entry_group = ${pythonJson(DESKTOP_ENTRY_GROUP)}
action_group = re.compile(${pythonJson(`Desktop Action ${DESKTOP_KEY}`)})
trim_characters = ${PYTHON_ECMASCRIPT_TRIM_CHARACTERS}

def desktop_value_characters(raw):
    for part in value_lexeme.finditer(raw):
        escaped, character = part.groups()
        yield character if escaped is None else value_escapes[escaped], part.end()

def exec_tokens(raw):
    # Decode the value layer while recording where its characters came from.
    value, offsets = [], [0]
    for character, end in desktop_value_characters(raw):
        value.append(character)
        offsets.append(end)
    value = "".join(value)

    tokens, parts = [], []
    cursor = 0
    while cursor < len(value):
        part = exec_lexeme.match(value, cursor)
        if part is None:
            raise ValueError("unterminated quote in desktop Exec")
        quoted, unquoted, separator = part.groups()
        if separator is not None:
            if parts:
                tokens.append(("".join(parts), offsets[start], offsets[cursor]))
                parts = []
        else:
            if not parts:
                start = cursor
            parts.append(unquoted if quoted is None else quoted_escape.sub(r"\1", quoted))
        cursor = part.end()
    if parts:
        tokens.append(("".join(parts), offsets[start], offsets[cursor]))
    return tokens

def program_span(raw):
    tokens = exec_tokens(raw)
    index = 0
    if tokens and env_wrapper.fullmatch(tokens[0][0]):
        index = 1
        directory, clear_environment, unsets = None, False, []
        for phase in env_phases:
            while index < len(tokens):
                for rule in phase["rules"]:
                    matched = re.fullmatch(rule["pattern"], tokens[index][0])
                    if matched is None:
                        continue
                    index += 1
                    kind = rule["kind"]
                    if kind == "clear" or ("clear" in rule and matched[rule["clear"]]):
                        clear_environment = True
                    if kind in ("chdir", "unset"):
                        value = matched[rule["operand"]] if "operand" in rule else None
                        if value is None:
                            value = tokens[index][0] if index < len(tokens) else ""
                            index += 1
                        if kind == "chdir":
                            directory = value
                        else:
                            unsets.append(value)
                    break
                else:
                    break
                if not phase["repeat"]:
                    break
        if not clear_environment and any(env_unset_name.fullmatch(name) is None for name in unsets):
            raise ValueError("invalid env unset name in desktop Exec")
        if directory == "":
            raise ValueError("missing env chdir directory in desktop Exec")
    if index >= len(tokens) or not tokens[index][0]:
        raise ValueError("missing program in desktop Exec")
    return tokens[index][1:]

def line_end(line):
    if line.endswith("\r\n"):
        return len(line) - 2
    if line.endswith("\n"):
        return len(line) - 1
    return len(line)

# GLib merges repeated groups and selects the last declaration of each key.
# Only effective launch commands need to be parsed or rewritten.
with open(source, encoding="utf-8", newline="\n") as f:
    lines = f.readlines()
group = ""
execs = {}
icon = ""
for index, line in enumerate(lines):
    header = group_header.fullmatch(line.strip(trim_characters))
    if header:
        group = header[1]
        continue
    if group != desktop_entry_group and not action_group.fullmatch(group):
        continue
    indent = len(line) - len(line.lstrip(trim_characters))
    key = entry_key.match(line, indent)
    if not key:
        continue
    if key[1] == "Exec":
        execs[group] = index, key.end()
    elif group == desktop_entry_group:
        if key[1] == "TryExec":
            # Remove every declaration so an earlier one cannot become effective.
            lines[index] = ""
        elif key[1] == "Icon":
            icon = line[key.end():line_end(line)]

for index, value_start in sorted(execs.values()):
    line = lines[index]
    value_end = line_end(line)
    raw = line[value_start:value_end]
    start, end = program_span(raw)
    lines[index] = line[:value_start] + raw[:start] + app_run + raw[end:] + line[value_end:]
with open(destination, "w", encoding="utf-8", newline="") as f:
    f.writelines(lines)

icon = "".join(character for character, _ in desktop_value_characters(icon))
if icon and "/" not in icon and "\x00" not in icon:
    root = Path(source).parent
    for suffix, folder in ((".svg", svg_icons), (".png", pixmaps)):
        name = icon + suffix
        if (root / name).is_file():
            target = Path(folder)
            target.mkdir(parents=True, exist_ok=True)
            copyfile(root / name, target / name)
            break
`;
