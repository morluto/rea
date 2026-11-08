import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { readZipView } from "../../../src/application/desktop/DesktopZipView.js";
import {
  PYTHON_HELPERS,
  PYTHON_IMPORTS,
} from "../../../src/domain/desktop/appExportPython.js";
import { PYTHON_TASK_EVALUATOR } from "../../../src/domain/desktop/appTaskPython.js";
import { evaluateTaskChecks } from "../../../src/domain/desktop/appTaskChecks.js";
import { detectStateFormat } from "../../../src/domain/desktop/stateFormats.js";
import {
  withZip64End,
  zipArchive,
} from "../../../src/domain/desktop/zipArchive.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const empty = zipArchive([]);
const commented = Buffer.concat([empty, Buffer.from("archive comment")]);
commented.writeUInt16LE(commented.length - 22, 20);
const archives = [
  ["classic", empty],
  ["commented", commented],
  ["Zip64 sentinels", withZip64End(empty)],
  ["Zip64 ordinary counts", withZip64End(empty, false)],
] as const;

const pythonViews = async (files: readonly Buffer[]) => {
  const root = await createTestTempDirectory("desktop-empty-zip-");
  const paths = await Promise.all(
    files.map(async (bytes, index) => {
      const path = join(root, `${String(index)}.dat`);
      await writeFile(path, bytes);
      return path;
    }),
  );
  const imports = PYTHON_IMPORTS.split("\n")
    .filter((line) => !line.includes("agentenv_protocol"))
    .join("\n");
  const script = join(root, "read.py");
  await writeFile(
    script,
    `${imports}${PYTHON_HELPERS}${PYTHON_TASK_EVALUATOR}
check = {"id": "empty", "kind": "value_equals", "file": "archive.zip", "pointer": "/entry_count", "value": 0}
for path in json.load(sys.stdin):
    view = _view(Path(path))
    print(json.dumps({"file": view, "passed": evaluate([check], {"archive.zip": view})[0]["result"]}))
`,
  );
  return execFileSync(
    process.platform === "win32" ? "python" : "python3",
    ["-I", "-B", "-X", "utf8", script],
    { input: JSON.stringify(paths), encoding: "utf8" },
  )
    .trim()
    .split(/\r?\n/u)
    .map(
      (line) =>
        JSON.parse(line) as {
          file: { format: string; view: unknown; error?: string };
          passed: boolean;
        },
    );
};

it.each(archives)(
  "reads an empty %s archive without relying on its name",
  async (_name, bytes) => {
    const expected = { entries: [], entry_count: 0, truncated: false };
    expect(detectStateFormat("document.dat", bytes)).toBe("zip");
    expect(await readZipView(bytes)).toEqual({ ok: true, value: expected });
    expect((await pythonViews([bytes]))[0]).toEqual({
      file: { format: "zip", view: expected, truncated: false },
      passed: true,
    });
  },
);

it("keeps empty nested archives viewless instead of recursing or calling them binary", async () => {
  const outer = zipArchive(
    archives.map(([name, data]) => ({ name: `${name}.zip`, data })),
  );
  const native = await readZipView(outer);
  if (!native.ok) throw new Error(native.error);
  const python = (await pythonViews([outer]))[0]?.file;
  expect(python?.format).toBe("zip");
  expect(python?.view).toEqual(native.value);
  expect(native.value).toMatchObject({
    entries: archives.map(() => ({
      format: "zip",
      view: null,
      view_error: "an archive inside an archive is not read",
    })),
    entry_count: archives.length,
    truncated: false,
  });
});

it("grades removing every entry as a change from a nonempty archive", async () => {
  const files = [zipArchive([{ name: "old.txt", data: "old" }]), empty];
  const check = {
    id: "empty",
    kind: "value_equals" as const,
    file: "archive.zip",
    pointer: "/entry_count",
    value: 0,
  };
  const verdicts = await Promise.all(
    files.map(async (bytes) => {
      const read = await readZipView(bytes);
      if (!read.ok) throw new Error(read.error);
      return evaluateTaskChecks(
        [check],
        new Map([
          [
            check.file,
            { format: detectStateFormat(check.file, bytes), view: read.value },
          ],
        ]),
      )[0]?.passed;
    }),
  );
  expect(verdicts).toEqual([false, true]);
  expect((await pythonViews(files)).map((row) => row.passed)).toEqual(verdicts);
});

it("does not turn incomplete or damaged end records into empty views", async () => {
  const incomplete = empty.subarray(0, 6);
  expect(detectStateFormat("archive.zip", incomplete)).toBe("binary");
  const damaged = Buffer.from(empty);
  damaged.writeUInt16LE(1, 20);
  const zip64 = withZip64End(empty).subarray(0, 56);
  for (const bytes of [damaged, zip64]) {
    expect(detectStateFormat("archive.dat", bytes)).toBe("zip");
    expect((await readZipView(bytes)).ok).toBe(false);
    const python = (await pythonViews([bytes]))[0];
    expect(python?.file).toMatchObject({ format: "zip", view: null });
    expect(python?.file.error).toBeTypeOf("string");
    expect(python?.passed).toBe(false);
  }
});
