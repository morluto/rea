import {
  execFileSync,
  type ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  PYTHON_HELPERS,
  PYTHON_IMPORTS,
} from "../../../src/domain/desktop/appExportPython.js";
import {
  detectStateFormat,
  keyfileView,
  isJsonText,
  jsonView,
  textualView,
} from "../../../src/domain/desktop/stateFormats.js";
import { safeParseJson } from "../../../src/domain/safeJson.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

/** Keep the exported Python helpers out of the host command-line size limit. */
const execPython = (
  args: string[],
  options: ExecFileSyncOptionsWithStringEncoding,
): string => {
  const directory = mkdtempSync(join(tmpdir(), "rea-export-python-"));
  const script = join(directory, "fixture.py");
  const codeIndex = args.indexOf("-c");
  try {
    writeFileSync(script, args[codeIndex + 1]!, "utf8");
    return execFileSync(
      process.platform === "win32" ? "python" : "python3",
      [
        "-X",
        "utf8",
        ...args.slice(0, codeIndex),
        script,
        ...args.slice(codeIndex + 2),
      ],
      options,
    );
  } finally {
    unlinkSync(script);
    rmdirSync(directory);
  }
};

/** The exported module's view format for each file, run with only its standard library imports. */
const pythonFormats = (files: readonly (readonly [string, string])[]) => {
  const imports = PYTHON_IMPORTS.split("\n")
    .filter((line) => !line.includes("agentenv_protocol"))
    .join("\n");
  const program = `${imports}${PYTHON_HELPERS}
for name, text in json.load(sys.stdin):
    print(_text_view(name, text, len(text.encode()))["format"])
`;
  return execPython(["-I", "-B", "-c", program], {
    input: JSON.stringify(files),
    encoding: "utf8",
  })
    .trim()
    .split(/\r?\n/u);
};

it("detects key files by the state view's rule rather than a name or any group header", () => {
  const files = [
    ["list.txt", "Groceries\n[x]\nmilk\n"],
    ["settings.ini", "free text\n"],
    ["app.conf", "wrap=false\n"],
    ["settings", "# saved\n[ui]\nwrap=false\n\n; end\n"],
    ["notes.rc", "[a]\r\nkey = value\r\n"],
  ] as const;

  const formats = pythonFormats(files);

  expect(formats).toEqual(["text", "text", "text", "keyfile", "keyfile"]);
  expect(formats).toEqual(
    files.map(([name, text]) =>
      detectStateFormat(name, new TextEncoder().encode(text)),
    ),
  );
});

it("keeps JSON Lines holding a number it cannot read exactly as text, as REA does", () => {
  const lines = '{"id":9007199254740993}\n{"id":2}\n';
  const files = [
    ["events.jsonl", lines],
    ["events.json", lines],
    ["events.JSON", "42"],
    ["big.json", '{"id":9007199254740993}'],
    ["long.json", `{"id":${"9".repeat(5000)}}`],
  ] as const;

  const formats = pythonFormats(files);

  expect(formats).toEqual(["text", "text", "json", "json", "json"]);
  expect(formats).toEqual(
    files.map(([name, text]) =>
      detectStateFormat(name, new TextEncoder().encode(text)),
    ),
  );
});

/** The exported module's UTF-16 seed respelling of each file, from /home/ada to /home/user, as hex. */
const pythonUtf16Respelled = (files: readonly string[]) => {
  const imports = PYTHON_IMPORTS.split("\n")
    .filter((line) => !line.includes("agentenv_protocol"))
    .join("\n");
  const program = `${imports}
from pathlib import PurePosixPath
SEED_HOME = "/home/ada"
${PYTHON_HELPERS}
for data in json.load(sys.stdin):
    print(_respelled_utf16(bytes.fromhex(data), PurePosixPath("/home/user")).hex())
`;
  return execPython(["-I", "-B", "-c", program], {
    input: JSON.stringify(files),
    encoding: "utf8",
  })
    .trim()
    .split(/\r?\n/u);
};

const utf16 = (text: string, order: "le" | "be") => {
  const le = Buffer.from(`﻿${text}`, "utf16le");
  return order === "le" ? le : Buffer.from(le).swap16();
};

