import { execFile } from "node:child_process";
import { chmod, mkdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { evaluateTaskChecks } from "../../../src/domain/desktop/appTaskChecks.js";
import {
  readerAnswerView,
  readerCommand,
} from "../../../src/domain/desktop/appTaskReaders.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const reader = {
  id: "saved",
  file: "Documents/saved.json",
  argv: [
    "python3",
    "-c",
    'import sys\nprint("REA " + open(sys.argv[1]).read())',
    "{file}",
  ],
  output: "json" as const,
};

/** Run the real runner, then grade the view through the same reader seam as the witness. */
const expectUnread = async (source: string) => {
  const [python = "", ...argv] = readerCommand(reader, source);
  const { stdout } = await execute(python, argv, {
    maxBuffer: 1024 * 1024,
  });
  const view = readerAnswerView(stdout);
  expect(view).toMatchObject({
    format: null,
    view: null,
    error: expect.stringContaining("cannot inspect the reader's source"),
  });
  if (view === undefined) throw new Error("inspection failure became absence");
  const [outcome] = evaluateTaskChecks(
    [
      {
        id: "gone",
        kind: "value_absent",
        file: reader.file,
        reader: reader.id,
        pointer: "/saved",
      },
    ],
    new Map(),
    new Map([[reader.id, view]]),
  );
  expect(outcome).toMatchObject({ passed: false, undecided: true });
};

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "does not pass an absence check when a reader's source parent is unsearchable",
  async () => {
    const root = await createTestTempDirectory("reader-admission-");
    const parent = join(root, "denied");
    const source = join(parent, "saved.json");
    await mkdir(parent);
    await writeFile(source, '{"saved":true}');
    await chmod(parent, 0);
    try {
      await expect(stat(source)).rejects.toMatchObject({ code: "EACCES" });
      await expectUnread(source);
    } finally {
      await chmod(parent, 0o700);
    }
    expect((await stat(source)).isFile()).toBe(true);
  },
);

it.skipIf(process.platform === "win32")(
  "does not pass an absence check when a reader's source is a symlink loop",
  async () => {
    const root = await createTestTempDirectory("reader-admission-");
    const source = join(root, "loop.json");
    await symlink("loop.json", source);
    await expect(stat(source)).rejects.toMatchObject({ code: "ELOOP" });
    await expectUnread(source);
  },
);
