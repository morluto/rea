/** Python used by the offline installer to locate the program in a desktop Exec value.
 * It follows desktopEntry's key spacing, value unescaping, command quoting and env-prefix rules;
 * the original spelling of all other arguments remains intact. */
export const rewriteAppImageDesktop = String.raw`import re
import sys

source, destination, app_run = sys.argv[1:]
escapes = {"s": " ", "n": "\n", "t": "\t", "r": "\r", "\\": "\\"}
launch_key = re.compile(r"[ \t]*(TryExec|Exec)[ \t]*=[ \t]*")

def program_span(raw):
    # Keep raw offsets while decoding the desktop value, so rewriting preserves
    # field codes and all original argument spelling.
    value, offsets = [], []
    i = 0
    while i < len(raw):
        start = i
        if raw[i] == "\\" and i + 1 < len(raw) and raw[i + 1] in escapes:
            value.append(escapes[raw[i + 1]])
            i += 2
        else:
            value.append(raw[i])
            i += 1
        offsets.append((start, i))
    tokens = []
    token = None
    start = 0
    quoted = False
    i = 0
    while i < len(value):
        c = value[i]
        if quoted:
            if c == "\\" and i + 1 < len(value) and value[i + 1] in ('"', "\u0060", "$", "\\"):
                token += value[i + 1]
                i += 1
            elif c == '"':
                quoted = False
            else:
                token += c
        elif c == '"':
            quoted = True
            if token is None:
                token = ""
                start = i
        elif c in (" ", "\t"):
            if token is not None:
                tokens.append((token, offsets[start][0], offsets[i - 1][1]))
                token = None
        else:
            if token is None:
                token = ""
                start = i
            token += c
        i += 1
    if quoted:
        raise ValueError("unterminated quote in desktop Exec")
    if token is not None:
        tokens.append((token, offsets[start][0], offsets[-1][1]))
    index = 0
    if tokens and tokens[0][0].split("/")[-1] == "env":
        index = 1
        directory = None
        while index < len(tokens):
            option = tokens[index][0]
            if option == "--ignore-environment" or re.fullmatch(r"-i+", option):
                index += 1
                continue
            short_directory = re.fullmatch(r"-i*C(.*)", option, re.DOTALL)
            if option == "--chdir" or (short_directory and not short_directory[1]):
                index += 1
                directory = tokens[index][0] if index < len(tokens) else ""
            elif option.startswith("--chdir="):
                directory = option[len("--chdir="):]
            elif short_directory:
                directory = short_directory[1]
            elif option in ("-u", "--unset") or option.startswith(("-u", "--unset=")):
                if option in ("-u", "--unset"):
                    index += 1
                    name = tokens[index][0] if index < len(tokens) else ""
                elif option.startswith("--unset="):
                    name = option[len("--unset="):]
                else:
                    name = option[2:]
                if not name or "=" in name:
                    raise ValueError("invalid env unset operand in desktop Exec")
            else:
                break
            index += 1
        if directory == "":
            raise ValueError("missing env chdir directory in desktop Exec")
        if index < len(tokens) and tokens[index][0] == "--":
            index += 1
        if index < len(tokens) and tokens[index][0] == "-":
            index += 1
        while index < len(tokens) and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tokens[index][0]):
            index += 1
    if index >= len(tokens) or not tokens[index][0]:
        raise ValueError("missing program in desktop Exec")
    return tokens[index][1:]

with open(source, encoding="utf-8") as f:
    lines = f.readlines()
with open(destination, "w", encoding="utf-8") as f:
    for line in lines:
        key = launch_key.match(line)
        if key and key.group(1) == "TryExec":
            continue
        if key:
            raw = line[key.end():].rstrip("\n")
            start, end = program_span(raw)
            line = "Exec=" + raw[:start] + app_run + raw[end:] + "\n"
        f.write(line)
`;
