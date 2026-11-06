import { changedStateFiles } from "./appTaskDraft.js";
import { STATE_PATH_INPUTS } from "./buildCapture.js";
import type { DesktopStatePath, StateEnds } from "./desktopState.js";

/** Why a task draft holds no files, one code per reason; a new reason adds its code. */
export const DRAFT_NOTE_CODES = [
  "no_change",
  "unowned_changes",
  "no_document",
] as const;

/** One reason a task draft holds no files, with the facts it rests on. */
export interface DraftNote {
  readonly code: (typeof DRAFT_NOTE_CODES)[number];
  readonly message: string;
  /** `unowned_changes`: the changed home paths outside the owned paths, with their roles, up to five. */
  readonly files?: readonly { readonly file: string; readonly role: string }[];
  /** `unowned_changes`: how many more changed. */
  readonly more?: number;
}

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
 * Why a draft of `drafted` files has none: no file changed between the seed
 * and end checkpoints, or those that changed lie outside the owned paths;
 * and, either way, when no file has the document role. Empty for a draft
 * with files.
 */
export const draftNotes = (
  files: ReadonlyMap<string, DesktopStatePath>,
  facts: {
    readonly drafted: number;
    readonly owned: readonly string[];
    readonly ends: StateEnds;
    readonly checkpoints: readonly string[];
  },
): readonly DraftNote[] => {
  if (facts.drafted > 0) return [];
  const seed = facts.checkpoints[facts.ends.seed] ?? "the seed";
  const end = facts.checkpoints[facts.ends.end] ?? "the end";
  const changed = changedStateFiles(files, facts.ends)
    .map(({ home, path }) => ({ file: home, role: path.role }))
    .sort(
      (left, right) =>
        ROLE_ORDER[left.role] - ROLE_ORDER[right.role] ||
        (left.file < right.file ? -1 : 1),
    );
  const notes: DraftNote[] = [];
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
