import { err, ok, type Result } from "../result.js";
import {
  DESKTOP_ENTRY_GROUP,
  DESKTOP_GROUP,
  DESKTOP_KEY,
  DESKTOP_KEY_SEPARATOR,
  DESKTOP_VALUE_ESCAPE,
  DESKTOP_VALUE_ESCAPES,
  ENV_PREFIX,
  ENV_UNSET_NAME,
  ENV_WRAPPER,
  EXEC_LEXEME,
  QUOTABLE,
  QUOTED_ESCAPE,
} from "./desktopLaunchSyntax.js";
import { DESKTOP_LINE_BREAK } from "./desktopTextSyntax.js";

/** The unlocalized `[Desktop Entry]` keys a desktop capture uses. */
export interface DesktopEntry {
  readonly type: string | null;
  readonly name: string | null;
  readonly exec: string | null;
  readonly try_exec: string | null;
  readonly path: string | null;
  readonly icon: string | null;
  readonly startup_wm_class: string | null;
  readonly categories: readonly string[];
  readonly mime_types: readonly string[];
  readonly terminal: boolean;
  readonly hidden: boolean;
  /** First malformed source line ignored by tolerant field inspection. */
  readonly malformed_line?: number;
}

// Capture tolerant padding separately so it stays available for validation.
const GROUP = new RegExp(String.raw`^(\s*)${DESKTOP_GROUP}(\s*)$`, "u");
const GLIB_GROUP_LEADING_SPACE = /^[ \t\f\r]*$/u;
const GLIB_GROUP_TRAILING_SPACE = /^[ \t]*$/u;
const INVALID_GROUP_NAME_CHARACTER = /[[\]\u0000-\u001f\u007f]/u;
const LINE_WITH_SEPARATOR = new RegExp(`(${DESKTOP_LINE_BREAK})`, "u");
// Only LF separates records; Unicode line/paragraph separators are value data.
const ENTRY = new RegExp(
  `^(?<key>${DESKTOP_KEY})(?<locale>\\[[A-Za-z0-9_.@-]+\\])?${DESKTOP_KEY_SEPARATOR}(?<value>.*)$`,
  "su",
);
const valueEscape = new RegExp(DESKTOP_VALUE_ESCAPE, "gu");
// Freedesktop Desktop Entry Specification: boolean values may be true/false or 1/0
// (case-insensitive). GLib strips its ASCII whitespace from the raw boolean.
const BOOLEAN_TRUE = /^[ \t\f\r]*(?:true|1)[ \t\f\r]*$/iu;

/** Undo the escapes the desktop entry format allows in string values. */
const unescapeValue = (value: string): string =>
  value.replace(
    valueEscape,
    (match, next: string) => DESKTOP_VALUE_ESCAPES[next] ?? match,
  );

/**
 * Escape a string for a desktop-entry value. This is the inverse of the
 * escapes `parseDesktopEntry` removes, and the same rules GLib uses when it
 * writes a string: `\\`, `\n`, `\r`, a leading `\s` or `\t`. A backslash that
 * is only command-quoted would otherwise be eaten before `Exec` is tokenized,
 * and `gio launch` rejects the resulting entry.
 */
export const escapeDesktopEntryValue = (value: string): string => {
  let escaped = "";
  let leading = true;
  for (const character of value) {
    switch (character) {
      case " ":
        escaped += leading ? "\\s" : " ";
        break;
      case "\t":
        escaped += leading ? "\\t" : "\t";
        break;
      case "\n":
        escaped += "\\n";
        break;
      case "\r":
        escaped += "\\r";
        break;
      case "\\":
        escaped += "\\\\";
        leading = false;
        break;
      default:
        escaped += character;
        leading = false;
        break;
    }
  }
  return escaped;
};

/** Decode list separators and escapes together, before either loses its meaning. */
const listValue = (value: string | undefined): readonly string[] => {
  if (value === undefined) return [];
  const entries: string[] = [];
  let entry = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    const next = value.charAt(index + 1);
    if (character === "\\" && next.length > 0) {
      entry +=
        next === ";" ? ";" : (DESKTOP_VALUE_ESCAPES[next] ?? `\\${next}`);
      index += 1;
    } else if (character === ";") {
      entries.push(entry);
      entry = "";
    } else entry += character;
  }
  if (entry.length > 0) entries.push(entry);
  return entries;
};

