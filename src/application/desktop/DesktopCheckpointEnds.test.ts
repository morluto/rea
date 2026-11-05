import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { exportDesktopApplication } from "./DesktopApplicationExport.js";
import { draftDesktopApplicationTask } from "./DesktopTaskDraft.js";
import {
  EDITED_NOTE,
  SAVED_NOTE,
  readers,
  seedEndCapture,
  writeCaptureFolder,
} from "./desktopCapture.fixture.js";

const NOTE = "Documents/today.txt";

const folder = () =>
  writeCaptureFolder(seedEndCapture(), undefined, [EDITED_NOTE]);

const eggs = { id: "eggs", kind: "lines_present", file: NOTE, lines: ["eggs"] };
const wrapped = {
  id: "wrap",
  kind: "value_equals",
  file: ".config/notes/settings.ini",
  pointer: "/groups/ui/wrap",
  value: "true",
};

/** Export the capture between the named checkpoints, with a task holding these checks when any are given. */
const exportBetween = async (
  ends: { seedCheckpoint?: string; endCheckpoint?: string },
  checks: readonly unknown[] = [],
) => {
  const scratch = await createTestTempDirectory("desktop-ends-");
  const task = join(scratch, "task.json");
  await writeFile(
    task,
    JSON.stringify({
      name: "add-eggs",
      prompt: "Add eggs to my list.",
      checks,
    }),
  );
  const directory = join(scratch, "bundle");
  const result = await exportDesktopApplication(
    {
      capture: await folder(),
      directory,
      name: undefined,
      tasks: checks.length === 0 ? [] : [task],
      ...ends,
    },
    readers,
  );
  return { result, directory };
};

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe("exportDesktopApplication between named checkpoints", () => {
  it("seeds the files as they were at the seed checkpoint and keeps a task that fails there and passes at the end", async () => {
    const { result, directory } = await exportBetween(
      { seedCheckpoint: "seed", endCheckpoint: "end" },
      [eggs],
    );

    if (result instanceof Error) throw result;
    expect(result.normalized_result).toMatchObject({
      checkpoints: { seed: "seed", end: "end" },
      seed_files: [".config/notes/settings.ini", NOTE],
      task: { name: "add-eggs", failing_on_seed: ["eggs"] },
    });
    const seed = join(directory, "envs/notes/seed");
    expect(await readFile(join(seed, NOTE), "utf8")).toBe(SAVED_NOTE);
    expect(
      await readFile(join(seed, ".config/notes/settings.ini"), "utf8"),
    ).toBe("[ui]\nwrap=false\n");
  });

  it("keeps the baseline and the last checkpoint when none is named", async () => {
    const { result } = await exportBetween({});

    if (result instanceof Error) throw result;
    expect(result.normalized_result).toMatchObject({
      checkpoints: { seed: "baseline", end: "exit" },
      seed_files: [".config/notes/settings.ini"],
    });
  });

  it("reads the end state at the end checkpoint, not at the capture's last", async () => {
    const atEnd = await exportBetween(
      { seedCheckpoint: "seed", endCheckpoint: "end" },
      [eggs, wrapped],
    );
    const atExit = await exportBetween({ seedCheckpoint: "seed" }, [
      eggs,
      wrapped,
    ]);

    expect(atEnd.result).toMatchObject({ issues: [{ path: ["task"] }] });
    expect((atEnd.result as { userMessage: string }).userMessage).toContain(
      '"wrap"',
    );
    if (atExit.result instanceof Error) throw atExit.result;
    expect(atExit.result.normalized_result).toMatchObject({
      checkpoints: { seed: "seed", end: "exit" },
      task: { failing_on_seed: ["eggs", "wrap"] },
    });
  });

  it.each([
    [{ seedCheckpoint: "saved" }, "seed_checkpoint"],
    [{ endCheckpoint: "Exit" }, "end_checkpoint"],
    [{ seedCheckpoint: "end", endCheckpoint: "seed" }, "end_checkpoint"],
  ])(
    "refuses %j, naming the option, and writes no bundle",
    async (ends, field) => {
      const { result, directory } = await exportBetween(ends);

      expect(result).toMatchObject({
        operation: "export_desktop_application",
        issues: [{ path: [field], reason: "invalid_value" }],
      });
      expect(await exists(directory)).toBe(false);
    },
  );
});

describe("draftDesktopApplicationTask between named checkpoints", () => {
  it("diffs the seed checkpoint against the end checkpoint", async () => {
    const result = await draftDesktopApplicationTask(
      await folder(),
      readers,
      undefined,
      { seed: "seed", end: "end" },
    );

    if (result instanceof Error) throw result;
    expect(result.normalized_result).toMatchObject({
      checkpoints: { baseline: "seed", final: "end" },
      files: [
        {
          file: NOTE,
          baseline: { checkpoint: "seed" },
          final: { checkpoint: "end" },
          change: { kind: "lines", added: ["eggs"], removed: [] },
        },
      ],
      task: {
        checks: [{ kind: "lines_present", file: NOTE, lines: ["eggs"] }],
      },
    });
  });

  it("refuses an unknown checkpoint under its own operation", async () => {
    const result = await draftDesktopApplicationTask(
      await folder(),
      readers,
      undefined,
      { seed: "saved" },
    );

    expect(result).toMatchObject({
      operation: "describe_desktop_application_task",
      issues: [{ path: ["seed_checkpoint"], reason: "invalid_value" }],
    });
  });
});
