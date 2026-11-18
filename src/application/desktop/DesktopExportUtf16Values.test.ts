import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { exportDesktopApplication } from "./DesktopApplicationExport.js";
import {
  HOME,
  capture,
  checkpoint,
  readers,
  retained,
  writeCaptureFolder,
} from "./desktopCapture.fixture.js";

it.each(["le", "be"] as const)(
  "exports UTF-16 %s content without consuming its first character as another signature",
  async (order) => {
    const encode = (text: string) => {
      const bytes = Buffer.from(`\uFEFF${text}`, "utf16le");
      return order === "be" ? bytes.swap16() : bytes;
    };
    const input = encode(`\uFEFFtitle\n${HOME}/file\n`);
    const path = `${HOME}/.config/notes/notes.txt`;
    const base = capture();
    const captured = {
      ...base,
      state: {
        ...base.state,
        checkpoints: [
          checkpoint("baseline", "baseline", [], [retained(path, input)]),
        ],
      },
    };
    const folder = await writeCaptureFolder(captured, undefined, [input]);
    const scratch = await createTestTempDirectory("desktop-utf16-values-");
    const directory = join(scratch, "bundle");

    const result = await exportDesktopApplication(
      { capture: folder, directory, name: "notes", tasks: [] },
      readers,
    );

    if (result instanceof Error) throw result;
    const seed = "envs/notes/seed/.config/notes/notes.txt";
    expect(result.normalized_result).toMatchObject({
      scrubbed_files: [seed],
      unscrubbed_files: [],
    });
    const output = await readFile(join(directory, seed));
    expect(output.equals(encode("\uFEFFtitle\n/home/user/file\n"))).toBe(true);
    const source = captured.state.checkpoints[0]?.retained[0];
    expect(source).toBeDefined();
    expect(
      (await readFile(join(folder, "content", source!.sha256))).equals(input),
    ).toBe(true);
  },
);
