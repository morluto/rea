import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { readZipView } from "../../src/application/desktop/DesktopZipView.js";
import type { DesktopTaskCheck } from "../../src/domain/desktop/appTask.js";
import {
  evaluateTaskChecks,
  type TaskCheckOutcome,
  type TaskFileView,
} from "../../src/domain/desktop/appTaskChecks.js";
import {
  PYTHON_HELPERS,
  PYTHON_IMPORTS,
} from "../../src/domain/desktop/appExportPython.js";
import { PYTHON_TASK_EVALUATOR } from "../../src/domain/desktop/appTaskPython.js";
import {
  detectStateFormat,
  textualView,
} from "../../src/domain/desktop/stateFormats.js";
import { zipArchive } from "../../src/domain/desktop/zipArchive.fixture.js";
import type { JsonValue } from "../../src/domain/jsonValue.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

/** A file as an app saved it: its name under the home and its bytes. */
export interface SavedFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

const FIXTURES = join(import.meta.dirname, "../fixtures");

/**
 * A fixture's two saves, before and after its edit, read from
 * `tests/fixtures/FOLDER/{before,after}/FILE` as the file `name`, each
 * wrapped, such as a Writer `content.xml` zipped into an `.odt`.
 */
export const savedEnds = (
  folder: string,
  file: string,
  name: string = file,
  wrap: (bytes: Uint8Array) => Uint8Array = (bytes) => bytes,
): Promise<SavedFile[]> =>
  Promise.all(
    (["before", "after"] as const).map(async (end) => ({
      name,
      bytes: wrap(await readFile(join(FIXTURES, folder, end, file))),
    })),
  );

/** A Writer `content.xml` zipped into an `.odt` after its stored `mimetype`, as Writer saves one. */
export const odtOf = (content: Uint8Array): Uint8Array =>
  zipArchive([
    {
      name: "mimetype",
      data: "application/vnd.oasis.opendocument.text",
      method: 0,
    },
    { name: "content.xml", data: content },
  ]);

/** The exported module's standard library imports, its helpers and the verifier's evaluator, as one program. */
const PYTHON = `${PYTHON_IMPORTS.split("\n")
  .filter((line) => !line.includes("agentenv_protocol"))
  .join("\n")}${PYTHON_HELPERS}${PYTHON_TASK_EVALUATOR}`;

/** Run a driver after the exported module's helpers and evaluator, with JSON on its stdin; its stdout. */
export const exportedPython = (driver: string, input: unknown): string =>
  // Send the generated program over UTF-8 stdin rather than a Windows-limited
  // command line, while preserving the driver's separate JSON input stream.
  execFileSync(
    process.platform === "win32" ? "python" : "python3",
    [
      "-I",
      "-B",
      "-X",
      "utf8",
      "-c",
      [
        "import io, json, sys",
        "source, payload = json.load(sys.stdin)",
        "sys.stdin = io.StringIO(payload)",
        'exec(compile(source, "<string>", "exec"))',
      ].join("\n"),
    ],
    {
      input: JSON.stringify([`${PYTHON}\n${driver}`, JSON.stringify(input)]),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );

/** One JSON value per line the driver printed. */
const printed = <Value>(output: string): Value[] =>
  output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Value);

/** Write each file into a fresh folder, as data/get finds it under the home, keeping its suffix; their paths. */
export const writeFiles = async (files: readonly SavedFile[]) => {
  const folder = await createTestTempDirectory("desktop-export-python-");
  return Promise.all(
    files.map(async ({ name, bytes }, index) => {
      const path = join(folder, `${String(index)}-${name}`);
      await writeFile(path, bytes);
      return path;
    }),
  );
};

/** The exported module's data/get entry for each file: its format and view, or its error. */
export const pythonFileViews = async (files: readonly SavedFile[]) =>
  printed<Record<string, JsonValue>>(
    exportedPython(
      `for path in json.load(sys.stdin):
    print(json.dumps(_view(Path(path))))`,
      await writeFiles(files),
    ),
  );

/** The verifier's results for each file, read by the exported module as the home path `home`. */
const pythonCheckResults = async (
  home: string,
  checks: readonly DesktopTaskCheck[],
  files: readonly SavedFile[],
) =>
  printed<{ id: string; result: boolean; description: string }[]>(
    exportedPython(
      `request = json.load(sys.stdin)
for path in request["paths"]:
    print(json.dumps(evaluate(request["checks"], {request["home"]: _view(Path(path))})))`,
      { home, checks, paths: await writeFiles(files) },
    ),
  );

/** The exported module's XML view of each text, or null where it refuses one. */
export const pythonXmlViews = (texts: readonly string[]) =>
  printed<JsonValue>(
    exportedPython(
      `for text in json.load(sys.stdin):
    print(json.dumps(_xml_view(text)))`,
      texts,
    ),
  );

/** REA's state view of a zip, text, JSON, key file or XML file, in the shape data/get serves it. */
export const typescriptFileView = async ({
  name,
  bytes,
}: SavedFile): Promise<TaskFileView> => {
  const format = detectStateFormat(name, bytes);
  if (format === "sqlite" || format === "dconf" || format === "binary")
    throw new Error(`${name} is ${format}, which these tests do not read`);
  const read =
    format === "zip" ? await readZipView(bytes) : textualView(format, bytes);
  return read.ok
    ? { format, view: read.value }
    : { format, view: null, error: read.error };
};

/** Both readers give each file the same format and view, or the same error. */
export const expectSameFileViews = async (files: readonly SavedFile[]) => {
  const fromPython = await pythonFileViews(files);
  for (const [index, file] of files.entries()) {
    const ours = await typescriptFileView(file);
    const theirs = fromPython[index] ?? {};
    expect(theirs.format).toBe(ours.format);
    expect(theirs.view).toEqual(ours.view);
    expect(theirs.error).toBe(ours.error);
  }
};

/** Both evaluators give the same results and descriptions on each file read as the home path `home`; REA's. */
export const expectSameCheckResults = async (
  home: string,
  checks: readonly DesktopTaskCheck[],
  files: readonly SavedFile[],
): Promise<(readonly TaskCheckOutcome[])[]> => {
  const fromPython = await pythonCheckResults(home, checks, files);
  return Promise.all(
    files.map(async (file, index) => {
      const ours = evaluateTaskChecks(
        checks,
        new Map([[home, await typescriptFileView(file)]]),
      );
      expect(fromPython[index]).toEqual(
        ours.map(({ id, passed, description }) => ({
          id,
          result: passed,
          description,
        })),
      );
      return ours;
    }),
  );
};
