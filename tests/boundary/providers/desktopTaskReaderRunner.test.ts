import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { readerViewsOfBytes } from "../../../src/application/desktop/DesktopTaskReaders.js";
import type { DesktopTaskReader } from "../../../src/domain/desktop/appTask.js";
import {
  readerAnswerView,
  readerCommand,
  PYTHON_READER_CLEANUP,
} from "../../../src/domain/desktop/appTaskReaders.js";
import { runReaderHere } from "../../../src/desktop/TaskReaderProcess.js";
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
  // The copy and the fresh home are siblings in the runner's own folder.
  expect(String(report.home).startsWith(dirname(dirname(copy)))).toBe(true);
  expect(String(report.config).startsWith(String(report.home))).toBe(true);
  expect(report.cwd).toBe(dirname(copy));
  // The reader changed only its copy, which is gone with its folder.
  expect(await readFile(join(home, NOTE), "utf8")).toBe("milk\neggs\n");
  await expect(access(dirname(dirname(copy)))).rejects.toThrow();
});

it("retains a remotely owned copy until the matching lease removes it", async () => {
  const { home, app } = await computer();
  const root = await createTestTempDirectory("reader-lease-");
  const lease = { path: join(root, "owned"), token: "owner-token" };
  const [python = "", ...args] = readerCommand(
    reporting(app),
    undefined,
    undefined,
    lease,
  );
  const { stdout } = await execute(python, args, {
    env: { ...process.env, HOME: home },
  });
  expect(readerAnswerView(stdout)?.format).toBe("json");
  await expect(
    access(join(lease.path, "file", "today.txt")),
  ).resolves.toBeUndefined();
  await expect(
    execute(python, [
      "-I",
      "-c",
      PYTHON_READER_CLEANUP,
      JSON.stringify({ ...lease, token: "other" }),
    ]),
  ).rejects.toThrow();
  await expect(access(lease.path)).resolves.toBeUndefined();
  const refused = `import shutil\ndef fail(path): raise PermissionError("denied")\nshutil.rmtree = fail\nexec(${JSON.stringify(PYTHON_READER_CLEANUP)})`;
  await expect(
    execute(python, ["-I", "-c", refused, JSON.stringify(lease)]),
  ).rejects.toThrow();
  expect(await readFile(`${lease.path}.owner`, "utf8")).toBe(lease.token);
  await execute(python, [
    "-I",
    "-c",
    PYTHON_READER_CLEANUP,
    JSON.stringify(lease),
  ]);
  await expect(access(lease.path)).rejects.toThrow();
  await expect(access(`${lease.path}.owner`)).rejects.toThrow();
});

it("passes maximum-length Unicode stdin through bounded arguments to the real reader", async () => {
  const { home, app } = await computer();
  const input = "é".repeat(8190) + "😀" + "é".repeat(57344);
  const reader = reporting(app, { stdin: input });
  const command = readerCommand(reader, undefined);
  expect(Buffer.byteLength(command.slice(4).join(""))).toBeGreaterThan(131072);
  expect(
    Math.max(...command.slice(4).map((part) => Buffer.byteLength(part))),
  ).toBeLessThan(131072);
  const report = readerAnswerView(await run(home, reader))?.view as Record<
    string,
    unknown
  >;
  expect(report.stdin).toBe(input);
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
  ...["9007199254740993.0", "1e-400", "-0.0"].map((number) => [
    `prints an inexact decimal ${number}`,
    ["sh", "-c", `echo 'REA {"id": ${number}}'; : {file}`],
    "json",
    ["cannot be read exactly"],
  ]),
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
        argv: argv as string[],
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

it("runs a reader whose file shares a name with the runner's own folders and files", async () => {
  const { home } = await computer();
  for (const name of ["home", "stdout", "stderr"]) {
    await writeFile(join(home, "Documents", name), `${name} bytes`);
    const view = readerAnswerView(
      await run(home, {
        id: "named",
        file: `Documents/${name}`,
        argv: ["sh", "-c", 'echo REA $(cat "$1")', "sh", "{file}"],
        output: "lines",
      }),
    );
    expect(view?.view, name).toEqual({
      lines: [`${name} bytes`],
      line_count: 1,
      truncated: false,
    });
  }
});

it("stops a reader once it has printed more than 1 MiB, rather than at its timeout", async () => {
  const { home } = await computer();
  const started = Date.now();
  const view = readerAnswerView(
    await run(home, {
      id: "flood",
      file: NOTE,
      argv: ["sh", "-c", "yes 'REA x'; : {file}"],
      output: "lines",
      timeout_s: 30,
    }),
  );
  expect(view?.error).toContain("printed more than 1 MiB");
  expect(Date.now() - started).toBeLessThan(10_000);
});

it("stops the reader, the processes it started and its folder when the export is cancelled", async () => {
  const { home } = await computer();
  const out = join(home, "..", "out");
  await mkdir(out);
  const controller = new AbortController();
  const read = readerViewsOfBytes(
    [
      {
        id: "stuck",
        file: NOTE,
        // Python, not the system's sleep, whose environment macOS withholds from the run token sweep.
        argv: [
          "python3",
          "-c",
          `import os, time; open("${out}/cwd", "w").write(os.getcwd()); open("${out}/pid", "w").write(str(os.getpid())); time.sleep(60)`,
          "{file}",
        ],
        output: "lines",
      },
    ],
    () => Promise.resolve({ kind: "bytes", bytes: Buffer.from("milk\n") }),
    (argv, timeoutS) => runReaderHere(argv, timeoutS, controller.signal),
  );
  const pid = async (): Promise<number> => {
    for (let tries = 0; tries < 200; tries += 1) {
      const text = await readFile(join(out, "pid"), "utf8").catch(() => "");
      if (text.trim() !== "") return Number(text.trim());
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("the reader never started");
  };
  const reader = await pid();
  controller.abort(new Error("cancelled"));
  await expect(read).rejects.toThrow();
  expect(() => process.kill(reader, 0)).toThrow();
  const folder = (await readFile(join(out, "cwd"), "utf8")).trim();
  await expect(access(folder)).rejects.toThrow();
});
