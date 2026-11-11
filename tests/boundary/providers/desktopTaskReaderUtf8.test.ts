import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import type { DesktopTaskReader } from "../../../src/domain/desktop/appTask.js";
import { evaluateTaskChecks } from "../../../src/domain/desktop/appTaskChecks.js";
import {
  readerAnswerView,
  readerCommand,
} from "../../../src/domain/desktop/appTaskReaders.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const reader: DesktopTaskReader = {
  id: "document",
  file: "Documents/document.bin",
  argv: [
    "python3",
    "-c",
    'import os,sys\nos.write(1, open(sys.argv[1], "rb").read())',
    "{file}",
  ],
  output: "json",
};

/** A headless fixture emits the selected file verbatim through the real runner. */
const read = async (bytes: Uint8Array, output = reader.output) => {
  const root = await createTestTempDirectory("reader-utf8-");
  const source = join(root, "document.bin");
  await writeFile(source, bytes);
  const [python = "", ...argv] = readerCommand({ ...reader, output }, source);
  const { stdout } = await execute(python, argv, { maxBuffer: 1024 * 1024 });
  return readerAnswerView(stdout);
};

const jsonPayload = (value: Uint8Array) =>
  Buffer.concat([Buffer.from('REA {"saved":"'), value, Buffer.from('"}\n')]);

it.each([
  ["an invalid byte in JSON", "json", jsonPayload(Uint8Array.of(0xff))],
  [
    "a truncated UTF-8 sequence in JSON",
    "json",
    jsonPayload(Uint8Array.of(0xe2, 0x82)),
  ],
  ["an invalid byte in lines", "lines", Buffer.from([82, 69, 65, 32, 255, 10])],
] as const)(
  "does not grade replacement-decoded data from %s",
  async (_, output, bytes) => {
    const view = await read(bytes, output);
    expect(view).toMatchObject({
      format: null,
      view: null,
      error: expect.stringContaining("marked output is not valid UTF-8"),
    });
    if (view === undefined) throw new Error("malformed output became absence");
    const check =
      output === "json"
        ? {
            id: "exact",
            kind: "value_equals" as const,
            file: reader.file,
            reader: reader.id,
            pointer: "/saved",
            value: "�",
          }
        : {
            id: "exact",
            kind: "lines_present" as const,
            file: reader.file,
            reader: reader.id,
            lines: ["�"],
          };
    expect(
      evaluateTaskChecks([check], new Map(), new Map([[reader.id, view]])),
    ).toMatchObject([{ passed: false, undecided: true }]);
  },
);

it("preserves a genuinely encoded replacement character in JSON", async () => {
  expect(await read(jsonPayload(Buffer.from("�café😀")))).toEqual({
    format: "json",
    view: { saved: "�café😀" },
  });
});

it("preserves UTF-8 marked lines and CRLF framing", async () => {
  expect(await read(Buffer.from("REA �\r\nREA café😀\n"), "lines")).toEqual({
    format: "text",
    view: { lines: ["�", "café😀"], line_count: 2, truncated: false },
  });
});

it("ignores non-UTF-8 noise outside marked data", async () => {
  expect(
    await read(
      Buffer.concat([
        Buffer.from([0xff, 10]),
        jsonPayload(Buffer.from("kept")),
      ]),
    ),
  ).toEqual({ format: "json", view: { saved: "kept" } });
});
