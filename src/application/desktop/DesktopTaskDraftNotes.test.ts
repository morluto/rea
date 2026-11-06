import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { DesktopApplicationCapture } from "../../domain/desktop/desktopCapture.js";
import type { DesktopStateReaders } from "./DesktopApplicationState.js";
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
      error: z.string().optional(),
    }),
  ),
});

/** The draft's notes for a capture, between seed and end. */
const notesOf = async (
  recorded: DesktopApplicationCapture,
  extraContent: readonly string[] = [],
  stateReaders: DesktopStateReaders = readers,
) => {
  const result = await draftDesktopApplicationTask(
    await writeCaptureFolder(recorded, undefined, [
      EDITED_NOTE,
      ...extraContent,
    ]),
    stateReaders,
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

  it("says a change the app saved only in dconf is one no check reads, rather than that nothing changed", async () => {
    const database = `${HOME}/.config/dconf/user`;
    // dconf databases by the keys they hold; the reader dumps each as dconf does.
    const dumps: Readonly<Record<string, string>> = {
      "GVariant wrap=false": "[org/example/notes]\nwrap=false\n",
      "GVariant wrap=true": "[org/example/notes]\nwrap=true\n",
      "GVariant wallpaper=blue":
        "[org/example/notes]\nwrap=false\n\n[org/gnome/desktop/background]\ncolor='blue'\n",
    };
    const dconfReaders: DesktopStateReaders = {
      ...readers,
      dconf: async (path) => {
        const dump = dumps[await readFile(path, "latin1")];
        return dump === undefined
          ? { ok: false, error: "not a fixture database" }
          : { ok: true, text: dump };
      },
    };
    /** The seed-and-end capture whose only change from seed to end is the dconf database's, to `after`. */
    const savedInDconf = (after: string): DesktopApplicationCapture => {
      const ended = withEnd(seedEndCapture(), {
        changes: [change(database, { before: "GVariant wrap=false", after })],
        kept: [retained(database, after)],
      });
      const [baseline, ...later] = ended.state.checkpoints;
      if (baseline === undefined) throw new Error("the fixture has a baseline");
      return {
        ...ended,
        state: {
          ...ended.state,
          checkpoints: [
            {
              ...baseline,
              retained: [
                ...baseline.retained,
                retained(database, "GVariant wrap=false"),
              ],
            },
            ...later,
          ],
        },
      };
    };

    const saved = await notesOf(
      savedInDconf("GVariant wrap=true"),
      Object.keys(dumps),
      dconfReaders,
    );
    const desktop = await notesOf(
      savedInDconf("GVariant wallpaper=blue"),
      Object.keys(dumps),
      dconfReaders,
    );
    // The reader fails on this database, as it does when dconf-cli is missing.
    const unread = await notesOf(
      savedInDconf("GVariant unknown"),
      [...Object.keys(dumps), "GVariant unknown"],
      dconfReaders,
    );

    expect(saved.files).toEqual([]);
    expect(saved.notes.map(({ code }) => code)).toEqual([
      "uncheckable_changes",
    ]);
    expect(saved.notes[0]?.files).toEqual([
      { file: ".config/dconf/user", role: "application_state" },
    ]);
    // Only the desktop's own keys changed, so nothing the app saved did.
    expect(desktop.notes.map(({ code }) => code)).toEqual(["no_change"]);
    // A database REA could not read changed: whose keys is unknown, and the read error is kept.
    expect(unread.notes).toMatchObject([
      {
        code: "unreadable_changes",
        files: [{ file: ".config/dconf/user", role: "application_state" }],
        error: "not a fixture database",
      },
    ]);
  });
});
