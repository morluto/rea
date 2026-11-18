import { expect, it } from "vitest";

import {
  formatCliOutput,
  prepareDelimitedOutput,
} from "../../../src/cli/cliOutputFormatter.js";

it.each([
  [
    " \t\u00a0\u202f\u2003\u2028\u2029\ufeff",
    "&#32;&#9;&#160;&#8239;&#8195;&#8232;&#8233;&#65279;",
  ],
  ["\u00a0🙂\ufeff", "&#160;🙂&#65279;"],
  ["\u00a0\u0000\u202f", "&#160;\\\\u0000&#8239;"],
  ["\u00a0\r\n\u202f", "&#160;<br>&#8239;"],
  ["\v \u00a0x\u202f \f", "\v \u00a0x\u202f \f"],
  [" \v\u00a0x\u202f\f ", "&#32;\v\u00a0x\u202f\f&#32;"],
])(
  "preserves Markdown table edge spacing in the header and cell for %j",
  (value, expected) => {
    const [header, , row] = formatCliOutput([{ [value]: value }], "md").split(
      "\n",
    );
    expect(header).toBe(`| ${expected} |`);
    expect(row).toBe(`| ${expected} |`);
  },
);

it.each<[string, unknown, "toon" | "json" | "yaml" | "jsonl", string]>([
  ["no value as TOON", null, "toon", ""],
  ["no value as JSON", undefined, "json", ""],
  ["no value as YAML", null, "yaml", ""],
  ["a scalar as TOON", 12, "toon", "12"],
  ["text as TOON", "text", "toon", "text"],
  [
    "an object as TOON",
    { a: 1, b: [1, 2], c: { d: "x" } },
    "toon",
    "a: 1\nb[2]: 1,2\nc:\n  d: x",
  ],
  [
    "rows as TOON",
    [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ],
    "toon",
    "[2]{id,name}:\n  1,a\n  2,b",
  ],
  ["JSON object text as JSON", '  {"a":1}  ', "json", '{\n  "a": 1\n}'],
  ["JSON array text as JSON", "[1,2]", "json", "[\n  1,\n  2\n]"],
  ["malformed JSON text as JSON", "{not json", "json", '"{not json"'],
  ["plain text as JSON", "plain", "json", '"plain"'],
  [
    "nested BigInt values as JSON",
    { big: 9007199254740993n, nested: [1n, { x: 2n }] },
    "json",
    '{\n  "big": "9007199254740993",\n  "nested": [\n    "1",\n    {\n      "x": "2"\n    }\n  ]\n}',
  ],
  [
    "a BigInt value as JSON Lines",
    { big: 9007199254740993n },
    "jsonl",
    '{"big":"9007199254740993"}',
  ],
  ["rows as JSON Lines", [{ a: 1 }, { a: 2 }], "jsonl", '{"a":1}\n{"a":2}'],
  [
    "an object as YAML",
    { a: 1, b: [1, 2] },
    "yaml",
    "a: 1\nb:\n  - 1\n  - 2\n",
  ],
])("formats %s", (_name, value, format, expected) => {
  expect(formatCliOutput(value, format)).toBe(expected);
});

const parseDelimited = (source: string, delimiter: string): string[][] => {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else cell += character;
      continue;
    }
    if (character === '"' && cell.length === 0) {
      quoted = true;
      continue;
    }
    if (character === delimiter) {
      record.push(cell);
      cell = "";
      continue;
    }
    if (character === "\r" || character === "\n") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      record.push(cell);
      records.push(record);
      record = [];
      cell = "";
      continue;
    }
    cell += character;
  }
  if (cell.length > 0 || record.length > 0) {
    record.push(cell);
    records.push(record);
  }
  return records;
};

it.each([
  { format: "csv" as const, delimiter: "," },
  { format: "tsv" as const, delimiter: "\t" },
])(
  "round-trips escaped $format fields and Unicode values",
  ({ format, delimiter }) => {
    const rows = [
      {
        name: 'A, "quoted" name',
        note: "first line\r\nsecond\tline — café 雪",
        count: 0,
        ignored: { nested: true },
      },
      { name: "", note: "", count: false },
      { name: "欠", count: null },
    ];
    const output = formatCliOutput(rows, format, {
      fields: ["name", "note", "count"],
      metadata: {
        version: 1,
        coverage: { status: "page", examined: 3, total: 8, next_offset: 3 },
        view: { offset: 0, limit: 3 },
      },
    });
    const lineEnding = format === "csv" ? "\r\n" : "\n";
    const metadataEnd = output.indexOf(lineEnding);
    const metadataLine = output.slice(0, metadataEnd);
    const records = output
      .slice(metadataEnd + lineEnding.length)
      .replace(/\r?\n$/u, "");
    expect(
      JSON.parse(metadataLine!.slice("# rea-delimited-v1 ".length)),
    ).toEqual({
      version: 1,
      coverage: { status: "page", examined: 3, total: 8, next_offset: 3 },
      view: { offset: 0, limit: 3 },
    });
    expect(parseDelimited(records, delimiter)).toEqual([
      ["name", "note", "count"],
      ['A, "quoted" name', "first line\r\nsecond\tline — café 雪", "0"],
      ["", "", "false"],
      ["欠", "", ""],
    ]);
  },
);

it.each(["  =1+1", "+1", "-1", "@SUM(A1:A2)"])(
  "refuses formula-leading string cells without changing the source value %j",
  (value) => {
    const row = { target: value };
    const result = prepareDelimitedOutput([row], "csv", {
      fields: ["target"],
      metadata: {},
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        userMessage: expect.stringContaining("formula-leading"),
      },
    });
    expect(row.target).toBe(value);
  },
);

it("refuses formula-leading column headers", () => {
  expect(
    prepareDelimitedOutput([{ value: "safe" }], "csv", {
      fields: ["=header"],
      metadata: {},
    }),
  ).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
});
