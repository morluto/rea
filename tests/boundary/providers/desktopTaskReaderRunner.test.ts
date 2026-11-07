import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import type { DesktopTaskReader } from "../../../src/domain/desktop/appTask.js";
import {
  readerAnswerView,
  readerCommand,
} from "../../../src/domain/desktop/appTaskReaders.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const NOTE = "Documents/today.txt";
const SECRET = "control-token-secret";

/** A fake app's headless mode: it reports what it was given, then changes the file it read. */
const REPORTING_APP = String.raw`
import json, os, sys
path = sys.argv[1]
data = open(path, "rb").read().decode()
open(path, "ab").write(b" tampered")
print("App 1.0 starting")
print("REA " + json.dumps({
    "home": os.environ.get("HOME"), "display": os.environ.get("DISPLAY"), "bus": os.environ.get("DBUS_SESSION_BUS_ADDRESS"),
    "config": os.environ.get("XDG_CONFIG_HOME"), "control": sorted(k for k in os.environ if k.startswith("AGENTENV_")),
    "path": path, "cwd": os.getcwd(), "content": data, "stdin": sys.stdin.read()}))
print("App quit")
`;

/** A computer's home with the note in it and the fake app beside it. */
const computer = async () => {
  const root = await createTestTempDirectory("reader-runner-");
  const home = join(root, "home");
  await mkdir(join(home, "Documents"), { recursive: true });
  await writeFile(join(home, NOTE), "milk\neggs\n");
  const app = join(root, "app.py");
  await writeFile(app, REPORTING_APP);
  return { home, app };
};

/** Run the runner as computer-exec runs it in the session: the session's environment, its control token included. */
const run = async (home: string, reader: DesktopTaskReader, path?: string) => {
  const [python = "", ...rest] = readerCommand(reader, path);
  const { stdout } = await execute(python, rest, {
    cwd: home,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      DISPLAY: ":99",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      AGENTENV_CONTROL_TOKEN: SECRET,
    },
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
};

const reporting = (app: string, fields: Partial<DesktopTaskReader> = {}) =>
  ({
    id: "report",
    file: NOTE,
    argv: ["python3", app, "{file}"],
    output: "json",
    ...fields,
  }) as DesktopTaskReader;

it("runs the reader on a private copy of the file in a fresh home, without the display, the session bus or the control token", async () => {
  const { home, app } = await computer();
  const stdout = await run(home, reporting(app, { stdin: "open {file}" }));

  expect(stdout).not.toContain(SECRET);
  const view = readerAnswerView(stdout);
  const report = view?.view as Record<string, unknown>;
  expect(view?.format).toBe("json");
  expect(report).toMatchObject({
    display: null,
    bus: null,
    control: [],
    content: "milk\neggs\n",
  });
  const copy = String(report.path);
  expect(copy.endsWith("/today.txt")).toBe(true);
  expect(copy.startsWith(home)).toBe(false);
  expect(report.stdin).toBe(`open ${copy}`);
  expect(String(report.home).startsWith(dirname(copy))).toBe(true);
  expect(String(report.config).startsWith(String(report.home))).toBe(true);
  expect(report.cwd).toBe(dirname(copy));
  // The reader changed only its copy, which is gone with its folder.
  expect(await readFile(join(home, NOTE), "utf8")).toBe("milk\neggs\n");
  await expect(access(dirname(copy))).rejects.toThrow();
});

it("keeps the display for a reader that asks for it, still without the control token", async () => {
  const { home, app } = await computer();
  const report = readerAnswerView(
    await run(home, reporting(app, { display: true })),
  )?.view as Record<string, unknown>;
  expect(report).toMatchObject({ display: ":99", control: [] });
});

it("reads the file a path names instead of the home's, under the home file's name", async () => {
  const { home, app } = await computer();
  const blob = join(home, "..", "blob-0123");
  await writeFile(blob, "seed bytes");
  const report = readerAnswerView(await run(home, reporting(app), blob))
    ?.view as Record<string, unknown>;
  expect(report.content).toBe("seed bytes");
  expect(String(report.path).endsWith("/today.txt")).toBe(true);
});

it("makes the marked lines a text view and drops the rest", async () => {
  const { home } = await computer();
  const view = readerAnswerView(
    await run(home, {
      id: "lines",
      file: NOTE,
      argv: [
        "python3",
        "-c",
        "import sys\nprint('ts> banner')\nfor line in open(sys.argv[1]): print('REA item ' + line.strip())\nprint('REA')\nprint('REAL news')",
        "{file}",
      ],
      output: "lines",
    }),
  );
  expect(view).toEqual({
    format: "text",
    view: {
      lines: ["item milk", "item eggs"],
      line_count: 2,
      truncated: false,
    },
  });
});

it("answers absent for a file the home does not hold, without running the reader", async () => {
  const { home } = await computer();
  const stdout = await run(home, {
    id: "gone",
    file: "Documents/gone.txt",
    argv: ["sh", "-c", `touch '${home}/ran'; echo 'REA x' {file}`],
    output: "lines",
  });
  expect(readerAnswerView(stdout)).toBeUndefined();
  await expect(access(join(home, "ran"))).rejects.toThrow();
});

it.each([
  [
    "exits non-zero",
    ["sh", "-c", "echo 'REA x'; echo 'cannot open {file}' >&2; exit 3"],
    "json",
    ["the reader exited 3", "cannot open"],
  ],
  [
    "prints no marked line",
    ["sh", "-c", "echo hello {file}"],
    "lines",
    ['printed no line starting with "REA "'],
  ],
  [
    "prints a view that is not JSON",
    ["sh", "-c", "echo 'REA {not json' {file}"],
    "json",
    ["are not one JSON value"],
  ],
  [
    "prints a number JSON cannot hold exactly",
    ["sh", "-c", "echo 'REA {\"id\": 9007199254740993}'; : {file}"],
    "json",
    ["cannot be read exactly"],
  ],
  [
    "prints more than 1 MiB",
    ["python3", "-c", "print('REA ' + 'x' * (1 << 20))", "{file}"],
    "lines",
    ["printed more than 1 MiB"],
  ],
  [
    "cannot start",
    ["no-such-app-binary", "{file}"],
    "lines",
    ["could not start no-such-app-binary"],
  ],
])(
  "reports a reader that %s as an error view",
  async (_, argv, output, facts) => {
    const { home } = await computer();
    const view = readerAnswerView(
      await run(home, {
        id: "broken",
        file: NOTE,
        argv,
        output: output as "json" | "lines",
      }),
    );
    expect(view?.format).toBeNull();
    for (const fact of facts) expect(view?.error).toContain(fact);
  },
);

it("stops a reader past its timeout, with the processes it started", async () => {
  const { home } = await computer();
  const started = Date.now();
  const view = readerAnswerView(
    await run(home, {
      id: "slow",
      file: NOTE,
      argv: [
        "sh",
        "-c",
        `(sleep 3; touch "${home}/late") & echo 'REA x'; sleep 30; : {file}`,
      ],
      output: "lines",
      timeout_s: 1,
    }),
  );
  expect(view?.error).toContain("ran past its 1 s");
  expect(Date.now() - started).toBeLessThan(10_000);
  await new Promise((resolve) => setTimeout(resolve, 3500));
  await expect(access(join(home, "late"))).rejects.toThrow();
});