it("respells the captured home in UTF-16 seeds with a byte-order mark, keeping the mark and order", () => {
  const work = "# build\n20260216;1;/home/ada/.varicad\n";
  const files = [
    utf16(work, "le"),
    utf16(work, "be"),
    utf16("/home/adam/x\n", "le"),
    utf16("no home here\n", "le"),
    Buffer.from([0xff, 0xfe, 0x41]),
    Buffer.from("/home/ada/plain\n"),
  ];

  const respelled = pythonUtf16Respelled(
    files.map((file) => file.toString("hex")),
  );

  const expected = "# build\n20260216;1;/home/user/.varicad\n";
  expect(respelled).toEqual([
    utf16(expected, "le").toString("hex"),
    utf16(expected, "be").toString("hex"),
    ...files.slice(2).map((file) => file.toString("hex")),
  ]);
});

it("seeds each file the bundle lists in SEED_MODES with that mode, as a lock whose app checks it stays 0600", async () => {
  const root = await createTestTempDirectory("desktop-seed-modes-");
  await mkdir(join(root, "seed", ".config", "notes"), { recursive: true });
  await writeFile(
    join(root, "seed", ".config", "notes", "secret.ini"),
    "[s]\n",
  );
  await writeFile(join(root, "seed", "run.sh"), "#!/bin/sh\n");
  const imports = PYTHON_IMPORTS.split("\n")
    .filter((line) => !line.includes("agentenv_protocol"))
    .join("\n");
  const program = `${imports}
SEED_HOME = "/home/ada"
TEXT_SEEDS = frozenset()
SEED_MODES = {".config/notes/secret.ini": 0o600, "run.sh": 0o755}
HERE = Path(sys.argv[1])
${PYTHON_HELPERS}
_seed_home(Path(sys.argv[2]))
`;

  execFileSync("python3", [
    "-I",
    "-B",
    "-c",
    program,
    root,
    join(root, "home"),
  ]);

  const mode = async (path: string) =>
    (await stat(join(root, "home", path))).mode & 0o777;
  expect(await mode(".config/notes/secret.ini")).toBe(0o600);
  expect(await mode("run.sh")).toBe(0o755);
});

it.each([true, false])(
  "restores nested selected aliases in either selection order (%s)",
  async (childFirst) => {
    const root = await createTestTempDirectory("desktop-nested-alias-");
    const home = join(root, "home");
    await mkdir(join(home, ".config", "notes"), { recursive: true });
    await writeFile(join(home, ".config", "notes", "profile.ini"), "profile");
    const imports = PYTHON_IMPORTS.split("\n")
      .filter((line) => !line.includes("agentenv_protocol"))
      .join("\n");
    const pairs = childFirst
      ? '[("settings/profile", ".config/notes"), ("settings", ".local/share/notes")]'
      : '[("settings", ".local/share/notes"), ("settings/profile", ".config/notes")]';
    const program = `${imports}
STATE_ALIASES = ${pairs}
${PYTHON_HELPERS}
home = Path(sys.argv[1])
_ensure_state_aliases(home)
_ensure_state_aliases(home)
`;
    execPython(["-I", "-B", "-c", program, home], { encoding: "utf8" });
    expect(
      await readFile(join(home, "settings", "profile", "profile.ini"), "utf8"),
    ).toBe("profile");
  },
);

it("restores a selected settings alias without replacing an existing path", async () => {
  const root = await createTestTempDirectory("desktop-state-alias-");
  const home = join(root, "home");
  await mkdir(join(root, "seed", ".config", "notes"), { recursive: true });
  await writeFile(
    join(root, "seed", ".config", "notes", "settings.ini"),
    "saved",
  );
  await mkdir(join(root, "seed", ".config", "notes", "profiles", "work"), {
    recursive: true,
  });
  await writeFile(
    join(root, "seed", ".config", "notes", "profiles", "work", "profile.ini"),
    "profile",
  );
  const imports = PYTHON_IMPORTS.split("\n")
    .filter((line) => !line.includes("agentenv_protocol"))
    .join("\n");
  const program = `${imports}
SEED_HOME = "/home/ada"
TEXT_SEEDS = frozenset()
SEED_MODES = {}
STATE_ALIASES = [("settings", ".config/notes")]
HERE = Path(sys.argv[1])
${PYTHON_HELPERS}
home = Path(sys.argv[2])
_seed_home(home)
_ensure_state_aliases(home)
_ensure_state_aliases(home)
`;
  execPython(["-I", "-B", "-c", program, root, home], { encoding: "utf8" });
  expect(await readFile(join(home, "settings", "settings.ini"), "utf8")).toBe(
    "saved",
  );
  expect(
    await readFile(
      join(home, "settings", "profiles", "work", "profile.ini"),
      "utf8",
    ),
  ).toBe("profile");
  const other = join(root, "other-home");
  await mkdir(other);
  await writeFile(join(other, "settings"), "preserve");
  expect(() =>
    execPython(["-I", "-B", "-c", program, root, other], {
      encoding: "utf8",
      stdio: "pipe",
    }),
  ).toThrow();
  expect(await readFile(join(other, "settings"), "utf8")).toBe("preserve");
});

