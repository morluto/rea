import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { exportDesktopApplication } from "./DesktopApplicationExport.js";
import {
  BREAD_NOTE,
  checkpoint,
  EDITED_NOTE,
  NEAR_EGGS_NOTE,
  readers,
  seedEndCapture,
  severalEndsCapture,
  writeCaptureFolder,
} from "./desktopCapture.fixture.js";
import type { DesktopApplicationCapture } from "../../domain/desktop/desktopCapture.js";

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
) => exportCapture(severalEndsCapture(near), tasks, taskEnds);

/** Export `recorded` with these tasks and end checkpoints, and a screenshot of each checkpoint `shots` names, as a build computer keeps them. */
const exportCapture = async (
  recorded: DesktopApplicationCapture,
  tasks: readonly unknown[],
  taskEnds: readonly string[],
  shots: Readonly<Record<string, string>> = {},
) => {
  const scratch = await createTestTempDirectory("desktop-tasks-");
  const screens = join(scratch, "screens");
  await mkdir(screens);
  for (const [name, text] of Object.entries(shots))
    await writeFile(join(screens, `${name}.jpg`), text);
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
      capture: await writeCaptureFolder(recorded, undefined, [
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
      screens,
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

/** A reader that prints the note's lines, as an app's headless mode would print a file REA reads as binary. */
const LINES_READER = {
  id: "lines",
  file: NOTE,
  argv: [
    "python3",
    "-c",
    "import sys; [print('REA ' + line) for line in open(sys.argv[1]).read().split()]",
    "{file}",
  ],
  output: "lines",
};

const SHOW_LIST = {
  name: "show-list",
  prompt: "In Notes, show the shopping list.",
  checks: [
    {
      id: "shown",
      kind: "screen_judge",
      question: "Does the window show the shopping list?",
    },
  ],
};

/** Eggs added by `end`, then the list shown on screen, which no file records, by `end-show-list`. */
const shownAfterEggsCapture = (): DesktopApplicationCapture => {
  const base = seedEndCapture();
  const { checkpoints } = base.state;
  return {
    ...base,
    state: {
      ...base.state,
      checkpoints: [
        ...checkpoints.slice(0, 3),
        checkpoint("end-show-list", "request", [], []),
        ...checkpoints.slice(3),
      ],
    },
  };
};

describe("exportDesktopApplication with several tasks and readers or screen judges", () => {
  it("runs a later task's readers at its own end checkpoint", async () => {
    const readBread = {
      ...ADD_BREAD,
      checks: [
        {
          id: "bread",
          kind: "lines_present",
          file: NOTE,
          reader: "lines",
          lines: ["bread"],
        },
      ],
      readers: [LINES_READER],
    };
    const { result } = await exportSeveral(
      [ADD_EGGS, readBread],
      ["add-bread=end-add-bread"],
    );

    if (result instanceof Error) throw result;
    expect(result.normalized_result).toMatchObject({
      tasks: [
        { name: "add-eggs" },
        {
          name: "add-bread",
          end_checkpoint: "end-add-bread",
          failing_on_seed: ["bread"],
        },
      ],
    });
  });

  it("judges a later task's screen from the seed to its own end, past a file the task before it changed", async () => {
    const { result, directory } = await exportCapture(
      shownAfterEggsCapture(),
      [ADD_EGGS, SHOW_LIST],
      ["show-list=end-show-list"],
      { seed: "seed shot", "end-show-list": "shown shot" },
    );

    if (result instanceof Error) throw result;
    expect(result.normalized_result).toMatchObject({
      tasks: [
        { name: "add-eggs", end_checkpoint: "end" },
        {
          name: "show-list",
          end_checkpoint: "end-show-list",
          failing_on_seed: [],
        },
      ],
    });
    const verifier = await readFile(
      join(directory, "artifacts/show-list-check/verify.py"),
      "utf8",
    );
    expect(verifier).toContain(Buffer.from("seed shot").toString("base64"));
    expect(verifier).toContain(Buffer.from("shown shot").toString("base64"));
  });

  it("refuses a later screen judge whose own change shows in a file, naming the task", async () => {
    const { result, directory } = await exportSeveral(
      [ADD_EGGS, { ...SHOW_LIST, name: "add-bread" }],
      ["add-bread=end-add-bread"],
    );

    const message = refusal(result);
    expect(message).toContain('"add-bread"');
    expect(message).toContain("between end and end-add-bread");
    expect(await exists(directory)).toBe(false);
  });
});
