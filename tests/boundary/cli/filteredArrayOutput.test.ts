import { Writable } from "node:stream";

import { Cli, Formatter } from "incur";
import { estimateTokenCount } from "tokenx";
import { expect, it } from "vitest";

import { parseCliOutputArguments } from "../../../src/cliOutput.js";
import {
  createCliResultOutput,
  streamCliCommandResults,
} from "../../../src/cli/cliResultOutput.js";

const source = [{ selected: 1 }, { other: 2 }, { selected: null }];

const freezeRecursively = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  for (const child of Object.values(value)) freezeRecursively(child);
  return Object.freeze(value);
};

const runFilteredCli = async (
  value: unknown,
  format: "json" | "jsonl" | "yaml" | "toon" | "md",
  filter?: string,
): Promise<string> => {
  const cli = Cli.create("filtered-array-test", { sync: false });
  cli.command("rows", { run: () => value });
  const args = [
    "rows",
    "--format",
    format,
    ...(filter === undefined ? [] : ["--filter-output", filter]),
  ];
  const chunks: Buffer[] = [];
  const output = createCliResultOutput(
    parseCliOutputArguments(args),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    }),
  );
  if (output === undefined) throw new Error("Missing CLI output owner");
  streamCliCommandResults(cli, output);
  let fallback = "";
  await cli.serve(args, {
    exit: (code) => {
      expect(code).toBe(0);
    },
    stdout: (text) => {
      if (!output.handled) fallback += text;
    },
  });
  expect(fallback).toBe("");
  expect(output.handled).toBe(true);
  expect(output.failed).toBe(false);
  return Buffer.concat(chunks).toString("utf8");
};

it("renders only each record's own fields in heterogeneous Markdown tables", async () => {
  const value: unknown = JSON.parse(
    '[{"name":"first","constructor":"ctor","toString":"text","__proto__":"proto","enabled":false,"count":0},{"name":"second"},{"name":"third","constructor":0,"toString":false,"__proto__":null}]',
  );
  freezeRecursively(value);
  const json = await runFilteredCli(value, "json");
  expect(JSON.parse(json)).toEqual(value);
  const markdown = await runFilteredCli(value, "md");
  const rows = markdown
    .trim()
    .split("\n")
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  expect(rows[0]).toEqual([
    "name",
    "constructor",
    "toString",
    "__proto__",
    "enabled",
    "count",
  ]);
  expect(rows.slice(2)).toEqual([
    ["first", "ctor", "text", "proto", "false", "0"],
    ["second", "", "", "", "", ""],
    ["third", "0", "false", "null", "", ""],
  ]);
});

it.each(
  (["json", "jsonl"] as const).flatMap((format) =>
    [false, true].map((full) => ({ format, full })),
  ),
)(
  "preserves filtered array positions in $format (full: $full)",
  async ({ format, full }) => {
    const value = Object.freeze(
      source.map((item) => Object.freeze({ ...item })),
    );
    const cli = Cli.create("filtered-array-test", { sync: false });
    cli.command("rows", { run: () => value });
    const args = [
      "rows",
      "--format",
      format,
      "--filter-output",
      "selected",
      ...(full ? ["--full-output"] : []),
    ];
    const chunks: Buffer[] = [];
    const output = createCliResultOutput(
      parseCliOutputArguments(args),
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
      }),
    );
    if (output === undefined) throw new Error("Missing CLI output owner");
    streamCliCommandResults(cli, output);
    let fallback = "";
    let status = 0;
    await cli.serve(args, {
      stdout: (text) => {
        if (!output.handled) fallback += text;
      },
      exit: (code) => {
        status = code;
      },
    });
    const text = Buffer.concat(chunks).toString("utf8");
    if (full && format === "jsonl") {
      const records = text
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.slice(0, -1)).toEqual([1, null, null]);
      expect(records.at(-1)).toMatchObject({
        $rea: "jsonl/v1",
        type: "metadata",
        records: { path: ["data"], emitted: 3, source: 3, filter: "selected" },
        context: { ok: true, meta: { command: "rows" } },
      });
    } else if (full)
      expect(JSON.parse(text)).toMatchObject({
        ok: true,
        data: [1, null, null],
        meta: { command: "rows" },
      });
    else if (format === "json")
      expect(JSON.parse(text)).toEqual([1, null, null]);
    else expect(text).toBe("1\nnull\nnull\n");
    expect(fallback).toBe("");
    expect(status).toBe(0);
    expect(output.handled).toBe(true);
    expect(output.failed).toBe(false);
    expect(value).toEqual(source);
  },
);

it.each(["json", "jsonl"] as const)(
  "counts the normalized filtered %s records",
  async (format) => {
    const cli = Cli.create("filtered-count-test", { sync: false });
    cli.command("rows", { run: () => source });
    const args = [
      "rows",
      "--format",
      format,
      "--filter-output",
      "selected",
      "--token-count",
    ];
    const chunks: Buffer[] = [];
    const output = createCliResultOutput(
      parseCliOutputArguments(args),
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
      }),
    );
    if (output === undefined) throw new Error("Missing CLI output owner");
    streamCliCommandResults(cli, output);
    let fallback = "";
    await cli.serve(args, {
      exit: (code) => {
        expect(code).toBe(0);
      },
      stdout: (text) => {
        if (!output.handled) fallback += text;
      },
    });
    expect(Buffer.concat(chunks).toString()).toBe(
      `${estimateTokenCount(Formatter.format([1, null, null], format))}\n`,
    );
    expect(fallback).toBe("");
  },
);