/** A stand-in xprop answering the root window list and each window's class and state from a table. */
const fakeXprop = async (windows: Record<string, string>) => {
  const bin = await createTestTempDirectory("desktop-xprop-");
  const table = JSON.stringify(windows);
  await writeFile(
    join(bin, "xprop"),
    `#!/usr/bin/env python3
import json, sys
windows = json.loads(${JSON.stringify(table)})
if sys.argv[1:3] == ["-root", "_NET_CLIENT_LIST"]:
    print("_NET_CLIENT_LIST(WINDOW): window id # " + ", ".join(windows))
else:
    print(windows[sys.argv[2]])
`,
  );
  await chmod(join(bin, "xprop"), 0o755);
  return bin;
};

const taskbarWindow = (bin: string, windowClass: string): string => {
  const imports = PYTHON_IMPORTS.split("\n")
    .filter((line) => !line.includes("agentenv_protocol"))
    .join("\n");
  return execPython(
    [
      "-I",
      "-B",
      "-c",
      `${imports}\nfrom pathlib import PurePosixPath
SEED_HOME = "/home/ada"\n${PYTHON_HELPERS}\nprint(_taskbar_window(sys.argv[1]))`,
      windowClass,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    },
  ).trim();
};

it("holds readiness until a window of the app's class that the taskbar lists is shown, not its splash", async () => {
  const splash =
    'WM_CLASS(STRING) = "varicad", "varicad"\n_NET_WM_STATE(ATOM) = _NET_WM_STATE_SKIP_PAGER, _NET_WM_STATE_SKIP_TASKBAR, _NET_WM_STATE_ABOVE';
  const main =
    'WM_CLASS(STRING) = "varicad", "varicad"\n_NET_WM_STATE(ATOM) = _NET_WM_STATE_MAXIMIZED_HORZ, _NET_WM_STATE_FOCUSED';
  const other =
    'WM_CLASS(STRING) = "mousepad", "Mousepad"\n_NET_WM_STATE(ATOM) = ';

  expect(taskbarWindow(await fakeXprop({ "0x1": splash }), "varicad")).toBe(
    "False",
  );
  expect(
    taskbarWindow(await fakeXprop({ "0x1": splash, "0x2": main }), "varicad"),
  ).toBe("True");
  expect(
    taskbarWindow(await fakeXprop({ "0x1": splash, "0x3": other }), "varicad"),
  ).toBe("False");
  expect(taskbarWindow(await fakeXprop({ "0x3": other }), "Mousepad")).toBe(
    "True",
  );
  const typedSplash =
    'WM_CLASS(STRING) = "varicad", "varicad"\n_NET_WM_STATE(ATOM) = \n_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_SPLASH';
  expect(
    taskbarWindow(await fakeXprop({ "0x4": typedSplash }), "varicad"),
  ).toBe("False");
});

/** The exported module's JSON verdict for each text, with only its standard library imports: its view or its error. */
const pythonJson = (texts: readonly string[]) => {
  const imports = PYTHON_IMPORTS.split("\n")
    .filter((line) => !line.includes("agentenv_protocol"))
    .join("\n");
  const program = `${imports}${PYTHON_HELPERS}
for text in json.load(sys.stdin):
    print(json.dumps(_text_view("a.json", text, len(text.encode()))))
`;
  return execPython(["-I", "-B", "-c", program], {
    input: JSON.stringify(texts),
    encoding: "utf8",
  })
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as { view: unknown; error?: string });
};

