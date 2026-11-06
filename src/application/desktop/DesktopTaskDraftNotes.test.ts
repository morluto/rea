import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { DesktopApplicationCapture } from "../../domain/desktop/desktopCapture.js";
import { draftDesktopApplicationTask } from "./DesktopTaskDraft.js";
import {
  EDITED_NOTE,
  HOME,
  SAVED_NOTE,
  change,
  readers,
  retained,
  seedEndCapture,
  writeCaptureFolder,
} from "./desktopCapture.fixture.js";

const ENDS = { seed: "seed", end: "end" };
const draftSchema = z.looseObject({
  files: z.array(z.unknown()),
  notes: z.array(
    z.looseObject({
      code: z.string(),
      files: z
        .array(z.object({ file: z.string(), role: z.string() }))
        .optional(),
      more: z.int().optional(),
    }),
  ),
});

/** The draft's notes for a capture, between seed and end. */
const notesOf = async (
  recorded: DesktopApplicationCapture,
  extraContent: readonly string[] = [],
) => {
  const result = await draftDesktopApplicationTask(
    await writeCaptureFolder(recorded, undefined, [
      EDITED_NOTE,
      ...extraContent,
    ]),
    readers,
    undefined,
    ENDS,
  );
  if (result instanceof Error) throw result;
  return draftSchema.parse(result.normalized_result);
};

/** The seed-and-end capture with the `end` checkpoint replaced. */
const withEnd = (
  base: DesktopApplicationCapture,
  end: {
    changes: ReturnType<typeof change>[];
    kept: ReturnType<typeof retained>[];
  },
): DesktopApplicationCapture => ({
  ...base,
  state: {
    ...base.state,
    checkpoints: base.state.checkpoints.map((point) =>
      point.name === "end"
        ? { ...point, changes: end.changes, retained: end.kept }
        : point,
    ),
  },
});

describe("draftDesktopApplicationTask notes", () => {
  it("has none when the draft has files", async () => {
    const draft = await notesOf(seedEndCapture());

    expect(draft.files).toHaveLength(1);
    expect(draft.notes).toEqual([]);
  });

  it("says no file changed between seed and end when none did", async () => {
    const draft = await notesOf(
      withEnd(seedEndCapture(), { changes: [], kept: [] }),
    );

    expect(draft.files).toEqual([]);
    // The window title named the note, so the capture recognized a document.
    expect(draft.notes.map(({ code }) => code)).toEqual(["no_change"]);
  });

  it("lists the first five changed files outside the owned paths, desktop files last, when no document was recognized", async () => {
    const base = seedEndCapture();
    const untitled: DesktopApplicationCapture = {
      ...base,
      session: {
        ...base.session,
        windows: base.session.windows.map((window) => ({
          ...window,
          titles: ["Shopping - Notes"],
        })),
      },
    };
    const note = `${HOME}/Documents/today.txt`;
    const others = ["a", "b", "c", "d", "e"].map(
      (name) => `${HOME}/Music/${name}.txt`,
    );
    const fonts = `${HOME}/.cache/fontconfig/cache-1`;
    const draft = await notesOf(
      withEnd(untitled, {
        changes: [
          change(note, { before: SAVED_NOTE, after: EDITED_NOTE }),
          ...[fonts, ...others].map((path) => change(path, { after: "x\n" })),
        ],
        kept: [
          retained(note, EDITED_NOTE),
          ...[fonts, ...others].map((path) => retained(path, "x\n")),
        ],
      }),
      ["x\n"],
    );

    expect(draft.files).toEqual([]);
    expect(draft.notes.map(({ code }) => code)).toEqual([
      "unowned_changes",
      "no_document",
    ]);
    const [unowned] = draft.notes;
    expect(unowned?.files).toEqual([
      { file: "Documents/today.txt", role: "unrelated" },
      ...["a", "b", "c", "d"].map((name) => ({
        file: `Music/${name}.txt`,
        role: "unrelated",
      })),
    ]);
    // Music/e.txt and the shared font cache are counted, not listed.
    expect(unowned?.more).toBe(2);
  });
});
