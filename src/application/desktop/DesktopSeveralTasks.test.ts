import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { exportDesktopApplication } from "./DesktopApplicationExport.js";
import {
  BREAD_NOTE,
  EDITED_NOTE,
  NEAR_EGGS_NOTE,
  readers,
  severalEndsCapture,
  writeCaptureFolder,
} from "./desktopCapture.fixture.js";

const NOTE = "Documents/today.txt";

const ADD_EGGS = {
  name: "add-eggs",
  prompt: "In Notes, add eggs to today's list and save it.",
  checks: [
    { id: "eggs", kind: "lines_present", file: NOTE, lines: ["eggs"] },
    { id: "no-bread-yet", kind: "lines_absent", file: NOTE, lines: ["bread"] },
  ],
};
const ADD_BREAD = {
  name: "add-bread",
  prompt: "In Notes, add bread to today's list and save it.",
  checks: [
    { id: "bread", kind: "lines_present", file: NOTE, lines: ["bread"] },
  ],
};

/** Export the two-task capture, its near miss at checkpoint `near`, with these tasks and end checkpoints. */
const exportSeveral = async (
  tasks: readonly unknown[],
  taskEnds: readonly string[],
  near = "near-add-eggs",
) => {
  const scratch = await createTestTempDirectory("desktop-tasks-");
  const paths = await Promise.all(
    tasks.map(async (task, index) => {
      const path = join(scratch, `task-${String(index)}.json`);
      await writeFile(path, JSON.stringify(task));
      return path;
    }),
  );
  const directory = join(scratch, "bundle");
  const result = await exportDesktopApplication(
    {
      capture: await writeCaptureFolder(severalEndsCapture(near), undefined, [
        EDITED_NOTE,
        BREAD_NOTE,
        NEAR_EGGS_NOTE,
      ]),
      directory,
      name: undefined,
      tasks: paths,
      taskEnds,
      seedCheckpoint: "seed",
      endCheckpoint: "end",
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

const refusal = (result: unknown) => {
  expect(result).toBeInstanceOf(Error);
  return (result as Error & { userMessage: string }).userMessage;
};

describe("exportDesktopApplication with several tasks", () => {
  it("checks each task at its own end checkpoint and its near miss, and adds every task with the eval listing them all", async () => {
    const { result, directory } = await exportSeveral(
      [ADD_EGGS, ADD_BREAD],
      ["add-bread=end-add-bread"],
    );

    if (result instanceof Error) throw result;
    expect(result.normalized_result).toMatchObject({
      tasks: [
        {
          name: "add-eggs",
          checks: 2,
          end_checkpoint: "end",
          failing_on_seed: ["eggs"],
          near_checkpoint: "near-add-eggs",
          failing_on_near: ["eggs", "no-bread-yet"],
        },
        {
          name: "add-bread",
          checks: 1,
          end_checkpoint: "end-add-bread",
          failing_on_seed: ["bread"],
          near_checkpoint: null,
          failing_on_near: [],
        },
      ],
    });
    expect(await readFile(join(directory, "evals/notes.toml"), "utf8")).toBe(
      'tasks = ["add-eggs", "add-bread"]\n',
    );
    for (const name of ["add-eggs", "add-bread"]) {
      expect(await exists(join(directory, `tasks/${name}.json`))).toBe(true);
      expect(
        await exists(join(directory, `artifacts/${name}-check/verify.py`)),
      ).toBe(true);
    }
    const readme = await readFile(join(directory, "README.md"), "utf8");
    expect(readme).toContain("## Task `add-eggs`");
    expect(readme).toContain("## Task `add-bread`");
    expect(readme).toContain("--task add-bread --agent claude-code");
  });

  it("refuses a task checked at an end before its change, naming the task and that checkpoint, and writes no bundle", async () => {
    const { result, directory } = await exportSeveral(
      [ADD_EGGS, ADD_BREAD],
      [],
    );

    const message = refusal(result);
    expect(message).toContain('"add-bread"');
    expect(message).toContain("end");
    expect(message).toContain('Check "bread" fails on the captured end state');
    expect(await exists(directory)).toBe(false);
  });

  it("refuses a task its near-<name> checkpoint passes, since the near miss must fail a check", async () => {
    const { result, directory } = await exportSeveral(
      [ADD_EGGS, ADD_BREAD],
      ["add-bread=end-add-bread"],
      "near-add-bread",
    );

    const message = refusal(result);
    expect(message).toContain('"add-bread"');
    expect(message).toContain("near-add-bread");
    expect(await exists(directory)).toBe(false);
  });

  it.each([
    [
      "two tasks of one name",
      [ADD_EGGS, ADD_EGGS],
      [],
      'Two tasks are named "add-eggs"',
    ],
    [
      "an end for a task not given",
      [ADD_EGGS],
      ["add-bread=end-add-bread"],
      '"add-bread"',
    ],
    [
      "an end without its checkpoint",
      [ADD_EGGS],
      ["add-eggs"],
      "NAME=CHECKPOINT",
    ],
    [
      "an end the capture did not take",
      [ADD_EGGS],
      ["add-eggs=end-add-milk"],
      '"end-add-milk"',
    ],
  ])(
    "refuses %s and writes no bundle",
    async (_label, tasks, ends, message) => {
      const { result, directory } = await exportSeveral(tasks, ends);

      expect(refusal(result)).toContain(message);
      expect(await exists(directory)).toBe(false);
    },
  );
});
