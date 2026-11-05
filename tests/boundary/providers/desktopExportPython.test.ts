import { execFileSync } from "node:child_process";

import { expect, it } from "vitest";

import {
  PYTHON_HELPERS,
  PYTHON_IMPORTS,
} from "../../../src/domain/desktop/appExportPython.js";
import {
  detectStateFormat,
  jsonView,
} from "../../../src/domain/desktop/stateFormats.js";

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
      `${imports}${PYTHON_HELPERS}\nprint(json.dumps([_cell(v) for v in (math.inf, -math.inf, -0.0, 0.0, 1.5)]))`,
    ],
    { encoding: "utf8" },
  );

  expect(JSON.parse(cells)).toEqual(["Infinity", "-Infinity", "-0", 0, 1.5]);
});
