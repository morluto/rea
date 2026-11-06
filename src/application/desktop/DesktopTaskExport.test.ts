import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { exportDesktopApplication } from "./DesktopApplicationExport.js";
import { draftDesktopApplicationTask } from "./DesktopTaskDraft.js";
import {
  NOTE as NOTE_PATH,
  capture,
  change,
  readers,
  retained,
  writeCaptureFolder,
} from "./desktopCapture.fixture.js";

const NOTE = "Documents/today.txt";
const DATABASE = ".local/share/notes/notes.db";

/** Export the notes capture with task files written from these values. */
const exportWithTasks = async (...tasks: unknown[]) => {
  const scratch = await createTestTempDirectory("desktop-task-");
  const paths = await Promise.all(
    tasks.map(async (task, index) => {
      const path = join(scratch, `task-${String(index)}.json`);
      await writeFile(
        path,
        typeof task === "string" ? task : JSON.stringify(task),
      );
      return path;
    }),
  );
  const directory = join(scratch, "bundle");
  const result = await exportDesktopApplication(
    {
      capture: await writeCaptureFolder(capture()),
      directory,
      name: undefined,
      tasks: paths,
    },
    readers,
  );
  return { result, directory };
};

const task = (checks: unknown[]) => ({
  name: "note-milk",
  prompt: "Write down that I need milk, and mark the second note.",
  checks,
});

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** The capture with the note present before the edit but its bytes not retained. */
const unretainedNoteCapture = () => {
  const base = capture();
  return {
    ...base,
    state: {
      ...base.state,
      checkpoints: base.state.checkpoints.map((checkpoint) => ({
        ...checkpoint,
        changes: checkpoint.changes.map((entry) =>
          entry.path === NOTE_PATH
            ? {
                ...entry,
                kind: "modified" as const,
                before: {
                  type: "file" as const,
                  size: 4,
                  mode: 0o644,
                  mtime_ns: "1",
                  sha256: null,
                },
              }
            : entry,
        ),
      })),
    },
  };
};

/** A note of 6,000 lines, more than the 5,000 a text view keeps, and the edit that adds `milk` at its top. */
const LONG_NOTE = `${Array.from(
  { length: 6000 },
  (_, index) => `note ${String(index + 1)}`,
).join("\n")}\n`;
const MILK_NOTE = `milk\n${LONG_NOTE}`;

/** The capture with the long note at the seed and `milk` added to it by the edit. */
const longNoteCapture = () => {
  const base = capture();
  return {
    ...base,
    state: {
      ...base.state,
      checkpoints: base.state.checkpoints.map((checkpoint) =>
        checkpoint.trigger === "baseline"
          ? {
              ...checkpoint,
              retained: [
                ...checkpoint.retained,
                retained(NOTE_PATH, LONG_NOTE),
              ],
            }
          : {
              ...checkpoint,
              changes: checkpoint.changes.map((entry) =>
                entry.path === NOTE_PATH
                  ? change(NOTE_PATH, { before: LONG_NOTE, after: MILK_NOTE })
                  : entry,
              ),
              retained: checkpoint.retained.map((entry) =>
                entry.path === NOTE_PATH
                  ? retained(NOTE_PATH, MILK_NOTE)
                  : entry,
              ),
            },
      ),
    },
  };
};

describe("exportDesktopApplication with a task's seed", () => {
  it("refuses a task whose only seed failure misses a line its cut view may have left out", async () => {
    const scratch = await createTestTempDirectory("desktop-task-");
    const path = join(scratch, "task.json");
    await writeFile(
      path,
      JSON.stringify(
        task([
          { id: "milk", kind: "lines_present", file: NOTE, lines: ["milk"] },
        ]),
      ),
    );
    const directory = join(scratch, "bundle");

    const result = await exportDesktopApplication(
      {
        capture: await writeCaptureFolder(longNoteCapture(), undefined, [
          LONG_NOTE,
          MILK_NOTE,
        ]),
        directory,
        name: undefined,
        tasks: [path],
      },
      readers,
    );

    expect(result).toBeInstanceOf(Error);
    const message = (result as Error & { userMessage: string }).userMessage;
    expect(message).toContain("cut short");
    expect(message).toContain(`"milk": ${NOTE} has no line "milk"`);
    expect(await exists(directory)).toBe(false);

    // A failure on what the seed's view shows still keeps it, and only that one counts.
    await writeFile(
      path,
      JSON.stringify(
        task([
          { id: "milk", kind: "lines_present", file: NOTE, lines: ["milk"] },
          {
            id: "row",
            kind: "row_present",
            file: DATABASE,
            table: "notes",
            where: { id: 2 },
          },
        ]),
      ),
    );
    const kept = await exportDesktopApplication(
      {
        capture: await writeCaptureFolder(longNoteCapture(), undefined, [
          LONG_NOTE,
          MILK_NOTE,
        ]),
        directory,
        name: undefined,
        tasks: [path],
      },
      readers,
    );
    if (kept instanceof Error) throw kept;
    expect(kept.normalized_result).toMatchObject({
      task: { failing_on_seed: ["row"] },
    });
  });

  it("treats a file present but not retained at the baseline as absent on the seed, as the computer starts", async () => {
    const scratch = await createTestTempDirectory("desktop-task-");
    const path = join(scratch, "task.json");
    await writeFile(
      path,
      JSON.stringify(task([{ kind: "file_present", file: NOTE }])),
    );

    const result = await exportDesktopApplication(
      {
        capture: await writeCaptureFolder(unretainedNoteCapture()),
        directory: join(scratch, "bundle"),
        name: undefined,
        tasks: [path],
      },
      readers,
    );

    if (result instanceof Error) throw result;
    expect(JSON.stringify(result.normalized_result)).toContain(
      '"failing_on_seed":["check-1"]',
    );
  });
});

