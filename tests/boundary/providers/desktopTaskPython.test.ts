import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import type { DesktopTaskCheck } from "../../../src/domain/desktop/appTask.js";
import { evaluateTaskChecks } from "../../../src/domain/desktop/appTaskChecks.js";
import {
  CHECK_CASES,
  CHECK_VIEWS,
} from "../../../src/domain/desktop/appTaskChecks.fixture.js";
import { SETTLE_TIMING } from "../../../src/domain/desktop/appSettle.js";
import { renderTaskVerifier } from "../../../src/domain/desktop/appTaskPython.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

/** The protocol client calls the verifier makes, replaced so it reads the given views. */
const STUB_CLIENT = `
def find_child(card, name):
    return next((child for child in card.get("children_environments") or [] if child.get("name") == name), None)
`;

/**
 * Runs the verifier against an app whose files the stdin's `saves` set, each `[at, views]` from the virtual second it
 * lands on: a clock only the verifier's sleeps and reads move, so its timing is exact.
 */
const DRIVER = String.raw`
import asyncio, base64, importlib.util, json, sys, types
folder, verifier = sys.argv[1], sys.argv[2]
sys.path.insert(0, folder)
from agentenv_protocol import client

saves, called, reads, clock = json.load(sys.stdin)["saves"], [], [], [0.0]
#: Virtual seconds each data/get takes, a binary fraction so the clock stays exact.
READ_S = 0.125


def views_at(now):
    return [views for at, views in saves if at <= now][-1]


async def get_card(url, **_):
    called.append(url)
    return {"name": "computer", "children_environments": [{"name": "notes", "url": "/svc/notes/agentenv"}]}


async def get_data(url, **_):
    called.append(url)
    reads.append(clock[0])
    views = views_at(clock[0])
    clock[0] += READ_S
    files = [types.SimpleNamespace(kind="file", metadata={"urn:agentenv:data-objects/v1": {"path": path}},
                                   file=types.SimpleNamespace(bytes=base64.b64encode(json.dumps(view).encode()).decode()))
             for path, view in views.items()]
    return types.SimpleNamespace(parts=[*files, types.SimpleNamespace(kind="data", data={"state": views})])


async def sleep(seconds):
    clock[0] += seconds


client.get_card, client.get_data = get_card, get_data
spec = importlib.util.spec_from_file_location("verifier", verifier)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.time = types.SimpleNamespace(monotonic=lambda: clock[0])
module.asyncio = types.SimpleNamespace(sleep=sleep)
results = asyncio.run(module.verify("http://mcp", "http://computer:8080"))
print(json.dumps({"called": called, "reads": reads, "results": results}))
`;

type VerifierOutput = {
  called: string[];
  reads: number[];
  results: {
    id: string;
    result: boolean;
    description: string;
    settled?: boolean;
  }[];
};

/** The exported verifier's results on an app whose files change at the given virtual seconds. */
const runVerifier = async (
  checks: readonly DesktopTaskCheck[],
  saves: readonly (readonly [number, Record<string, unknown>])[],
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
      { name: "edit-notes", prompt: "Edit.", checks: [...checks] },
      "notes",
    ),
  );
  return JSON.parse(
    execFileSync("python3", ["-I", "-B", "-c", DRIVER, folder, verifier], {
      input: JSON.stringify({ saves }),
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
  expect(
    output.results.map(({ result, settled }) => [result, settled]),
  ).toEqual([[true, true]]);
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
  const last = `save ${String(BOUND_S / INTERVAL_S)}`;
  const output = await runVerifier([linesPresent(last)], saves);
  expect(output.reads.at(-1)).toBe(BOUND_S);
  expect(Math.max(...output.reads)).toBe(BOUND_S);
  expect(
    output.results.map(({ result, settled }) => [result, settled]),
  ).toEqual([[true, false]]);
});

it("grades an app that saved before the check within the window plus one interval", async () => {
  const output = await runVerifier(
    [linesPresent("milk", "olive oil")],
    [[0, today("milk", "olive oil")]],
  );
  expect(
    output.results.map(({ result, settled }) => [result, settled]),
  ).toEqual([[true, true]]);
  expect(output.reads.at(-1)).toBeLessThanOrEqual(WINDOW_S + INTERVAL_S);
});
