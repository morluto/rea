import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import type {
  DesktopApplicationCapture,
  DesktopStateChange,
} from "../../domain/desktop/desktopCapture.js";
import type { DesktopStateReaders } from "./DesktopApplicationState.js";
import { draftDesktopApplicationTask } from "./DesktopTaskDraft.js";
import {
  EDITED_NOTE,
  HOME,
  NOTE,
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
  extraContent: readonly (string | Buffer)[] = [],
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
    changes: DesktopStateChange[];
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

const database = `${HOME}/.config/dconf/user`;
// dconf databases by the keys they hold; the reader dumps each as dconf does.
const dumps: Readonly<Record<string, string>> = {
  "GVariant wrap=false": "[org/example/notes]\nwrap=false\n",
  "GVariant wrap=true": "[org/example/notes]\nwrap=true\n",
  "GVariant wallpaper=blue":
    "[org/example/notes]\nwrap=false\n\n[org/gnome/desktop/background]\ncolor='blue'\n",
  "GVariant desktop only": "[org/gnome/desktop/background]\ncolor='blue'\n",
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

describe("draftDesktopApplicationTask notes", () => {
  it("has none when the draft has files", async () => {
    const draft = await notesOf(seedEndCapture());

    expect(draft.files).toHaveLength(1);
    expect(draft.notes).toEqual([]);
  });

  it("passes on a drafted file's own notes, such as a document REA reads as binary", async () => {
    const [before, after] = [1, 2].map((version) =>
      Buffer.from([0x1f, 0x8b, 0x08, 0x00, version]),
    );
    if (before === undefined || after === undefined) throw new Error("fixture");
    const base = seedEndCapture();
    const compressed: DesktopApplicationCapture = {
      ...base,
      state: {
        ...base.state,
        checkpoints: base.state.checkpoints.map((point) =>
          point.name === "seed"
            ? {
                ...point,
                changes: [change(NOTE, { after: before })],
                retained: [retained(NOTE, before)],
              }
            : point.name === "end"
              ? {
                  ...point,
                  changes: [change(NOTE, { before, after })],
                  retained: [retained(NOTE, after)],
                }
              : point,
        ),
      },
    };

    const draft = await notesOf(compressed, [before, after]);

    expect(draft.files).toHaveLength(1);
    expect(draft.notes).toEqual([
      expect.objectContaining({
        code: "unreadable_view",
        file: "Documents/today.txt",
      }),
    ]);
  });

  it("says no file changed between seed and end when none did", async () => {
    const draft = await notesOf(
      withEnd(seedEndCapture(), { changes: [], kept: [] }),
    );

    expect(draft.files).toEqual([]);
    // The window title named the note, so the capture recognized a document.
    expect(draft.notes.map(({ code }) => code)).toEqual(["no_change"]);
  });

  it("does not call reordered saved lines unchanged when the value diff is empty", async () => {
    const base = seedEndCapture();
    const note = `${HOME}/Documents/today.txt`;
    const before = "milk\neggs\n";
    const after = "eggs\nmilk\n";
    const capture = {
      ...base,
      state: {
        ...base.state,
        checkpoints: base.state.checkpoints.map((point) =>
          point.name === "seed"
            ? {
                ...point,
                changes: [change(note, { after: before })],
                retained: [retained(note, before)],
              }
            : point.name === "end"
              ? {
                  ...point,
                  changes: [change(note, { before, after })],
                  retained: [retained(note, after)],
                }
              : point,
        ),
      },
    };
    const draft = await notesOf(capture, [before, after]);
    expect(draft.files).toEqual([]);
    expect(draft.notes.map(({ code }) => code)).not.toContain("no_change");
    expect(draft.notes.map(({ code }) => code)).toContain(
      "uncheckable_changes",
    );
  });

  it("does not call an empty change list unchanged when a checkpoint was cut short", async () => {
    const base = withEnd(seedEndCapture(), { changes: [], kept: [] });
    const cut: DesktopApplicationCapture = {
      ...base,
      state: {
        ...base.state,
        checkpoints: base.state.checkpoints.map((point) =>
          point.name === "end" ? { ...point, truncated: true } : point,
        ),
      },
    };
    const draft = await notesOf(cut);
    expect(draft.notes.map(({ code }) => code)).toContain("incomplete_capture");
    expect(draft.notes.map(({ code }) => code)).not.toContain("no_change");
  });

  it("does not call the ends unchanged when a checkpoint between them left a deletion unconfirmed", async () => {
    const base = withEnd(seedEndCapture(), { changes: [], kept: [] });
    const seedAt = base.state.checkpoints.findIndex(
      (point) => point.name === "seed",
    );
    const seed = base.state.checkpoints[seedAt];
    if (seed === undefined) throw new Error("the fixture has a seed");
    const partial: DesktopApplicationCapture = {
      ...base,
      state: {
        ...base.state,
        checkpoints: [
          ...base.state.checkpoints.slice(0, seedAt + 1),
          {
            ...seed,
            name: "during",
            trigger: "request",
            unconfirmed_changes: 1,
            changes: [],
          },
          ...base.state.checkpoints.slice(seedAt + 1),
        ],
      },
    };
    const draft = await notesOf(partial);

    expect(draft.notes.map(({ code }) => code)).toContain("incomplete_capture");
    expect(draft.notes.map(({ code }) => code)).not.toContain("no_change");
  });
});

describe("draftDesktopApplicationTask notes for unowned files", () => {
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

describe("draftDesktopApplicationTask notes for retained dconf state", () => {
  it("says a change the app saved only in dconf is one no check reads, rather than that nothing changed", async () => {
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
    // Desktop-only changes do not establish that no file changed.
    expect(desktop.notes.map(({ code }) => code)).toEqual([
      "uncheckable_changes",
    ]);
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

describe("draftDesktopApplicationTask notes on a dconf database the capture kept no copy of", () => {
  it("keeps a dconf database unknown when the capture kept no copy of its starting bytes", async () => {
    /** As the recorder writes it: the first walk keeps no copy of the database, so its change has no starting digest. */
    const unkept = (after: string): DesktopApplicationCapture => {
      const written = change(database, {
        before: "GVariant wrap=false",
        after,
      });
      return withEnd(seedEndCapture(), {
        changes: [
          {
            ...written,
            before:
              written.before === null
                ? null
                : { ...written.before, sha256: null },
          },
        ],
        kept: [retained(database, after)],
      });
    };

    const saved = await notesOf(
      unkept("GVariant wrap=true"),
      Object.keys(dumps),
      dconfReaders,
    );
    const desktop = await notesOf(
      unkept("GVariant desktop only"),
      Object.keys(dumps),
      dconfReaders,
    );

    expect(saved.notes.map(({ code }) => code)).toEqual(["unreadable_changes"]);
    expect(saved.notes[0]?.error).toContain("content not retained");
    expect(saved.notes[0]?.files).toEqual([
      { file: ".config/dconf/user", role: "application_state" },
    ]);
    expect(desktop.notes.map(({ code }) => code)).toEqual([
      "unreadable_changes",
    ]);
  });
});

describe("draftDesktopApplicationTask notes for an incomplete checkpoint", () => {
  it("does not call an empty change list unchanged when a checkpoint omits how many paths it left unchecked", async () => {
    const base = withEnd(seedEndCapture(), { changes: [], kept: [] });
    const omitted: DesktopApplicationCapture = {
      ...base,
      state: {
        ...base.state,
        checkpoints: base.state.checkpoints.map((point) => {
          const { unchecked_paths: _dropped, ...rest } = point;
          return rest;
        }),
      },
    };
    const draft = await notesOf(omitted);
    expect(draft.notes.map(({ code }) => code)).toContain("incomplete_capture");
    expect(draft.notes.map(({ code }) => code)).not.toContain("no_change");
  });
});
