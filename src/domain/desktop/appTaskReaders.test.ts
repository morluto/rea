import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { parseDesktopTask } from "./appTask.js";
import { evaluateTaskChecks, type TaskFileView } from "./appTaskChecks.js";
import { renderTaskVerifier } from "./appTaskPython.js";
import {
  PYTHON_READER_RUNNER,
  readerAnswerView,
  readerCommand,
} from "./appTaskReaders.js";

const portable = (name: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name);
const POSTER = "Documents/poster.xcf";

const LAYERS = {
  id: "layers",
  file: POSTER,
  argv: ["gimp-console-2.10", "-i", "-b", "-"],
  stdin: '(gimp-file-load RUN-NONINTERACTIVE "{file}" "{file}")',
  output: "lines",
};
const LAYER_CHECK = {
  id: "renamed",
  kind: "lines_present",
  file: POSTER,
  reader: "layers",
  lines: ["layer Summer Sale"],
};

const parse = (change: Record<string, unknown>) =>
  parseDesktopTask(
    {
      name: "rename-layer",
      prompt: "In GIMP, rename the Headline layer to Summer Sale and save it.",
      checks: [LAYER_CHECK],
      readers: [LAYERS],
      ...change,
    },
    portable,
  );

/** Task changes the parser refuses for its readers, each with part of its message. */
const REFUSALS: readonly (readonly [Record<string, unknown>, string])[] = [
  [
    { checks: [{ ...LAYER_CHECK, reader: "objects" }] },
    'reader "objects", which the task does not define',
  ],
  [
    { checks: [{ ...LAYER_CHECK, file: "Documents/other.xcf" }] },
    "reads layers, so its file is Documents/poster.xcf",
  ],
  [{ readers: [{ ...LAYERS, stdin: "(gimp-quit 0)" }] }, "name no {file}"],
  [{ readers: [LAYERS, LAYERS] }, 'two readers have the id "layers"'],
  [
    {
      readers: [LAYERS, { ...LAYERS, id: "unused" }],
    },
    'reader "unused" is read by no check',
  ],
  [
    { readers: [{ ...LAYERS, file: "/home/ada/x.xcf" }] },
    "without a leading slash",
  ],
  [
    {
      checks: [
        {
          kind: "value_equals",
          file: POSTER,
          reader: "layers",
          pointer: "/0",
          value: 1,
        },
      ],
    },
    "reads lines, which lines_present, lines_absent and line_count check",
  ],
  [
    {
      checks: [
        {
          kind: "text_contains",
          file: POSTER,
          reader: "layers",
          pointer: "/0",
          value: "x",
        },
      ],
    },
    "at checks.0",
  ],
  [{ readers: [{ ...LAYERS, id: "Layers" }] }, "at readers.0.id"],
  [{ readers: [{ ...LAYERS, timeout_s: 301 }] }, "at readers.0.timeout_s"],
];

