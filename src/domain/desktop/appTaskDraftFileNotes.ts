import type { NamedFacts } from "./appTaskDraftNamed.js";

/** Why a file in a draft has few or no suggested checks, one code per reason. */
export const FILE_NOTE_CODES = [
  "by_position",
  "view_state_only",
  "long_text",
  "cut_view",
  "unreadable_view",
] as const;

/** One reason a drafted file's suggestions are thin, with the facts it rests on. */
export interface FileNote {
  readonly code: (typeof FILE_NOTE_CODES)[number];
  readonly file: string;
  readonly message: string;
  /** `by_position`: the tags of elements no attribute names alone, up to five. */
  readonly elements?: readonly string[];
  /** `long_text`: the elements whose text is too long; `view_state_only`: the noise checks kept. Up to five. */
  readonly pointers?: readonly string[];
}

const MAX_LISTED = 5;

/** What a file's change says about whether its views can show it. */
export interface ChangeShape {
  readonly kind: string;
  readonly complete: boolean | undefined;
  readonly format: string | null;
}

/** Notes on what a file's views could not show: one cut short, or one no check can read. */
const viewNotes = (file: string, change: ChangeShape): FileNote[] => {
  const home = `~/${file}`;
  if (
    change.kind === "unreadable" ||
    change.kind === "format" ||
    (change.kind === "content" && change.format === "binary")
  )
    return [
      {
        code: "unreadable_view",
        file,
        message:
          change.format === "binary"
            ? `REA reads ${home} as binary, so no check can look inside it: save it in an uncompressed format the app offers, such as its plain XML, and capture again.`
            : `REA could not read ${home} at one end the same way as at the other, so no check can look inside it; its versions' view_error says why.`,
      },
    ];
  return change.kind === "content" || change.complete === false
    ? [
        {
          code: "cut_view",
          file,
          message: `REA's view of ${home} holds only part of it, so the change may lie outside what a check can see; check what the views do show, or keep the document smaller.`,
        },
      ]
    : [];
};

/** Notes on why a file's suggested checks are thin, from the facts its draft gathered. */
const factNotes = (file: string, facts: NamedFacts): FileNote[] => {
  const home = `~/${file}`;
  const notes: FileNote[] = [];
  if (facts.positional > 0 || facts.changes === 0) {
    const elements = facts.positionalTags.slice(0, MAX_LISTED);
    notes.push({
      code: "by_position",
      file,
      message:
        facts.changes === 0
          ? `${home} changed only in where its elements sit, which no check names; check a value an attribute names instead.`
          : `${String(facts.positional)} change(s) in ${home} reach their element only by position, so no check names them${elements.length === 0 ? "" : `: ${elements.join(", ")} has no attribute naming it alone among its siblings`}. Their values carry note by_position; check an ancestor's text or a value an attribute names, or give the element a name in the app.`,
      ...(elements.length === 0 ? {} : { elements }),
    });
  }
  if (facts.changes > 0 && facts.noise === facts.changes)
    notes.push({
      code: "view_state_only",
      file,
      message: `Every change in ${home} is view state, a renumbered id, a volatile value or a time the app stamps, not an edit: ${facts.flagged.length === 0 ? "no check is suggested" : "the suggested checks are those, kept so the draft is not empty"}. Save the edit the task is about, then capture again.`,
      ...(facts.flagged.length === 0
        ? {}
        : { pointers: facts.flagged.slice(0, MAX_LISTED) }),
    });
  if (facts.long.length > 0)
    notes.push({
      code: "long_text",
      file,
      message: `The text of ${String(facts.long.length)} element(s) in ${home} changed but is longer than the 2,000 characters a text check compares, so no check of its whole text is suggested; check a phrase in it with text_contains.`,
      pointers: facts.long.slice(0, MAX_LISTED),
    });
  return notes;
};

/** Why a drafted file's suggestions are thin: its views could not show the change, or its draft's facts. */
export const fileNotes = (
  file: string,
  change: ChangeShape,
  facts: NamedFacts | undefined,
): FileNote[] => [
  ...viewNotes(file, change),
  ...(facts === undefined ? [] : factNotes(file, facts)),
];
