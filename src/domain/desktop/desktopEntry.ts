import { err, ok, type Result } from "../result.js";

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
}

const GROUP = /^\[(?<name>[^\]]+)\]$/u;
const ENTRY = /^(?<key>[A-Za-z0-9-]+)\s*=\s*(?<value>.*)$/u;
const VALUE_ESCAPES: Readonly<Record<string, string>> = {
  s: " ",
  n: "\n",
  t: "\t",
  r: "\r",
  "\\": "\\",
  ";": "\\;",
};

/** Undo the escapes the desktop entry format allows in string values. */
const unescapeValue = (value: string): string =>
  value.replace(
    /\\(.)/gu,
    (match, next: string) => VALUE_ESCAPES[next] ?? match,
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

const listValue = (value: string | undefined): readonly string[] =>
  value === undefined
    ? []
    : value
        .split(/(?<!\\);/u)
        .map((part) => part.replaceAll("\\;", ";"))
        .filter((part) => part.length > 0);

/** Read the main group of a freedesktop desktop entry, ignoring localized keys. */
export const parseDesktopEntry = (
  text: string,
): Result<DesktopEntry, "missing_desktop_entry_group"> => {
  const values = new Map<string, string>();
  let group: string | undefined;
  let found = false;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const header = GROUP.exec(line);
    if (header?.groups !== undefined) {
      group = header.groups.name;
      found ||= group === "Desktop Entry";
      continue;
    }
    const entry = ENTRY.exec(line);
    if (group !== "Desktop Entry" || entry?.groups === undefined) continue;
    const { key, value } = entry.groups;
    if (key !== undefined && value !== undefined && !values.has(key))
      values.set(key, unescapeValue(value));
  }
  if (!found) return err("missing_desktop_entry_group");
  const field = (key: string) => values.get(key) ?? null;
  return ok({
    type: field("Type"),
    name: field("Name"),
    exec: field("Exec"),
    try_exec: field("TryExec"),
    path: field("Path"),
    icon: field("Icon"),
    startup_wm_class: field("StartupWMClass"),
    categories: listValue(values.get("Categories")),
    mime_types: listValue(values.get("MimeType")),
    terminal: values.get("Terminal") === "true",
  });
};

const QUOTED_ESCAPES = new Set(['"', "`", "$", "\\"]);

/** Split an `Exec` value into arguments with the specification's quoting rules. */
export const tokenizeDesktopExec = (
  exec: string,
): Result<readonly string[], "unterminated_quote" | "empty_command"> => {
  const tokens: string[] = [];
  let current: string | undefined;
  let quoted = false;
  for (let index = 0; index < exec.length; index += 1) {
    const character = exec.charAt(index);
    if (quoted) {
      const next = exec.charAt(index + 1);
      if (character === "\\" && QUOTED_ESCAPES.has(next)) {
        current = `${current ?? ""}${next}`;
        index += 1;
      } else if (character === '"') quoted = false;
      else current = `${current ?? ""}${character}`;
    } else if (character === '"') {
      quoted = true;
      current ??= "";
    } else if (character === " " || character === "\t") {
      if (current !== undefined) tokens.push(current);
      current = undefined;
    } else current = `${current ?? ""}${character}`;
  }
  if (quoted) return err("unterminated_quote");
  if (current !== undefined) tokens.push(current);
  return tokens.length === 0 ? err("empty_command") : ok(tokens);
};

/** Reserved characters an unquoted `Exec` argument must not contain. */
const EXEC_RESERVED = /[\t\n\r "'\\><~|&;$*?#()`]/u;

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
        : `"${argument.replace(/[\\"`$]/gu, (character) => `\\${character}`)}"`,
    )
    .join(" ");

const EXEC_LINE = /^Exec\s*=/u;

/**
 * Replace the first `Exec` line of the main group, leaving other groups
 * alone. `exec` is the command `tokenizeDesktopExec` reads; it is escaped for
 * the desktop-entry value layer before it is written.
 */
export const replaceDesktopExec = (
  text: string,
  exec: string,
): Result<string, "missing_exec_line"> => {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  let group: string | undefined;
  let replaced = false;
  const lines = text.split(/\r?\n/u).map((line) => {
    const trimmed = line.trim();
    const header = GROUP.exec(trimmed);
    if (header?.groups?.name !== undefined) {
      group = header.groups.name;
      return line;
    }
    if (
      replaced ||
      group !== "Desktop Entry" ||
      trimmed.length === 0 ||
      trimmed.startsWith("#") ||
      !EXEC_LINE.test(trimmed)
    )
      return line;
    replaced = true;
    return `Exec=${escapeDesktopEntryValue(exec)}`;
  });
  return replaced ? ok(lines.join(newline)) : err("missing_exec_line");
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
  /** Variables an `env` prefix sets; its `PATH` is the one that finds the program. */
  readonly environment: Readonly<Record<string, string>>;
} & (
  | {
      readonly kind: "direct";
      /** The program's position in the command. */
      readonly index: number;
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
const flatpakApplicationId = (arguments_: readonly string[]): string | null => {
  for (let index = 0; index < arguments_.length; index += 1) {
    const token = arguments_[index] ?? "";
    if (token === "--") return arguments_[index + 1]?.split("/")[0] || null;
    if (!token.startsWith("-")) return token.split("/")[0] || null;
    if (FLATPAK_RUN_VALUE_OPTIONS.has(token)) index += 1;
  }
  return null;
};

/** Apply `env NAME=value` prefixes and recognise `flatpak run` launchers. */
export const unwrapDesktopCommand = (
  argv: readonly string[],
): DesktopCommandWrapper => {
  let index = 0;
  // No prototype, so an assignment such as `__proto__=x` stays a variable.
  const environment: Record<string, string> = Object.create(null);
  if (argv[0]?.split("/").at(-1) === "env") {
    index = 1;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(argv[index] ?? "")) {
      const assignment = argv[index] ?? "";
      const split = assignment.indexOf("=");
      environment[assignment.slice(0, split)] = assignment.slice(split + 1);
      index += 1;
    }
  }
  const program = argv[index] ?? "";
  if (program.split("/").at(-1) === "flatpak" && argv[index + 1] === "run")
    return {
      kind: "flatpak",
      program,
      environment,
      application_id: flatpakApplicationId(argv.slice(index + 2)),
    };
  return { kind: "direct", program, environment, index };
};

/** The first argument after an `env` prefix, the program, and a `flatpak run` id. */
export const desktopArgumentIndex = (argv: readonly string[]): number => {
  const command = unwrapDesktopCommand(argv);
  if (command.kind === "direct") return command.index + 1;
  let index = 0;
  if (argv[0]?.split("/").at(-1) === "env") {
    index = 1;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(argv[index] ?? "")) index += 1;
  }
  index += 1;
  if (argv[index] === "run") index += 1;
  for (; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") return Math.min(index + 2, argv.length);
    if (!token.startsWith("-")) return index + 1;
    if (FLATPAK_RUN_VALUE_OPTIONS.has(token)) index += 1;
  }
  return argv.length;
};
