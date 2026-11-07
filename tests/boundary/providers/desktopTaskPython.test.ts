import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import type {
  DesktopTaskCheck,
  DesktopTaskReader,
} from "../../../src/domain/desktop/appTask.js";
import {
  evaluateTaskChecks,
  type TaskFileView,
} from "../../../src/domain/desktop/appTaskChecks.js";
import {
  CHECK_CASES,
  CHECK_VIEWS,
} from "../../../src/domain/desktop/appTaskChecks.fixture.js";
import { SETTLE_TIMING } from "../../../src/domain/desktop/appSettle.js";
import { renderTaskVerifier } from "../../../src/domain/desktop/appTaskPython.js";
import {
  readerAnswerView,
  readerCommand,
} from "../../../src/domain/desktop/appTaskReaders.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

/** The protocol client calls the verifier makes, replaced so it reads the given views. */
const STUB_CLIENT = `
def find_child(card, name):
    return next((child for child in card.get("children_environments") or [] if child.get("name") == name), None)


def find_extension(card, uri):
    return next((ext for ext in (card.get("capabilities") or {}).get("extensions") or [] if ext.get("uri") == uri), None)
`;

/**
 * Runs the verifier against an app whose files the stdin's `saves` set, each `[at, views]` from the virtual second it
 * lands on: a clock only the verifier's sleeps and reads move, so its timing is exact. Read n takes `durations[n]`
 * seconds, or `READ_S`, and returns the files as they are when it completes; a timeout past its limit ends it there.
 */
const DRIVER = String.raw`
import asyncio, base64, importlib.util, json, sys, types
folder, verifier = sys.argv[1], sys.argv[2]
sys.path.insert(0, folder)
from agentenv_protocol import client

scenario = json.load(sys.stdin)
saves, durations, called, reads, clock = scenario["saves"], scenario["durations"], [], [], [0.0]
answers, execs = scenario.get("answers") or {}, []
#: Virtual seconds each data/get takes, a binary fraction so the clock stays exact.
READ_S = 0.125


def views_at(now):
    return [views for at, views in saves if at <= now][-1]


async def get_card(url, **_):
    called.append(url)
    extensions = [{"uri": "urn:agentenv:computer-exec/v1"}] if scenario.get("exec", True) else []
    return {"name": "computer", "children_environments": [{"name": "notes", "url": "/svc/notes/agentenv"}],
            "capabilities": {"extensions": extensions}}


async def invoke_extension(url, card, uri, params=None, timeout=30, verify=True, *, method=None, headers=None):
    execs.append({"url": url, "uri": uri, "method": method, "timeout": timeout, **params})
    answer = answers[json.loads(params["argv"][-1])["id"]]
    stdout = answer if isinstance(answer, str) else "Python noise\n" + json.dumps(answer) + "\n"
    return {"exit_code": 0, "stdout": stdout, "stderr": "", "truncated": False, "timed_out": False}


async def get_data(url, **_):
    called.append(url)
    reads.append(clock[0])
    clock[0] += durations[len(reads) - 1] if len(reads) <= len(durations) else READ_S
    views = views_at(clock[0])
    files = [types.SimpleNamespace(kind="file", metadata={"urn:agentenv:data-objects/v1": {"path": path}},
                                   file=types.SimpleNamespace(bytes=base64.b64encode(json.dumps(view).encode()).decode()))
             for path, view in views.items()]
    return types.SimpleNamespace(parts=[*files, types.SimpleNamespace(kind="data", data={"state": views})])


async def sleep(seconds):
    clock[0] += seconds


class Cut(Exception):
    """The timeout a virtual wait_for raises."""


async def wait_for(awaitable, timeout):
    limit = clock[0] + timeout
    result = await awaitable
    if clock[0] > limit:
        clock[0] = limit
        raise Cut
    return result


client.get_card, client.get_data, client.invoke_extension = get_card, get_data, invoke_extension
spec = importlib.util.spec_from_file_location("verifier", verifier)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.time = types.SimpleNamespace(monotonic=lambda: clock[0])
module.asyncio = types.SimpleNamespace(sleep=sleep, wait_for=wait_for, TimeoutError=Cut)
results = asyncio.run(module.verify("http://mcp", "http://computer:8080"))
print(json.dumps({"called": called, "reads": reads, "ended": clock[0], "results": results, "execs": execs}))
`;

