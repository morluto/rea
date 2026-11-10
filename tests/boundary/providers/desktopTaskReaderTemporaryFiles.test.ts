import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import {
  readerAnswerView,
  readerCommand,
  PYTHON_READER_CLEANUP,
} from "../../../src/domain/desktop/appTaskReaders.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const reader = {
  id: "scratch",
  file: "Documents/document.bin",
  argv: [
    "python3",
    "-c",
    String.raw`import json, os, sys, tempfile
data = open(sys.argv[1], "rb").read()
fd, path = tempfile.mkstemp(prefix="headless-scratch-")
with os.fdopen(fd, "wb") as scratch:
    scratch.write(data)
print("REA " + json.dumps({"copy": sys.argv[1], "scratch": path,
                          "temporary": {k: os.environ.get(k) for k in ("TMPDIR", "TMP", "TEMP")}}))`,
    "{file}",
  ],
  output: "json" as const,
};

interface ScratchReport {
  readonly copy: string;
  readonly scratch: string;
  readonly temporary: Record<string, string>;
}

const fixture = async () => {
  const root = await createTestTempDirectory("reader-scratch-");
  const source = join(root, "document.bin");
  const inherited = join(root, "session-temp");
  const work = join(root, "work");
  await writeFile(source, "original document");
  await mkdir(inherited);
  await mkdir(work);
  const env = {
    ...process.env,
    TMPDIR: inherited,
    TMP: inherited,
    TEMP: inherited,
  };
  return { source, inherited, work, env };
};

const reportOf = (stdout: string): ScratchReport => {
  const answer = readerAnswerView(stdout);
  expect(answer?.format).toBe("json");
  return answer?.view as unknown as ScratchReport;
};

const expectOwnedTemporary = (report: ScratchReport, owned: string) => {
  const temporary = join(owned, "tmp");
  expect(dirname(report.scratch)).toBe(temporary);
  expect(report.temporary).toEqual({
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
  });
};

it.skipIf(process.platform === "win32")(
  "retains ordinary scratch files in the remote lease until its matching cleanup",
  async () => {
    const { source, inherited, work, env } = await fixture();
    const lease = { path: join(work, "owned"), token: "scratch-owner" };
    const [python = "", ...argv] = readerCommand(
      reader,
      source,
      undefined,
      lease,
    );
    const { stdout } = await execute(python, argv, { env });
    const report = reportOf(stdout);
    try {
      expectOwnedTemporary(report, lease.path);
      expect(await readFile(report.scratch, "utf8")).toBe("original document");
      expect(await readdir(inherited)).toEqual([]);
      expect(await readFile(source, "utf8")).toBe("original document");
    } finally {
      await execute(python, [
        "-I",
        "-c",
        PYTHON_READER_CLEANUP,
        JSON.stringify(lease),
      ]);
    }
    await expect(access(report.scratch)).rejects.toThrow();
    await expect(access(lease.path)).rejects.toThrow();
  },
);

it.skipIf(process.platform === "win32")(
  "removes normal local scratch files with the reader folder after success",
  async () => {
    const { source, inherited, work, env } = await fixture();
    const [python = "", ...argv] = readerCommand(reader, source, work);
    const { stdout } = await execute(python, argv, { env });
    const report = reportOf(stdout);
    const owned = dirname(dirname(report.copy));
    expectOwnedTemporary(report, owned);
    await expect(access(report.scratch)).rejects.toThrow();
    await expect(access(owned)).rejects.toThrow();
    expect(await readdir(inherited)).toEqual([]);
    expect(await readFile(source, "utf8")).toBe("original document");
  },
);
