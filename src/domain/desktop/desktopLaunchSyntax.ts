/** Shared lexical and prefix rules for the host reader and offline installer. */
export const DESKTOP_VALUE_ESCAPES: Readonly<Record<string, string>> = {
  s: " ",
  n: "\n",
  t: "\t",
  r: "\r",
  "\\": "\\",
};

// Keep each match's raw span available to consumers that rewrite a token.
const escapeKeys = Object.keys(DESKTOP_VALUE_ESCAPES)
  .join("")
  .replaceAll("\\", "\\\\");
export const DESKTOP_VALUE_ESCAPE = String.raw`\\([${escapeKeys}])`;
export const DESKTOP_KEY = String.raw`[A-Za-z0-9-]+`;
export const DESKTOP_KEY_SEPARATOR = String.raw`[ \t]*=[ \t]*`;

export const QUOTABLE = String.raw`["\x60$\\]`;
export const QUOTED_ESCAPE = String.raw`\\(${QUOTABLE})`;
// The two backslash alternatives are disjoint: an escaped quotation mark
// cannot backtrack into a closing delimiter.
const QUOTED_PART = String.raw`"((?:\\${QUOTABLE}|\\(?!${QUOTABLE})|[^"\\])*)"`;
export const EXEC_LEXEME = String.raw`${QUOTED_PART}|([^" \t]+)|([ \t]+)`;

export type EnvRule =
  | {
      readonly kind: "clear" | "separator" | "assignment";
      readonly pattern: string;
    }
  | {
      readonly kind: "chdir" | "unset";
      readonly pattern: string;
      readonly operand?: number;
      readonly clear?: number;
    };

/** Unsetting a variable accepts any nonempty name without NUL or equals. */
export const ENV_UNSET_NAME = String.raw`[^=\x00]+`;

const envOperandRules = (
  kind: "chdir" | "unset",
  shortOption: "C" | "u",
): readonly EnvRule[] => [
  { kind, pattern: `--${kind}` },
  { kind, pattern: String.raw`--${kind}=([\s\S]*)`, operand: 1 },
  {
    kind,
    pattern: String.raw`-(i*)${shortOption}([\s\S]+)?`,
    operand: 2,
    clear: 1,
  },
];

/** An env launcher may be bare or identified by a path ending in /env. */
export const ENV_WRAPPER = String.raw`(?:[\s\S]*/)?env`;
// A failed match advances to the next phase. After assignments begin, an
// option-looking operand is a program token.
export const ENV_PREFIX: readonly {
  readonly repeat: boolean;
  readonly rules: readonly EnvRule[];
}[] = [
  {
    repeat: true,
    rules: [
      { kind: "clear", pattern: "-i+|--ignore-environment" },
      ...envOperandRules("chdir", "C"),
      ...envOperandRules("unset", "u"),
    ],
  },
  { repeat: false, rules: [{ kind: "separator", pattern: "--" }] },
  { repeat: false, rules: [{ kind: "clear", pattern: "-" }] },
  {
    repeat: true,
    rules: [
      {
        kind: "assignment",
        pattern: String.raw`[A-Za-z_][A-Za-z0-9_]*=[\s\S]*`,
      },
    ],
  },
];