type VerifierOutput = {
  called: string[];
  execs: Record<string, unknown>[];
  reads: number[];
  ended: number;
  results: {
    id: string;
    result: boolean;
    description: string;
    settled?: boolean;
    read_cut?: boolean;
  }[];
};

/** The exported verifier's results on an app whose files change at the given virtual seconds. */
const runVerifier = async (
  checks: readonly DesktopTaskCheck[],
  saves: readonly (readonly [number, Record<string, unknown>])[],
  durations: readonly number[] = [],
  computer: {
    readonly readers?: readonly DesktopTaskReader[];
    readonly answers?: Readonly<Record<string, unknown>>;
    readonly exec?: boolean;
  } = {},
): Promise<VerifierOutput> => {
  const folder = await createTestTempDirectory("desktop-task-python-");
  await mkdir(join(folder, "agentenv_protocol"));
  await writeFile(join(folder, "agentenv_protocol/__init__.py"), "");
  await writeFile(join(folder, "agentenv_protocol/client.py"), STUB_CLIENT);
  await writeFile(
    join(folder, "agentenv_protocol/types.py"),
    'RPC_PATH = "/agentenv"\n',
  );
  const verifier = join(folder, "verify.py");
  await writeFile(
    verifier,
    renderTaskVerifier(
      {
        name: "edit-notes",
        prompt: "Edit.",
        checks: [...checks],
        ...(computer.readers === undefined
          ? {}
          : { readers: computer.readers }),
      },
      "notes",
    ),
  );
  return JSON.parse(
    execFileSync("python3", ["-I", "-B", "-c", DRIVER, folder, verifier], {
      input: JSON.stringify({
        saves,
        durations,
        answers: computer.answers,
        exec: computer.exec ?? true,
      }),
      encoding: "utf8",
    }),
  ) as VerifierOutput;
};

const INTERVAL_S = SETTLE_TIMING.intervalMs / 1000;
const WINDOW_S = SETTLE_TIMING.windowMs / 1000;
const BOUND_S = SETTLE_TIMING.boundMs / 1000;
const today = (...lines: string[]) => ({
  "Documents/today.txt": {
    format: "text",
    view: { lines, line_count: lines.length, truncated: false },
    truncated: false,
  },
});
const linesPresent = (...lines: string[]): DesktopTaskCheck => ({
  id: "today",
  kind: "lines_present",
  file: "Documents/today.txt",
  lines,
});
const graded = ({ results }: VerifierOutput) =>
  results.map(({ result, settled, read_cut }) => [result, settled, read_cut]);

it("evaluates every kind of check in the exported verifier as REA does", async () => {
  const checks: DesktopTaskCheck[] = CHECK_CASES.map(([check], index) => ({
    ...check,
    id: `check-${String(index + 1)}`,
  }));
  const output = await runVerifier(checks, [[0, CHECK_VIEWS]]);

  const [card, ...data] = output.called;
  expect(card).toBe("http://computer:8080");
  expect(new Set(data)).toEqual(new Set(["http://computer:8080/svc/notes"]));
  expect(data).toHaveLength(output.reads.length);
  const typescript = evaluateTaskChecks(
    checks,
    new Map(Object.entries(CHECK_VIEWS)),
  );
  expect(output.results.map(({ id, result }) => [id, result])).toEqual(
    typescript.map(({ id, passed }) => [id, passed]),
  );
  expect(output.results.map(({ result }) => result)).toEqual(
    CHECK_CASES.map(([, expected]) => expected),
  );
  expect(output.results.map(({ description }) => description)).toEqual(
    typescript.map(({ description }) => description),
  );
});