/** GLib merges repeated groups and gives the last occurrence of a key precedence. */
const readDesktopEntryFields = (text: string) => {
  const parts = text.split(LINE_WITH_SEPARATOR);
  const fields = new Map<
    string,
    { readonly value: string; readonly part: number }
  >();
  let group: string | undefined;
  let found = false;
  let malformedLine: number | undefined;
  for (let index = 0; index < parts.length; index += 2) {
    const raw = parts[index]!;
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const [, leading = "", header, trailing = ""] = GROUP.exec(raw) ?? [];
    if (header !== undefined) {
      if (
        (group === undefined && header !== DESKTOP_ENTRY_GROUP) ||
        INVALID_GROUP_NAME_CHARACTER.test(header) ||
        !GLIB_GROUP_LEADING_SPACE.test(leading) ||
        !GLIB_GROUP_TRAILING_SPACE.test(trailing)
      )
        malformedLine ??= index / 2 + 1;
      // Preserve the group boundary for tolerant field and rewrite consumers.
      group = header;
      found ||= group === DESKTOP_ENTRY_GROUP;
      continue;
    }
    // Full-line trimming is syntax-only: string-value suffixes are data.
    const entry = ENTRY.exec(raw.trimStart());
    if (group === undefined || entry?.groups === undefined) {
      malformedLine ??= index / 2 + 1;
      continue;
    }
    if (group !== DESKTOP_ENTRY_GROUP || entry.groups.locale !== undefined)
      continue;
    const { key, value } = entry.groups;
    if (key !== undefined && value !== undefined)
      fields.set(key, {
        value: key === "Type" ? value.trimEnd() : value,
        part: index,
      });
  }
  return { parts, fields, found, malformedLine };
};

/** Read the effective main-group keys, ignoring localized keys and action groups. */
export const parseDesktopEntry = (
  text: string,
): Result<DesktopEntry, "missing_desktop_entry_group"> => {
  const { fields, found, malformedLine } = readDesktopEntryFields(text);
  if (!found) return err("missing_desktop_entry_group");
  const rawField = (key: string) => fields.get(key)?.value;
  const field = (key: string) => {
    const value = rawField(key);
    return value === undefined ? null : unescapeValue(value);
  };
  return ok({
    type: field("Type"),
    name: field("Name"),
    exec: field("Exec"),
    try_exec: field("TryExec"),
    path: field("Path"),
    icon: field("Icon"),
    startup_wm_class: field("StartupWMClass"),
    categories: listValue(rawField("Categories")),
    mime_types: listValue(rawField("MimeType")),
    terminal: BOOLEAN_TRUE.test(rawField("Terminal") ?? ""),
    hidden: BOOLEAN_TRUE.test(rawField("Hidden") ?? ""),
    ...(malformedLine === undefined ? {} : { malformed_line: malformedLine }),
  });
};

const execLexeme = new RegExp(EXEC_LEXEME, "uy");
const quotedEscape = new RegExp(QUOTED_ESCAPE, "gu");

/** Split an `Exec` value into arguments with the specification's quoting rules. */
export const tokenizeDesktopExec = (
  exec: string,
): Result<readonly string[], "unterminated_quote" | "empty_command"> => {
  const tokens: string[] = [];
  let current: string | undefined;
  execLexeme.lastIndex = 0;
  while (execLexeme.lastIndex < exec.length) {
    const part = execLexeme.exec(exec);
    if (part === null) return err("unterminated_quote");
    const [, quoted, unquoted, separator] = part;
    if (separator !== undefined) {
      if (current !== undefined) tokens.push(current);
      current = undefined;
    } else
      current =
        (current ?? "") + (quoted?.replace(quotedEscape, "$1") ?? unquoted!);
  }
  if (current !== undefined) tokens.push(current);
  return tokens.length === 0 ? err("empty_command") : ok(tokens);
};