describe("task readers", () => {
  it("keeps readers that checks read through", () => {
    const parsed = parse({});
    expect(parsed).toMatchObject({
      ok: true,
      value: { readers: [LAYERS], checks: [LAYER_CHECK] },
    });
  });

  it("leaves readers out of a task that has none", () => {
    const parsed = parse({
      readers: undefined,
      checks: [{ kind: "file_present", file: POSTER }],
    });
    expect(parsed.ok && "readers" in parsed.value).toBe(false);
  });

  it.each(REFUSALS)("refuses %j", (change, message) => {
    const parsed = parse(change);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });

  it("evaluates a check on its reader's view rather than the file's own", () => {
    const parsed = parse({
      checks: [
        LAYER_CHECK,
        {
          id: "moved",
          kind: "value_equals",
          file: "Documents/scene.blend",
          reader: "objects",
          pointer: "/Crate/location/0",
          value: 2,
          tolerance: 0.001,
        },
        {
          id: "count",
          kind: "member_count",
          file: "Documents/scene.blend",
          reader: "objects",
          pointer: "/Crate/location",
          equals: 3,
        },
      ],
      readers: [
        LAYERS,
        {
          id: "objects",
          file: "Documents/scene.blend",
          argv: ["blender", "-b", "{file}"],
          output: "json",
        },
      ],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const files = new Map<string, TaskFileView>([
      [POSTER, { format: "binary", view: null }],
      ["Documents/scene.blend", { format: "binary", view: null }],
    ]);
    const readers = new Map<string, TaskFileView>([
      [
        "layers",
        {
          format: "text",
          view: {
            lines: ["layer Summer Sale", "layer Background"],
            line_count: 2,
            truncated: false,
          },
        },
      ],
      [
        "objects",
        { format: "json", view: { Crate: { location: [2.0004, 0, 0] } } },
      ],
    ]);

    const outcomes = evaluateTaskChecks(parsed.value.checks, files, readers);
    expect(outcomes.map(({ id, passed }) => [id, passed])).toEqual([
      ["renamed", true],
      ["moved", true],
      ["count", true],
    ]);
    // The file's own view is binary, which the same check without its reader cannot read.
    expect(
      evaluateTaskChecks(
        [{ ...LAYER_CHECK, reader: undefined }] as never,
        files,
        readers,
      )[0]?.description,
    ).toContain("is binary");
  });

  it("fails a check whose reader failed as undecided with the reader's reason, and one whose file is absent as decided", () => {
    const parsed = parse({});
    if (!parsed.ok) throw new Error(parsed.error);
    const failed = new Map<string, TaskFileView>([
      [
        "layers",
        {
          format: null,
          view: null,
          error: "the reader exited 1: GIMP could not open the file",
        },
      ],
    ]);
    expect(evaluateTaskChecks(parsed.value.checks, new Map(), failed)).toEqual([
      {
        id: "renamed",
        passed: false,
        undecided: true,
        description: `${POSTER} has no view: the reader exited 1: GIMP could not open the file`,
      },
    ]);
    const [absent] = evaluateTaskChecks(
      parsed.value.checks,
      new Map(),
      new Map(),
    );
    expect(absent?.passed).toBe(false);
    expect(absent?.undecided).toBeUndefined();
  });
});

describe("the reader runner's command and answer", () => {
  it("runs the runner's source in the computer's Python with the reader's arguments", () => {
    const [python, isolated, flag, source, argument] = readerCommand(
      {
        id: "objects",
        file: "Documents/scene.blend",
        argv: ["blender", "-b", "{file}"],
        output: "json",
        timeout_s: 20,
      },
      "/tmp/end/scene.blend",
    );
    expect([python, isolated, flag, source]).toEqual([
      "python3",
      "-I",
      "-c",
      PYTHON_READER_RUNNER,
    ]);
    expect(JSON.parse(argument ?? "")).toEqual({
      id: "objects",
      path: "/tmp/end/scene.blend",
      name: "scene.blend",
      argv: ["blender", "-b", "{file}"],
      stdin: null,
      output: "json",
      timeout_s: 20,
      display: false,
    });
  });

  it("names the file by its home path when no other path is given, with the default timeout", () => {
    const argument = readerCommand(
      { id: "layers", file: POSTER, argv: ["gimp", "{file}"], output: "lines" },
      undefined,
    ).at(-1);
    expect(JSON.parse(argument ?? "")).toMatchObject({
      path: POSTER,
      name: "poster.xcf",
      timeout_s: 60,
    });
  });

  it.each([
    [
      '{"view": {"format": "json", "view": {"a": 1}}}',
      { format: "json", view: { a: 1 } },
    ],
    ['{"absent": true}', undefined],
    [
      '{"error": "the reader exited 2; its stderr ends: boom"}',
      {
        format: null,
        view: null,
        error: "the reader exited 2; its stderr ends: boom",
      },
    ],
  ])("reads the answer %s", (line, view) => {
    expect(readerAnswerView(`noise\n${line}\n`)).toEqual(view);
  });

  it("refuses an answer that is not the runner's", () => {
    expect(() => readerAnswerView("Traceback (most recent call last)")).toThrow(
      "REA's reader runner",
    );
  });
});

describe("a verifier without readers", () => {
  it("renders byte for byte as the selector parent before readers", () => {
    const rendered = renderTaskVerifier(
      {
        name: "add-milk",
        prompt: "In Mousepad, add buy milk to my to-do list and save it.",
        checks: [
          {
            id: "milk",
            kind: "lines_present",
            file: "Documents/todo.txt",
            lines: ["buy milk"],
          },
          {
            id: "price",
            kind: "value_equals",
            file: ".config/notes/settings.json",
            pointer: "/size",
            value: 12.5,
            tolerance: 0.001,
          },
          {
            id: "rows",
            kind: "member_count",
            file: "Documents/todo.xml",
            pointer: "/root/children",
            matching: "[name=item]",
            at_least: 2,
          },
        ],
      },
      "mousepad",
    );

    expect(rendered).not.toContain("computer-exec");
    // The digest rendered by the #9185 parent (55d8f016b7), before readers.
    // Older evaluator bodies remain subject to sameTaskVerifier's equivalence rules.
    expect(createHash("sha256").update(rendered).digest("hex")).toBe(
      "a8962df4368ee4034fe2c53e75014692a21dedeac750661188b9042f37b9b926",
    );
  });
});