it("grades an app that saves seconds after the agent stops on what it saved", async () => {
  // Gnote saved 2.2 s after the verifier's first read in the run this missed.
  const saved = 2.2;
  const output = await runVerifier(
    [linesPresent("milk", "olive oil")],
    [
      [0, today("milk")],
      [saved, today("milk", "olive oil")],
    ],
  );
  expect(graded(output)).toEqual([[true, true, false]]);
  // The views graded had held a whole window after the save landed.
  expect(output.reads.at(-1)).toBeGreaterThanOrEqual(saved + WINDOW_S);
  expect(output.reads.at(-1)).toBeLessThanOrEqual(
    saved + WINDOW_S + INTERVAL_S,
  );
});

it("grades files that never stop changing at the bound, on the last read, and records that they did not settle", async () => {
  const saves = Array.from(
    { length: 2 * BOUND_S + 10 },
    (_, index) => [index * INTERVAL_S, today(`save ${String(index)}`)] as const,
  );
  // The last read starts an interval before the bound and returns the save that landed as it ran.
  const last = `save ${String(BOUND_S / INTERVAL_S - 1)}`;
  const output = await runVerifier([linesPresent(last)], saves);
  expect(output.reads.at(-1)).toBe(BOUND_S - INTERVAL_S);
  expect(output.ended).toBeLessThanOrEqual(BOUND_S);
  expect(graded(output)).toEqual([[true, false, false]]);
});

it("counts a slow read's changed files as quiet only from when it returned them", async () => {
  // The second read starts at 0.5 s and returns a save from 2.75 s at 2.875 s; another save follows at 4.125 s.
  const output = await runVerifier(
    [linesPresent("milk", "olive oil", "flour")],
    [
      [0, today("milk")],
      [2.75, today("milk", "olive oil")],
      [4.125, today("milk", "olive oil", "flour")],
    ],
    [0.125, 2.375],
  );
  expect(graded(output)).toEqual([[true, true, false]]);
});

it("ends reads slower than the bound at the bound, grading the last completed read", async () => {
  const slow = 8;
  const output = await runVerifier(
    [linesPresent("milk")],
    [
      [0, today("milk")],
      [slow + 2, today("eggs")],
    ],
    Array.from({ length: 4 }, () => slow),
  );
  expect(output.reads).toEqual([0, slow]);
  expect(output.ended).toBe(BOUND_S);
  expect(graded(output)).toEqual([[true, false, true]]);
});

it("grades an app that saved before the check within the window plus one interval", async () => {
  const output = await runVerifier(
    [linesPresent("milk", "olive oil")],
    [[0, today("milk", "olive oil")]],
  );
  expect(graded(output)).toEqual([[true, true, false]]);
  expect(output.reads.at(-1)).toBeLessThanOrEqual(WINDOW_S + INTERVAL_S);
});