/** Reserved characters an unquoted `Exec` argument must not contain. */
const EXEC_RESERVED = /[\t\n\r "'\\><~|&;$*?#()`]/u;
const quotable = new RegExp(QUOTABLE, "gu");

/**
 * Quote `Exec` arguments so `tokenizeDesktopExec` reads them back. The
 * desktop-entry value escapes around that command are applied when the line
 * is written.
 */
export const formatDesktopExec = (argv: readonly string[]): string =>
  argv
    .map((argument) =>
      argument.length > 0 && !EXEC_RESERVED.test(argument)
        ? argument
        : `"${argument.replace(quotable, (character) => `\\${character}`)}"`,
    )
    .join(" ");

/**
 * Replace the effective main-group `Exec`, using the same record owner as
 * parsing. Overridden keys and action groups stay unchanged. `exec` is escaped
 * for the desktop-entry value layer before it is written.
 */
export const replaceDesktopExec = (
  text: string,
  exec: string,
): Result<string, "missing_exec_line"> => {
  const { parts, fields } = readDesktopEntryFields(text);
  const execField = fields.get("Exec");
  if (execField === undefined) return err("missing_exec_line");
  parts[execField.part] = `Exec=${escapeDesktopEntryValue(exec)}`;
  return ok(parts.join(""));
};

/** Facts substituted for the `%i`, `%c` and `%k` field codes. */
export interface DesktopExecContext {
  readonly icon: string | null;
  readonly name: string | null;
  readonly location: string | null;
}

const FILE_FIELD_CODES = new Set(["%f", "%F", "%u", "%U"]);

/** Whether an `Exec` value takes files: it holds a `%f`, `%F`, `%u` or `%U` field code. */
export const execTakesFiles = (exec: string): boolean => {
  const tokens = tokenizeDesktopExec(exec);
  return tokens.ok && tokens.value.some((token) => FILE_FIELD_CODES.has(token));
};

/**
 * Expand field codes for a launch with no files, then append caller arguments.
 * File and URL codes are dropped, so the caller's arguments take their place.
 */
export const expandDesktopExec = (
  tokens: readonly string[],
  context: DesktopExecContext,
  arguments_: readonly string[],
): readonly string[] => {
  const expanded: string[] = [];
  for (const token of tokens) {
    if (FILE_FIELD_CODES.has(token)) continue;
    if (token === "%i") {
      if (context.icon !== null) expanded.push("--icon", context.icon);
      continue;
    }
    expanded.push(
      token.replace(/%(.)/gu, (match, code: string) => {
        if (code === "%") return "%";
        if (code === "c") return context.name ?? "";
        if (code === "k") return context.location ?? "";
        return /[fFuUidDnNvm]/u.test(code) ? "" : match;
      }),
    );
  }
  return [...expanded, ...arguments_];
};

/** How an expanded command reaches the application binary. */
export type DesktopCommandWrapper = {
  /** The program `env` runs, or the first argument when there is no `env`. */
  readonly program: string;
  /** The program's position in the expanded command, after any env operands. */
  readonly index: number;
  /** Variables an `env` prefix sets; its `PATH` is the one that finds the program. */
  readonly environment: Readonly<Record<string, string>>;
  /** Present when the env wrapper discards all inherited variables. */
  readonly clearEnvironment?: true;
  /** Variables env removes from the inherited environment before assignments. */
  readonly unsetEnvironment?: readonly string[];
  /** A malformed unset name is ignored by GNU env only for a clean launch. */
  readonly invalidUnset?: true;
  /** The last env chdir option and the argv span that carries its operand. */
  readonly chdir?: {
    readonly path: string;
    readonly start: number;
    readonly end: number;
    /** This option also requests a clean environment, as in `-iC`. */
    readonly includesClearEnvironment?: true;
  };
  /** First argument of the application, after the program or flatpak's app id. */
  readonly argumentIndex: number;
} & (
  | {
      readonly kind: "direct";
    }
  | { readonly kind: "flatpak"; readonly application_id: string | null }
);

/**
 * `flatpak run` options that take a value. GOption also accepts the value as
 * the next argument (`--branch stable`), so it must be skipped with its option.
 */
const FLATPAK_RUN_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--arch",
  "--command",
  "--cwd",
  "--branch",
  "--runtime",
  "--runtime-version",
  "--commit",
  "--runtime-commit",
  "--parent-pid",
  "--instance-id-fd",
  "--app-path",
  "--usr-path",
  "--installation",
  // Sandbox permissions, shared with `flatpak override`.
  "--share",
  "--unshare",
  "--socket",
  "--nosocket",
  "--device",
  "--nodevice",
  "--allow",
  "--disallow",
  "--filesystem",
  "--nofilesystem",
  "--env",
  "--env-fd",
  "--unset-env",
  "--own-name",
  "--talk-name",
  "--no-talk-name",
  "--system-own-name",
  "--system-talk-name",
  "--system-no-talk-name",
  "--add-policy",
  "--remove-policy",
  "--persist",
  "--usb",
  "--nousb",
  "--usb-list",
  "--usb-list-file",
]);