it.each(["selected", "toString", "constructor"])(
  "normalizes only owned nested selection arrays for %s",
  async (filter) => {
    const value = [[{ selected: false }, {}], [{ selected: 0 }], []];
    const before = structuredClone(value);
    const chunks: Buffer[] = [];
    const output = createCliResultOutput(
      parseCliOutputArguments(["--json", "--filter-output", filter]),
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
      }),
    );
    await output?.write(value, {
      command: "rows",
      duration: "0ms",
      format: "json",
    });
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual(
      filter === "selected"
        ? [[false, null], [0], []]
        : [[null, null], [null], []],
    );
    expect(value).toEqual(before);
  },
);

it("finishes JSONL after a bounded large record before a missing selection", async () => {
  const value = [{ selected: "x".repeat(80 * 1024) }, {}];
  const chunks: Buffer[] = [];
  const output = createCliResultOutput(
    parseCliOutputArguments([
      "--format",
      "jsonl",
      "--filter-output",
      "selected",
    ]),
    new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        setImmediate(callback);
      },
    }),
  );
  if (output === undefined) throw new Error("Missing CLI output owner");
  await output.write(value, {
    command: "rows",
    duration: "0ms",
    format: "jsonl",
  });
  const lines = Buffer.concat(chunks).toString().trimEnd().split("\n");
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    value[0]?.selected,
    null,
  ]);
  expect(output.failed).toBe(false);
});

it("does not invent selected JSON members from the object prototype", async () => {
  const value = freezeRecursively({ selected: { present: 7 } });
  const output = await runFilteredCli(value, "json", "selected.__proto__");
  expect(JSON.parse(output)).toEqual({ selected: {} });
  expect(value).toEqual({ selected: { present: 7 } });
});

it("escapes table delimiters and line breaks in Markdown cells", async () => {
  const value = freezeRecursively({
    selected: {
      pipe: "left|right",
      backslash: "left\\right",
      lines: "first line\nsecond line",
    },
  });

  const output = await runFilteredCli(value, "md", "selected");

  expect(output).toContain("left\\|right");
  expect(output).toContain("left\\\\right");
  expect(output).toContain("first line<br>second line");
  expect(output).not.toContain("left|right");
  expect(value.selected).toEqual({
    pipe: "left|right",
    backslash: "left\\right",
    lines: "first line\nsecond line",
  });
});

const projectionSource = freezeRecursively([
  {
    rows: [
      { id: 0, left: "l0", right: "r0", retained: [0, 10] },
      { id: 1, left: "l1", right: "r1", retained: [1, 11] },
      { id: 2, left: "l2", right: "r2", retained: [2, 12] },
      { id: 3, left: "l3", right: "r3", retained: [3, 13] },
    ],
  },
]);

const overlappingPaths = [
  "rows[0,3].left,rows[1,4].right",
  "rows[1,4].right,rows[0,3].left",
] as const;

it.each(["json", "jsonl", "yaml", "toon", "md"] as const)(
  "unions overlapping sibling slices independent of path order in %s",
  async (format) => {
    const expected = [
      {
        rows: [
          { left: "l0" },
          { left: "l1", right: "r1" },
          { left: "l2", right: "r2" },
          { right: "r3" },
        ],
      },
    ];
    const outputs = await Promise.all(
      overlappingPaths.map((filter) =>
        runFilteredCli(projectionSource, format, filter),
      ),
    );
    expect(outputs[0]).toBe(outputs[1]);
    if (format === "json") expect(JSON.parse(outputs[0]!)).toEqual(expected);
    else if (format === "jsonl")
      expect(
        outputs[0]!
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual(expected);
    else if (format === "md") {
      expect(outputs[0]).toContain(`| ${JSON.stringify(expected[0]!.rows)} |`);
      expect(outputs[0]).not.toContain("[object Object]");
    } else expect(outputs[0]).toBe(`${Formatter.format(expected, format)}\n`);
    expect(projectionSource[0]?.rows[0]?.retained).toEqual([0, 10]);
  },
);

const parentAndChildPaths = [
  "rows[0,2],rows[1,3].right",
  "rows[1,3].right,rows[0,2]",
] as const;

it.each(["json", "jsonl", "yaml", "toon", "md"] as const)(
  "preserves missing selected array values in %s",
  async (format) => {
    const value = freezeRecursively([{ selected: 1 }, {}, { selected: null }]);
    const selected = [1, undefined, null];
    const output = await runFilteredCli(value, format, "selected");
    if (format === "json") expect(JSON.parse(output)).toEqual([1, null, null]);
    else if (format === "jsonl")
      expect(
        output
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([1, null, null]);
    else if (format === "md") expect(output).toBe("[1,null,null]\n");
    else expect(output).toBe(`${Formatter.format(selected, format)}\n`);
    expect(value).toEqual([{ selected: 1 }, {}, { selected: null }]);
  },
);

it.each(["json", "jsonl", "yaml", "toon", "md"] as const)(
  "lets whole-parent selection dominate child paths without mutating source in %s",
  async (format) => {
    const expected = [
      {
        rows: [
          projectionSource[0]!.rows[0],
          projectionSource[0]!.rows[1],
          { right: "r2" },
        ],
      },
    ];
    const before = structuredClone(projectionSource);
    const outputs = await Promise.all(
      parentAndChildPaths.map((filter) =>
        runFilteredCli(projectionSource, format, filter),
      ),
    );
    expect(outputs[0]).toBe(outputs[1]);
    if (format === "json") expect(JSON.parse(outputs[0]!)).toEqual(expected);
    else if (format === "jsonl")
      expect(
        outputs[0]!
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual(expected);
    else if (format === "md") {
      expect(outputs[0]).toContain(`| ${JSON.stringify(expected[0]!.rows)} |`);
      expect(outputs[0]).not.toContain("[object Object]");
    } else expect(outputs[0]).toBe(`${Formatter.format(expected, format)}\n`);
    expect(projectionSource).toEqual(before);
  },
);
