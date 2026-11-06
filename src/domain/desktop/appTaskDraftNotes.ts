import { z } from "zod";

import { changedStateFiles, type TaskDraftFile } from "./appTaskDraft.js";
import { FILE_NOTE_CODES, type FileNote } from "./appTaskDraftFileNotes.js";
import { STATE_PATH_INPUTS } from "./buildCapture.js";
import type { DesktopStatePath, StateEnds } from "./desktopState.js";

/** Why a task draft holds no files, one code per reason; a new reason adds its code. */
const EMPTY_DRAFT_CODES = [
  "no_change",
  "unowned_changes",
  "no_document",
] as const;

/** Why a draft is empty, or a file in it has few or no suggested checks: one code per reason. */
export const DRAFT_NOTE_CODES = [
  ...EMPTY_DRAFT_CODES,
  ...FILE_NOTE_CODES,
] as const;

/** A draft's note as the draft writes it. */
export const draftNoteSchema = z.strictObject({
  code: z.enum(DRAFT_NOTE_CODES),
  message: z.string(),
  file: z
    .string()
    .optional()
    .describe(
      "by_position, view_state_only, long_text, cut_view, unreadable_view: the drafted file the note is about.",
    ),
  files: z
    .array(z.strictObject({ file: z.string(), role: z.string() }))
    .optional()
    .describe(
      "unowned_changes: changed home paths outside the owned paths, up to 5.",
    ),
  more: z
    .int()
    .nonnegative()
    .optional()
    .describe("unowned_changes: how many more changed."),
  elements: z
    .array(z.string())
    .optional()
    .describe(
      "by_position: tags of the elements no attribute names alone, up to 5.",
    ),
  pointers: z
    .array(z.string())
    .optional()
    .describe(
      "long_text: the elements whose text is too long to check whole; view_state_only: the noise checks kept. Up to 5.",
    ),
});

/** One reason a task draft holds no files, with the facts it rests on. */
export interface EmptyDraftNote {
  readonly code: (typeof EMPTY_DRAFT_CODES)[number];
  readonly message: string;
  /** `unowned_changes`: the changed home paths outside the owned paths, with their roles, up to five. */
  readonly files?: readonly { readonly file: string; readonly role: string }[];
  /** `unowned_changes`: how many more changed. */
  readonly more?: number;
}

/** Why a draft is empty, or why one of its files has thin suggestions. */
export type DraftNote = EmptyDraftNote | FileNote;

const MAX_NOTED_FILES = 5;
/** Files a user may have made first, desktop services' last. */
const ROLE_ORDER: Readonly<Record<DesktopStatePath["role"], number>> = {
  document: 0,
  application_state: 1,
  unrelated: 2,
  shared_desktop: 3,
};

const homeList = (paths: readonly string[]) =>
  paths.map((path) => `~/${path}`).join(", ");

/**
 * Why a draft of `drafted` files is thin: for a draft with files, each file's
 * own notes; for one with none, that no file changed between the seed and end
 * checkpoints, or that those that changed lie outside the owned paths; and,
 * either way, when no file has the document role.
 */
export const draftNotes = (
  files: ReadonlyMap<string, DesktopStatePath>,
  facts: {
    readonly drafted: readonly Pick<TaskDraftFile, "notes">[];
    readonly owned: readonly string[];
    readonly ends: StateEnds;
    readonly checkpoints: readonly string[];
  },
): readonly DraftNote[] => {
  if (facts.drafted.length > 0)
    return facts.drafted.flatMap(({ notes }) => notes);
  const seed = facts.checkpoints[facts.ends.seed] ?? "the seed";
  const end = facts.checkpoints[facts.ends.end] ?? "the end";
  const changed = changedStateFiles(files, facts.ends)
    .map(({ home, path }) => ({ file: home, role: path.role }))
    .sort(
      (left, right) =>
        ROLE_ORDER[left.role] - ROLE_ORDER[right.role] ||
        (left.file < right.file ? -1 : 1),
    );
  const notes: EmptyDraftNote[] = [];
  if (changed.length === 0)
    notes.push({
      code: "no_change",
      message: `No file under the home changed between checkpoints ${seed} and ${end}: save the change in the app before taking ${end}.`,
    });
  else {
    const listed = changed.slice(0, MAX_NOTED_FILES);
    const more = changed.length - listed.length;
    notes.push({
      code: "unowned_changes",
      message: `${String(changed.length)} file(s) changed between ${seed} and ${end}, none under the paths the export owns (${homeList(facts.owned) || "none"}), so data/get serves none of them: ${listed.map(({ file, role }) => `~/${file} (${role})`).join(", ")}${more === 0 ? "" : `, and ${String(more)} more`}. If one is the app's document or data, capture again naming it with ${STATE_PATH_INPUTS}.`,
      files: listed,
      more,
    });
  }
  if (![...files.values()].some((path) => path.role === "document"))
    notes.push({
      code: "no_document",
      message: `REA recognized no file as the app's document: no app window's title showed a file's name or ~/ path, and no state path named one. When the app saves a document, name it with ${STATE_PATH_INPUTS}.`,
    });
  return notes;
};