describe("exportDesktopApplication with a task", () => {
  it("adds the task, its verifier and the eval once the seed fails and the end passes", async () => {
    const { result, directory } = await exportWithTasks(
      task([
        { id: "milk", kind: "lines_present", file: NOTE, lines: ["milk"] },
        {
          kind: "row_present",
          file: DATABASE,
          table: "notes",
          where: { id: 2, body: "b" },
        },
        {
          kind: "value_equals",
          file: ".config/notes/settings.ini",
          pointer: "/groups/ui/wrap",
          value: "true",
        },
      ]),
    );

    if (result instanceof Error) throw result;
    expect(result.normalized_result).toMatchObject({
      task: {
        name: "note-milk",
        checks: 3,
        failing_on_seed: ["milk", "check-2", "check-3"],
      },
    });
    const steps = JSON.parse(
      await readFile(join(directory, "tasks/note-milk.json"), "utf8"),
    ) as { type: string }[];
    expect(steps.map((step) => step.type)).toEqual([
      "deploy_env",
      "deploy_agent",
      "add_skills",
      "start_computer_recording",
      "prompt_agent",
      "env_outcome_verifier",
      "end_computer_recording",
    ]);
    expect(steps[5]).toMatchObject({
      env_id: "notes",
      file_artifact_id: "note-milk-check",
      verifier_id: "note-milk",
    });
    expect(await readFile(join(directory, "evals/notes.toml"), "utf8")).toBe(
      'tasks = ["note-milk"]\n',
    );
    expect(
      await readFile(
        join(directory, "artifacts/note-milk-check/verify.py"),
        "utf8",
      ),
    ).toContain(
      '{"id": "milk", "kind": "lines_present", "file": "Documents/today.txt", "lines": ["milk"]},',
    );
    const readme = await readFile(join(directory, "README.md"), "utf8");
    expect(readme).toContain("## Task `note-milk`");
    expect(readme).toContain("> Write down that I need milk");
    expect(readme).toContain("--task note-milk --agent claude-code");
  });

  it.each([
    [
      [task([]), task([])],
      "2 task files were given; a capture yields one task.",
    ],
    ["{", "is not valid UTF-8 JSON"],
    ["\uFEFF{}", "Save the file as UTF-8 without a byte-order mark"],
    [
      task([{ kind: "file_present", file: ".cache/notes/x" }]),
      "not under the app's owned paths",
    ],
    [
      task([{ kind: "lines_present", file: NOTE, lines: ["/home/ada/milk"] }]),
      "names the captured home /home/ada",
    ],
    [
      task([
        {
          kind: "value_equals",
          file: NOTE,
          pointer: "/lines/0",
          value: "milk",
        },
      ]),
      "which is text; use lines_present",
    ],
    [
      task([
        { id: "eggs", kind: "lines_present", file: NOTE, lines: ["eggs"] },
      ]),
      'Check "eggs" fails on the captured end state: Documents/today.txt has no line "eggs"',
    ],
    [
      task([{ kind: "file_present", file: ".config/notes/settings.ini" }]),
      "Every check already passes on the seed",
    ],
    [
      task([
        { kind: "lines_present", file: NOTE, lines: ["milk"] },
        { kind: "row_count", file: DATABASE, table: "notes", equals: 1 },
      ]),
      'Check "check-2" fails on the captured end state',
    ],
  ])("refuses %j and writes no bundle", async (input, message) => {
    const { result, directory } = await exportWithTasks(
      ...(Array.isArray(input) ? input : [input]),
    );

    expect(result).toBeInstanceOf(Error);
    expect((result as Error & { userMessage: string }).userMessage).toContain(
      message,
    );
    expect(await exists(directory)).toBe(false);
  });
});

describe("draftDesktopApplicationTask", () => {
  it("drafts checks of the document that changed, which the export then accepts", async () => {
    const folder = await writeCaptureFolder(capture());

    const result = await draftDesktopApplicationTask(folder, readers);

    if (result instanceof Error) throw result;
    const draft = result.normalized_result as {
      files: { file: string; change: { kind: string } }[];
      task: { name: string; prompt: string; checks: unknown[] };
    };
    expect(result.operation).toBe("describe_desktop_application_task");
    expect(draft.files.map(({ file, change }) => [file, change.kind])).toEqual([
      [".config/notes/settings.ini", "keys"],
      [DATABASE, "rows"],
      [NOTE, "created"],
    ]);
    expect(draft.task.checks).toEqual([
      { id: "check-1", kind: "file_present", file: NOTE },
      { id: "check-2", kind: "lines_present", file: NOTE, lines: ["milk"] },
    ]);
    const { result: exported } = await exportWithTasks({
      ...draft.task,
      prompt: "Write down that I need milk.",
    });
    expect(exported).not.toBeInstanceOf(Error);
  });
});
