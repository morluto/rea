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

/** Facts substituted for the `%i`, `%c` and `%k` field codes. */
export interface DesktopExecContext {
  readonly icon: string | null;
  readonly name: string | null;
  readonly location: string | null;
}

const FILE_FIELD_CODES = new Set(["%f", "%F", "%u", "%U"]);

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
export type DesktopCommandWrapper =
  | { readonly kind: "direct"; readonly program: string }
  | { readonly kind: "flatpak"; readonly application_id: string | null };

/** Skip `env NAME=value` prefixes and recognise `flatpak run` launchers. */
export const unwrapDesktopCommand = (
  argv: readonly string[],
): DesktopCommandWrapper => {
  let index = 0;
  if (argv[index]?.split("/").at(-1) === "env") {
    index += 1;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(argv[index] ?? "")) index += 1;
  }
  const program = argv[index] ?? "";
  if (program.split("/").at(-1) === "flatpak" && argv[index + 1] === "run") {
    const application = argv
      .slice(index + 2)
      .find((token) => !token.startsWith("-") && !token.startsWith("@@"));
    return { kind: "flatpak", application_id: application ?? null };
  }
  return { kind: "direct", program };
};