const READERS: readonly DesktopTaskReader[] = [
  {
    id: "layers",
    file: "Documents/poster.xcf",
    argv: ["gimp-console-2.10", "-i", "-b", "-"],
    stdin: '(gimp-file-load RUN-NONINTERACTIVE "{file}" "{file}")',
    output: "lines",
  },
  {
    id: "objects",
    file: "Documents/scene.blend",
    argv: ["blender", "-b", "{file}", "--python-expr", "print('REA {}')"],
    output: "json",
    timeout_s: 20,
  },
  {
    id: "broken",
    file: "Documents/broken.xcf",
    argv: ["gimp-console-2.10", "{file}"],
    output: "lines",
  },
  {
    id: "gone",
    file: "Documents/gone.xcf",
    argv: ["gimp-console-2.10", "{file}"],
    output: "lines",
  },
];
/** What REA's reader runner answers for each reader, as its last line. */
const ANSWERS: Readonly<Record<string, unknown>> = {
  layers: {
    view: {
      format: "text",
      view: {
        lines: ["layer Summer Sale", "layer Background"],
        line_count: 2,
        truncated: false,
      },
    },
  },
  objects: {
    view: {
      format: "json",
      view: {
        Crate: { location: [2.0004, 0, 0] },
        Camera: { location: [7, -6, 5] },
      },
    },
  },
  broken: {
    error: "the reader exited 1; its stderr ends: cannot open the file",
  },
  gone: { absent: true },
};
const READER_CHECKS: DesktopTaskCheck[] = [
  {
    id: "renamed",
    kind: "lines_present",
    file: "Documents/poster.xcf",
    reader: "layers",
    lines: ["layer Summer Sale"],
  },
  {
    id: "kept",
    kind: "lines_absent",
    file: "Documents/poster.xcf",
    reader: "layers",
    lines: ["layer Headline"],
  },
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
    id: "camera",
    kind: "value_equals",
    file: "Documents/scene.blend",
    reader: "objects",
    pointer: "/Camera/location/0",
    value: 8,
  },
  {
    id: "objects",
    kind: "member_count",
    file: "Documents/scene.blend",
    reader: "objects",
    pointer: "/Crate/location",
    equals: 3,
  },
  {
    id: "broken",
    kind: "line_count",
    file: "Documents/broken.xcf",
    reader: "broken",
    contains: "layer",
    at_least: 1,
  },
  {
    id: "gone",
    kind: "lines_absent",
    file: "Documents/gone.xcf",
    reader: "gone",
    lines: ["layer"],
  },
];

it("reads each reader's view through the computer's computer-exec and grades it as REA does", async () => {
  const output = await runVerifier(READER_CHECKS, [[0, CHECK_VIEWS]], [], {
    readers: READERS,
    answers: ANSWERS,
  });

  expect(
    output.execs.map(({ url, uri, method, argv, timeout_s }) => ({
      url,
      uri,
      method,
      argv,
      timeout_s,
    })),
  ).toEqual(
    READERS.map((reader) => ({
      url: "http://computer:8080",
      uri: "urn:agentenv:computer-exec/v1",
      method: "run",
      argv: readerCommand(reader, undefined),
      timeout_s: (reader.timeout_s ?? 60) + 30,
    })),
  );
  // computer-exec answers a repeated request id with its first result, so each reader's is new.
  expect(new Set(output.execs.map(({ request_id }) => request_id)).size).toBe(
    READERS.length,
  );
  const readers = new Map<string, TaskFileView>();
  for (const [id, answer] of Object.entries(ANSWERS)) {
    const view = readerAnswerView(JSON.stringify(answer));
    if (view !== undefined) readers.set(id, view);
  }
  const typescript = evaluateTaskChecks(
    READER_CHECKS,
    new Map(Object.entries(CHECK_VIEWS)),
    readers,
  );
  expect(
    output.results.map(({ id, result, description }) => [
      id,
      result,
      description,
    ]),
  ).toEqual(
    typescript.map(({ id, passed, description }) => [id, passed, description]),
  );
  expect(output.results.map(({ result }) => result)).toEqual([
    true,
    true,
    true,
    false,
    true,
    false,
    true,
  ]);
});

it.each([
  [{ exec: false }, "offers no urn:agentenv:computer-exec/v1"],
  [
    { answers: { ...ANSWERS, layers: "Traceback (most recent call last)\n" } },
    "REA's reader runner",
  ],
])(
  "raises rather than grading when the readers cannot be run (%j)",
  async (computer, message) => {
    await expect(
      runVerifier(READER_CHECKS, [[0, CHECK_VIEWS]], [], {
        readers: READERS,
        answers: ANSWERS,
        ...computer,
      }),
    ).rejects.toThrow(message);
  },
);
