/** Python used by the offline installer to locate the program in a desktop Exec value.
 * It follows desktopEntry's value unescaping, command quoting and env-prefix rules;
 * the original spelling of all other arguments remains intact. */
export const rewriteAppImageDesktop = String.raw`import re
import sys

source, destination, app_run = sys.argv[1:]
escapes = {"s": " ", "n": "\n", "t": "\t", "r": "\r", "\\": "\\"}

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
        while index < len(tokens) and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tokens[index][0]):
            index += 1
    if index >= len(tokens) or not tokens[index][0]:
        raise ValueError("missing program in desktop Exec")
    return tokens[index][1:]

with open(source, encoding="utf-8") as f:
    lines = f.readlines()
with open(destination, "w", encoding="utf-8") as f:
    for line in lines:
        if line.startswith("TryExec="):
            continue
        if line.startswith("Exec="):
            raw = line[5:].rstrip("\n")
            start, end = program_span(raw)
            line = "Exec=" + raw[:start] + app_run + raw[end:] + "\n"
        f.write(line)
`;
