import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { exportDesktopApplication } from "./DesktopApplicationExport.js";
import { draftDesktopApplicationTask } from "./DesktopTaskDraft.js";
import {
  HOME,
  NOTE as NOTE_PATH,
  capture,
  change,
  readers,
  retained,
  seedEndCapture,
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

/** The seed-and-end capture with the app's log, which the seed leaves out, holding `error A` at the seed and not at the end. */
const LOG = `${HOME}/.config/notes/notes.log`;
const loggedCapture = () => {
  const base = seedEndCapture();
  return {
    ...base,
    state: {
      ...base.state,
      checkpoints: base.state.checkpoints.map((checkpoint) =>
        checkpoint.name === "seed" || checkpoint.name === "end"
          ? {
              ...checkpoint,
              changes: [
                ...checkpoint.changes,
                checkpoint.name === "seed"
                  ? change(LOG, { after: "error A\n" }, { state: true })
                  : change(
                      LOG,
                      { before: "error A\n", after: "ok\n" },
                      { state: true },
                    ),
              ],
              retained: [
                ...checkpoint.retained,
                retained(
                  LOG,
                  checkpoint.name === "seed" ? "error A\n" : "ok\n",
                ),
              ],
            }
          : checkpoint,
      ),
    },
  };
};

describe("exportDesktopApplication with the seed it ships", () => {
  it("checks the seed the bundle ships, without the app's log it leaves out", async () => {
    const scratch = await createTestTempDirectory("desktop-task-");
    const path = join(scratch, "task.json");
    await writeFile(
      path,
      JSON.stringify(
        task([
          {
            id: "no-error",
            kind: "lines_absent",
            file: ".config/notes/notes.log",
            lines: ["error A"],
          },
        ]),
      ),
    );
    const directory = join(scratch, "bundle");

    const result = await exportDesktopApplication(
      {
        capture: await writeCaptureFolder(loggedCapture(), undefined, [
          "milk\neggs\n",
          "error A\n",
          "ok\n",
        ]),
        directory,
        name: undefined,
        tasks: [path],
        seedCheckpoint: "seed",
        endCheckpoint: "end",
      },
      readers,
    );

    expect(result).toBeInstanceOf(AnalysisInputError);
    expect((result as AnalysisInputError).userMessage).toContain(
      "Every check already passes on the seed",
    );
    expect(await exists(directory)).toBe(false);
  });
});

describe("exportDesktopApplication with a task's seed", () => {
  it("refuses a task whose only seed failure misses a line its cut view may have left out", async () => {
    const scratch = await createTestTempDirectory("desktop-task-");
    const path = join(scratch, "task.json");
    await writeFile(
      path,
      JSON.stringify(
        task([
          {
            id: "has-milk",
            kind: "lines_present",
            file: NOTE,
            lines: ["milk"],
          },
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

    expect(result).toBeInstanceOf(AnalysisInputError);
    const { issues, userMessage } = result as AnalysisInputError;
    expect(issues.map(({ path }) => path)).toEqual([["task"]]);
    // The undecided check by id, with its file and line, in any wording.
    for (const fact of [JSON.stringify("has-milk"), NOTE, '"milk"'])
      expect(userMessage).toContain(fact);
    expect(await exists(directory)).toBe(false);

    // A failure on what the seed's view shows still keeps it, and only that one counts.
    await writeFile(
      path,
      JSON.stringify(
        task([
          {
            id: "has-milk",
            kind: "lines_present",
            file: NOTE,
            lines: ["milk"],
          },
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
      tasks: [{ failing_on_seed: ["row"] }],
    });
  });

  it("keeps a task whose one check failing on the seed is a member count", async () => {
    const { result } = await exportWithTasks(
      task([
        {
          id: "first",
          kind: "row_present",
          file: DATABASE,
          table: "notes",
          where: { id: 1 },
        },
        {
          id: "notes",
          kind: "member_count",
          file: DATABASE,
          pointer: "/tables/notes/rows",
          equals: 2,
        },
      ]),
    );

    if (result instanceof Error) throw result;
    expect(result.normalized_result).toMatchObject({
      tasks: [{ checks: 2, failing_on_seed: ["notes"] }],
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
      tasks: [
        {
          name: "note-milk",
          checks: 3,
          end_checkpoint: "edited",
          failing_on_seed: ["milk", "check-2", "check-3"],
          near_checkpoint: null,
          failing_on_near: [],
        },
      ],
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
      [
        task([{ kind: "lines_present", file: NOTE, lines: ["milk"] }]),
        task([{ kind: "lines_present", file: NOTE, lines: ["milk"] }]),
      ],
      'Two tasks are named "note-milk"',
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
        {
          kind: "text_contains",
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

describe("exportDesktopApplication with a task's prompt", () => {
  it("names a prompt that does not name the app in its limitations, since a solver's shell cannot see the computer", async () => {
    const checks = [
      { id: "milk", kind: "lines_present", file: NOTE, lines: ["milk"] },
    ];
    const unnamed = await exportWithTasks(task(checks));
    const named = await exportWithTasks({
      ...task(checks),
      prompt: "In Notes, write down that I need milk.",
    });

    if (unnamed.result instanceof Error) throw unnamed.result;
    if (named.result instanceof Error) throw named.result;
    const naming = (limitations: readonly string[]) =>
      limitations.filter((line) => line.includes("prompt"));
    expect(naming(unnamed.result.limitations)).toHaveLength(1);
    expect(naming(unnamed.result.limitations)[0]).toContain("notes");
    expect(naming(named.result.limitations)).toEqual([]);
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