/**
 * The application id a `flatpak run` argument list names: its first operand,
 * after options and their values, without a `/arch/branch` ref suffix.
 */
const flatpakApplication = (argv: readonly string[], start: number) => {
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--")
      return {
        application_id: argv[index + 1]?.split("/")[0] || null,
        argumentIndex: Math.min(index + 2, argv.length),
      };
    if (!token.startsWith("-"))
      return {
        application_id: token.split("/")[0] || null,
        argumentIndex: index + 1,
      };
    if (FLATPAK_RUN_VALUE_OPTIONS.has(token)) index += 1;
  }
  return { application_id: null, argumentIndex: argv.length };
};

const envUnsetName = new RegExp(`^(?:${ENV_UNSET_NAME})$`, "u");
const envWrapper = new RegExp(`^${ENV_WRAPPER}$`, "u");
const envPhases = ENV_PREFIX.map(({ repeat, rules }) => ({
  repeat,
  rules: rules.map((rule) => ({
    rule,
    pattern: new RegExp(`^(?:${rule.pattern})$`, "u"),
  })),
}));

const envMatch = (phase: (typeof envPhases)[number], token: string) => {
  for (const { rule, pattern } of phase.rules) {
    const captures = pattern.exec(token);
    if (captures !== null) return { rule, captures };
  }
  return undefined;
};

const desktopEnvironment = (argv: readonly string[]) => {
  let index = 1;
  let clearEnvironment = false;
  let chdir: DesktopCommandWrapper["chdir"];
  const unsetEnvironment: string[] = [];
  // No prototype, so an assignment such as `__proto__=x` stays a variable.
  const environment: Record<string, string> = Object.create(null);
  for (const phase of envPhases) {
    while (index < argv.length) {
      const token = argv[index]!;
      const match = envMatch(phase, token);
      if (match === undefined) break;
      const { rule, captures } = match;
      const start = index;
      index += 1;
      if (rule.kind === "clear") clearEnvironment = true;
      if (rule.kind === "assignment") {
        const split = token.indexOf("=");
        environment[token.slice(0, split)] = token.slice(split + 1);
      }
      if (rule.kind === "chdir" || rule.kind === "unset") {
        const attached =
          rule.operand === undefined ? undefined : captures[rule.operand];
        const separate = attached === undefined;
        const value = separate ? (argv[index] ?? "") : attached;
        if (separate) index += 1;
        const combined =
          rule.clear !== undefined && Boolean(captures[rule.clear]);
        clearEnvironment ||= combined;
        if (rule.kind === "unset") unsetEnvironment.push(value);
        else
          chdir = {
            path: value,
            start,
            end: index,
            ...(combined ? { includesClearEnvironment: true as const } : {}),
          };
      }
      if (!phase.repeat) break;
    }
  }
  return { index, chdir, clearEnvironment, environment, unsetEnvironment };
};

/** Apply env prefixes and recognise flatpak run launchers. */
export const unwrapDesktopCommand = (
  argv: readonly string[],
): DesktopCommandWrapper => {
  const { index, chdir, clearEnvironment, environment, unsetEnvironment } =
    envWrapper.test(argv[0] ?? "")
      ? desktopEnvironment(argv)
      : {
          index: 0,
          chdir: undefined,
          clearEnvironment: false,
          unsetEnvironment: [],
          environment: Object.create(null) as Record<string, string>,
        };
  const program = argv[index] ?? "";
  const wrapperOptions = {
    ...(chdir === undefined ? {} : { chdir }),
    ...(clearEnvironment ? { clearEnvironment: true as const } : {}),
    ...(unsetEnvironment.length === 0 ? {} : { unsetEnvironment }),
    ...(!clearEnvironment &&
    unsetEnvironment.some((name) => !envUnsetName.test(name))
      ? { invalidUnset: true as const }
      : {}),
  };
  if (program.split("/").at(-1) === "flatpak" && argv[index + 1] === "run")
    return {
      kind: "flatpak",
      program,
      index,
      environment,
      ...flatpakApplication(argv, index + 2),
      ...wrapperOptions,
    };
  return {
    kind: "direct",
    program,
    environment,
    index,
    argumentIndex: index + 1,
    ...wrapperOptions,
  };
};