it("refuses the JSON numbers REA's state view refuses, as JSON with an error rather than an infinity", () => {
  const texts = [
    '{"a": 1e999}',
    '{"a": -1e999}',
    '{"a": 12345678901234567890}',
    '{"a": -0}',
    '{"a": -0.0}',
    '{"a": 0.12345678901234567890}',
    '{"a": 1e20}',
    '{"a": 0.1, "b": 1e21, "c": 42, "d": 9007199254740991}',
    '{"a": 9007199254740993, "a": 1}',
    '{"a": 1, "a": 9007199254740993}',
  ];

  const python = pythonJson(texts);

  texts.forEach((text, index) => {
    const typescript = jsonView(text);
    const verdict = python[index];
    expect(verdict?.error === undefined).toBe(typescript.ok);
    if (typescript.ok) expect(verdict?.view).toEqual(typescript.value);
  });
});

/** The exported module's format, view and error for each named text, and REA's for the same bytes. */
const textViews = (files: readonly (readonly [string, string])[]) => {
  const imports = PYTHON_IMPORTS.split("\n")
    .filter((line) => !line.includes("agentenv_protocol"))
    .join("\n");
  const program = `${imports}${PYTHON_HELPERS}
for name, text in json.load(sys.stdin):
    view = _text_view(name, text, len(text.encode()))
    print(json.dumps({"format": view["format"], "view": view["view"], "error": view.get("error")}))
`;
  const python = execPython(["-I", "-B", "-c", program], {
    input: JSON.stringify(files),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
  const rea = files.map(([name, text]) => {
    const bytes = new TextEncoder().encode(text);
    const format = detectStateFormat(name, bytes);
    if (format !== "text" && format !== "json" && format !== "keyfile")
      throw new Error(`${name} reads as ${format}`);
    const read = textualView(format, bytes);
    return read.ok
      ? { format, view: read.value, error: null }
      : { format, view: null, error: read.error };
  });
  return { python, rea };
};

it("reads text nested past Python's recursion limit as JSON only when all of it is, as REA does", () => {
  const brackets = (open: number, close: number) =>
    `${"[".repeat(open)}${"]".repeat(close)}`;
  const files = [
    ["deep.txt", brackets(1100, 1099)],
    ["deep.json", brackets(1100, 1099)],
    ["deep.txt", brackets(1100, 1100)],
    ["deep.json", `${brackets(1100, 1100)} x`],
  ] as const;

  const { python, rea } = textViews(files);

  expect(python).toEqual(rea);
  expect(rea.map(({ format, error }) => [format, error])).toEqual([
    ["text", null],
    ["text", null],
    ["json", "nested deeper than the 500 levels a JSON view keeps"],
    ["text", null],
  ]);
});

it("refuses JSON and key files over 4 MiB as REA does, telling JSON apart from text without parsing it", () => {
  const objects = `[{}${",{}".repeat(1_400_000)}]`;
  const files = [
    ["objects.json", objects],
    ["objects", `${objects.slice(0, -1)}}`],
    ["settings", `[ui]\n${"wrap=false\n".repeat(400_000)}`],
    ["log", `[0] ${"x".repeat(4_200_000)}`],
  ] as const;

  const { python, rea } = textViews(files);

  expect(python).toEqual(rea);
  const refused = "larger than the 4 MiB limit for JSON and key file views";
  expect(rea.map(({ format, error }) => [format, error])).toEqual([
    ["json", refused],
    ["text", null],
    ["keyfile", refused],
    ["text", null],
  ]);
});

it("checks text for JSON the way REA does, token by token, without parsing it", () => {
  const [bom, nbsp, lineSeparator] = [0xfeff, 0xa0, 0x2028].map((code) =>
    String.fromCharCode(code),
  );
  const texts = [
    ["-0", "01", "1.", "1E+5", "-", "[1.5e+]", "truex", "[NaN]"],
    ['"\\u00e9"', '"\\u00g9"', '"\\x"', '"\t"', '"a', '"\\uD800"'],
    ["", " [1] ", "[1] x", "{}{}", `${bom}[1]`, `[1]${nbsp}`],
    [`["${lineSeparator}"]`, "[]", "[1,]", "[,1]", "[1 2]", "[1]]", "[[1]"],
    ["[}", "{}", '{"a":1}', '{"a" 1}', "{a:1}", '{"a":1,}', '{"a"::1}'],
    ["{1:2}", '{"a":[1,{"b":null}],"c":-1.5e-3}'],
  ].flat();
  const imports = PYTHON_IMPORTS.split("\n")
    .filter((line) => !line.includes("agentenv_protocol"))
    .join("\n");

  const python = JSON.parse(
    execPython(
      [
        "-I",
        "-B",
        "-c",
        `${imports}${PYTHON_HELPERS}\ntexts = json.load(sys.stdin)\nprint(json.dumps({"syntax": [_read_json(text, build=False) is not _INVALID_JSON for text in texts], "built": [_read_json(text) is not _INVALID_JSON for text in texts]}))`,
      ],
      { input: JSON.stringify(texts), encoding: "utf8" },
    ),
  ) as { syntax: boolean[]; built: boolean[] };

  const parsed = texts.map((text) => safeParseJson(text).ok);
  expect(texts.map((text) => isJsonText(text))).toEqual(parsed);
  expect(python.syntax).toEqual(parsed);
  expect(python.built).toEqual(parsed);
  expect(parsed.filter(Boolean)).toHaveLength(10);
});

it("checks JSON depth with one iterator per level, copying no wide list", () => {
  const imports = PYTHON_IMPORTS.split("\n")
    .filter((line) => !line.includes("agentenv_protocol"))
    .join("\n");
  const program = `${imports}
import tracemalloc
${PYTHON_HELPERS}
wide = [None] * 800_000
tracemalloc.start()
deep = _deeper_than(wide, 500)
peak = tracemalloc.get_traced_memory()[1]
tracemalloc.stop()
nested = []
for _ in range(501):
    nested = [nested]
print(json.dumps({"deep": deep, "peak": peak, "edge": _deeper_than(nested, 501), "over": _deeper_than(nested, 500)}))
`;

  const result = JSON.parse(
    execPython(["-I", "-B", "-c", program], { encoding: "utf8" }),
  ) as { deep: boolean; peak: number; edge: boolean; over: boolean };

  expect(result).toMatchObject({ deep: false, edge: false, over: true });
  // Queuing each member of the 800,000-item list traced about 51 MB.
  expect(result.peak).toBeLessThan(1024 * 1024);
});

it("spells infinite and negative-zero SQLite reals as REA's SQLite reader does", () => {
  const imports = PYTHON_IMPORTS.split("\n")
    .filter((line) => !line.includes("agentenv_protocol"))
    .join("\n");
  const cells = execPython(
    [
      "-I",
      "-B",
      "-c",
      `${imports}${PYTHON_HELPERS}\nprint(json.dumps([_cell(v, "utf-8") for v in (math.inf, -math.inf, -0.0, 0.0, 1.5)]))`,
    ],
    { encoding: "utf8" },
  );

  expect(JSON.parse(cells)).toEqual(["Infinity", "-Infinity", "-0", 0, 1.5]);
});

it("keeps the same keyfile whitespace as the retained state view", async () => {
  const inputs = [
    "[ui]\nsuffix=hello \nunicode=\u00a0hello\u00a0\npadded=   hello\n",
    "[ui]\r\nsuffix=hello  \r\nunicode=\u00a0hello\u00a0\u00a0\r\npadded=\thello\r\n",
  ];
  const imports = PYTHON_IMPORTS.split("\n")
    .filter((line) => !line.includes("agentenv_protocol"))
    .join("\n");
  const program = `${imports}${PYTHON_HELPERS}
print(json.dumps([_text_view("settings.ini", text, len(text.encode()))["view"]["groups"] for text in json.load(sys.stdin)]))
`;
  const root = await createTestTempDirectory("rea-keyfile-python-");
  const script = join(root, "fixture.py");
  await writeFile(script, program, "utf8");
  const output = execFileSync(
    process.platform === "win32" ? "python" : "python3",
    ["-I", "-B", "-X", "utf8", script],
    {
      input: JSON.stringify(inputs),
      encoding: "utf8",
    },
  );
  expect(JSON.parse(output)).toEqual(inputs.map(keyfileView));
});
