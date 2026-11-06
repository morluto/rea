import { changedStateFiles } from "./appTaskDraft.js";
import { STATE_PATH_INPUTS } from "./buildCapture.js";
import type { DesktopStatePath, StateEnds } from "./desktopState.js";

/** Why a task draft holds no files, one code per reason; a new reason adds its code. */
export const DRAFT_NOTE_CODES = [
  "no_change",
  "unowned_changes",
  "uncheckable_changes",
  "no_document",
] as const;

/** One reason a task draft holds no files, with the facts it rests on. */
export interface DraftNote {
  readonly code: (typeof DRAFT_NOTE_CODES)[number];
  readonly message: string;
  /**
   * `unowned_changes`: the changed home paths outside the owned paths, with
   * their roles, up to five. `uncheckable_changes`: the dconf databases whose
   * application keys changed, with their roles.
   */
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
 * Why a draft of `drafted` files has none: nothing changed between the seed
 * and end checkpoints, the files that changed lie outside the owned paths, or
 * the app's keys in a dconf database changed, which no check reads; and,
 * whichever, when no file has the document role. Empty for a draft with files.
 */
export const draftNotes = (
  files: ReadonlyMap<string, DesktopStatePath>,
  facts: {
    readonly drafted: number;
    readonly owned: readonly string[];
    /** The capture's dconf databases by home path, which `files` leaves out. */
    readonly dconf: ReadonlyMap<string, DesktopStatePath>;
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
  // A dconf view holds only the app's groups, so it differs only when the app's keys changed or it is unreadable.
  const settings = changedStateFiles(facts.dconf, facts.ends).map(
    ({ home, path }) => ({ file: home, role: path.role }),
  );
  const notes: DraftNote[] = [];
  if (changed.length === 0 && settings.length === 0)
    notes.push({
      code: "no_change",
      message: `No file under the home changed between checkpoints ${seed} and ${end}: save the change in the app before taking ${end}.`,
    });
  if (changed.length > 0) {
    const listed = changed.slice(0, MAX_NOTED_FILES);
    const more = changed.length - listed.length;
    notes.push({
      code: "unowned_changes",
      message: `${String(changed.length)} file(s) changed between ${seed} and ${end}, none under the paths the export owns (${homeList(facts.owned) || "none"}), so data/get serves none of them: ${listed.map(({ file, role }) => `~/${file} (${role})`).join(", ")}${more === 0 ? "" : `, and ${String(more)} more`}. If one is the app's document or data, capture again naming it with ${STATE_PATH_INPUTS}.`,
      files: listed,
      more,
    });
  }
  if (settings.length > 0)
    notes.push({
      code: "uncheckable_changes",
      message: `The app's keys in dconf (${homeList(settings.map(({ file }) => file))}) changed between ${seed} and ${end}, and no check can read them: checks read files under the owned paths, and the export only writes the app's keys as they were at ${seed} when the app first starts. Make the task's change one the app saves in a file.`,
      files: settings,
    });
  if (![...files.values()].some((path) => path.role === "document"))
    notes.push({
      code: "no_document",
      message: `REA recognized no file as the app's document: no app window's title showed a file's name or ~/ path, and no state path named one. When the app saves a document, name it with ${STATE_PATH_INPUTS}.`,
    });
  return notes;
};
