import {
  DESKTOP_KEY_SEPARATOR,
  DESKTOP_VALUE_ESCAPE,
  DESKTOP_VALUE_ESCAPES,
  ENV_PREFIX,
  ENV_UNSET_NAME,
  ENV_WRAPPER,
  EXEC_LEXEME,
  QUOTED_ESCAPE,
} from "./desktopLaunchSyntax.js";

const pythonJson = (value: unknown): string =>
  `json.loads(${JSON.stringify(JSON.stringify(value))})`;

/** Run the desktop launch grammar in Python, retaining raw source spans so
 * the installer can replace one program without reformatting its arguments. */
export const rewriteAppImageDesktop = String.raw`import json
import re
import sys

source, destination, app_run = sys.argv[1:]
value_escapes = ${pythonJson(DESKTOP_VALUE_ESCAPES)}
value_lexeme = re.compile(${pythonJson(String.raw`${DESKTOP_VALUE_ESCAPE}|([\s\S])`)})
exec_lexeme = re.compile(${pythonJson(EXEC_LEXEME)})
quoted_escape = re.compile(${pythonJson(QUOTED_ESCAPE)})
env_wrapper = re.compile(${pythonJson(ENV_WRAPPER)})
env_unset_name = re.compile(${pythonJson(ENV_UNSET_NAME)})
env_phases = ${pythonJson(ENV_PREFIX)}
launch_key = re.compile(${pythonJson(String.raw`[ \t]*(TryExec|Exec)${DESKTOP_KEY_SEPARATOR}`)})

def exec_tokens(raw):
    # Decode the value layer while recording where its characters came from.
    value, offsets = [], [0]
    for part in value_lexeme.finditer(raw):
        escaped, character = part.groups()
        value.append(character if escaped is None else value_escapes[escaped])
        offsets.append(part.end())
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

rewritten = []
with open(source, encoding="utf-8", newline="\n") as f:
    for line in f:
        key = launch_key.match(line)
        if key and key.group(1) == "TryExec":
            continue
        if key:
            newline = "\r\n" if line.endswith("\r\n") else "\n" if line.endswith("\n") else ""
            raw = line[key.end():len(line) - len(newline)]
            start, end = program_span(raw)
            line = line[:key.end()] + raw[:start] + app_run + raw[end:] + newline
        rewritten.append(line)
with open(destination, "w", encoding="utf-8", newline="") as f:
    f.writelines(rewritten)
`;
