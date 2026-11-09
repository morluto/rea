import { isWellFormedXml, opensLikeXml } from "../xmlDocument.js";
import type { NamedFacts } from "./appTaskDraftNamed.js";
import { doctypeHasInternalSubset } from "./stateFormats.js";

/** Why a file in a draft has few or no suggested checks, one code per reason. */
export const FILE_NOTE_CODES = [
  "by_position",
  "view_state_only",
  "long_text",
  "cut_view",
  "unreadable_view",
  "volatile_lines",
  "read_as_text",
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
            ? `REA reads ${home} as binary, so no check can look inside it: save it in a format the app offers that REA reads, such as XML, JSON or text, plain or gzip-compressed, or a zip document, and capture again.`
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
      message: `${String(facts.long.length)} value(s) in ${home} exceed the 2,000-character check limit, so whole-value checks were omitted; use a smaller check where supported.`,
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

/** The text a check of whether a file opens like XML reads, enough for a declaration and a DOCTYPE. */
const OPENING_CHARS = 2048;

/** The bounded opening used to recognize a text view of an XML document. */
const textOpening = (lines: readonly string[]): string => {
  let opening = "";
  for (const line of lines) {
    opening += `${line}\n`;
    if (opening.length > OPENING_CHARS) break;
  }
  return opening.trimStart();
};

/** Text views can preserve XML that the structured reader cannot admit. */
export const textOpensXml = (lines: readonly string[]): boolean =>
  opensLikeXml(textOpening(lines));

/**
 * A note on a text file that opens like XML, with a declaration, a DOCTYPE
 * or an element, and so reads as text only because it is not XML REA reads:
 * its DOCTYPE has an internal subset, which can declare entities, or it is
 * not well formed. Its checks compare lines, which hold attributes in the
 * order the app wrote them.
 */
export const readAsTextNotes = (
  file: string,
  lines: readonly string[],
): FileNote[] => {
  const opening = textOpening(lines);
  if (!opensLikeXml(opening)) return [];
  if (
    !doctypeHasInternalSubset(opening) &&
    isWellFormedXml(opening, { doctype: "external" })
  )
    return [];
  const why = doctypeHasInternalSubset(opening)
    ? "its DOCTYPE has an internal subset, which can declare entities"
    : "it is not well-formed XML";
  return [
    {
      code: "read_as_text",
      file,
      message: `~/${file} opens like XML but reads as text, since ${why}, so its checks compare lines, each holding its attributes in the order the app wrote them.`,
    },
  ];
};
