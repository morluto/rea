import { execFileSync } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  PYTHON_HELPERS,
  PYTHON_IMPORTS,
} from "../../../src/domain/desktop/appExportPython.js";
import {
  detectStateFormat,
  jsonView,
} from "../../../src/domain/desktop/stateFormats.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

/** The exported module's view format for each file, run with only its standard library imports. */
const pythonFormats = (files: readonly (readonly [string, string])[]) => {
  const imports = PYTHON_IMPORTS.split("\n")
    .filter((line) => !line.includes("agentenv_protocol"))
    .join("\n");
  const program = `${imports}${PYTHON_HELPERS}
for name, text in json.load(sys.stdin):
    print(_text_view(name, text)["format"])
`;
  return execFileSync("python3", ["-I", "-B", "-c", program], {
    input: JSON.stringify(files),
    encoding: "utf8",
  })
    .trim()
    .split("\n");
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
    ["big.json", '{"id":9007199254740993}'],
    ["long.json", `{"id":${"9".repeat(5000)}}`],
  ] as const;

  const formats = pythonFormats(files);

  expect(formats).toEqual(["text", "text", "json", "json"]);
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
CAPTURED_HOME = "/home/ada"
${PYTHON_HELPERS}
for data in json.load(sys.stdin):
    print(_respelled_utf16(bytes.fromhex(data), Path("/home/user")).hex())
`;
  return execFileSync("python3", ["-I", "-B", "-c", program], {
    input: JSON.stringify(files),
    encoding: "utf8",
  })
    .trim()
    .split("\n");
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
  return execFileSync(
    "python3",
    [
      "-I",
      "-B",
      "-c",
      `${imports}\nCAPTURED_HOME = "/home/ada"\n${PYTHON_HELPERS}\nprint(_taskbar_window(sys.argv[1]))`,
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
    print(json.dumps(_text_view("a.json", text)))
`;
  return execFileSync("python3", ["-I", "-B", "-c", program], {
    input: JSON.stringify(texts),
    encoding: "utf8",
  })
    .trim()
    .split("\n")
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

it("spells infinite and negative-zero SQLite reals as REA's SQLite reader does", () => {
  const imports = PYTHON_IMPORTS.split("\n")
    .filter((line) => !line.includes("agentenv_protocol"))
    .join("\n");
  const cells = execFileSync(
    "python3",
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
