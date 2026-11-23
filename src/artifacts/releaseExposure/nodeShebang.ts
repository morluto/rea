import { basename } from "node:path";

/**
 * Whether a script prefix begins with a shebang invoking `node` / `nodejs`.
 * When `env -S` expands a `${NAME}` inside the resolved program name, the
 * interpreter is unresolved so it returns `undefined` rather than `false`.
 */
export const nodeShebang = (prefix: Buffer): boolean | undefined => {
  if (prefix.toString("latin1", 0, 2) !== "#!") return false;
  const [line = ""] = prefix.toString("latin1", 2).split("\n", 1);
  const [, interpreter = "", operands = ""] =
    /^(\S*)[ \t]*(.*)$/su.exec(line.trim()) ?? [];
  const program =
    basename(interpreter) === "env"
      ? envProgram(operands)
      : { text: interpreter, expands: false };
  if (program === undefined) return false;
  const name = basename(program.text);
  if (/^node(?:js)?$/u.test(name)) return true;
  return program.expands && name.includes("${") ? undefined : false;
};

/** One `env` field, and whether `env -S` expands a `${NAME}` inside it. */
interface EnvField {
  readonly text: string;
  readonly expands: boolean;
}

/** `env` options whose argument is the next field, as in `-u NODE_OPTIONS`. */
const ENV_OPTION_WITH_ARGUMENT = new Set([
  "-u",
  "--unset",
  "-C",
  "--chdir",
  "-P",
]);

/**
 * The program an `env` shebang runs: the first field that is neither an
 * option, an option's argument, nor a `NAME=value` setting. `-S` takes the
 * rest of the line as one string and splits it as `env` does, so quoted
 * spaces stay inside their field.
 */
const envProgram = (operands: string): EnvField | undefined => {
  const fields: EnvField[] = [];
  let rest = operands;
  const next = (): EnvField | undefined => {
    if (fields.length > 0) return fields.shift();
    const [, field, after = ""] = /^[ \t]*([^ \t]+)(.*)$/su.exec(rest) ?? [];
    rest = after;
    return field === undefined ? undefined : { text: field, expands: false };
  };
  for (let entry = next(); entry !== undefined; entry = next()) {
    const field = entry.text;
    // Past `--` nothing is an option, but settings still come first.
    if (field === "--") {
      for (let word = next(); word !== undefined; word = next())
        if (!word.text.includes("=")) return word;
      return undefined;
    }
    if (ENV_OPTION_WITH_ARGUMENT.has(field)) {
      next();
      continue;
    }
    const attached =
      /^-[0iv]*S(.*)$/su.exec(field)?.[1] ??
      (field.startsWith("--split-string=")
        ? field.slice("--split-string=".length)
        : undefined);
    if (attached !== undefined) {
      // The kernel passes the whole line as one operand, so an `-S` read from
      // the line itself owns everything after it, separators included.
      const fromLine = fields.length === 0;
      const words = splitEnvString(fromLine ? attached + rest : attached);
      if (words === undefined) return undefined;
      if (fromLine) rest = "";
      fields.unshift(...words);
      continue;
    }
    if (field.startsWith("-") || field.includes("=")) continue;
    return entry;
  }
  return undefined;
};

/** Escapes `env -S` accepts outside single quotes, as GNU coreutils reads them. */
const ENV_SPLIT_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\",
  "'": "'",
  '"': '"',
  "#": "#",
  $: "$",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

/**
 * Split an `env -S` string on its unquoted spaces and tabs. Single quotes keep
 * text literally but for `\\` and `\'`; double quotes and bare text take the
 * escapes above, `\_` separates fields outside quotes and is a space inside
 * them, `\c` ends the string, and a `#` that starts a field begins a comment.
 * `${NAME}` stays as written: it can only change a value, never which field is
 * the program, so its field is marked as expanding. A string `env` itself
 * rejects, such as an unterminated quote or an unknown escape, runs nothing.
 */
const splitEnvString = (text: string): EnvField[] | undefined => {
  const fields: EnvField[] = [];
  let field: string | null = null;
  let expands = false;
  let quote: "'" | '"' | null = null;
  const end = (): void => {
    if (field !== null) fields.push({ text: field, expands });
    field = null;
    expands = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (quote === "'") {
      const escaped = text[index + 1];
      if (character === "'") quote = null;
      else if (character === "\\" && (escaped === "\\" || escaped === "'")) {
        field += escaped;
        index += 1;
      } else field += character;
      continue;
    }
    if (character === "\\") {
      const escaped = text[index + 1];
      index += 1;
      if (escaped === "c") {
        if (quote !== null) return undefined;
        break;
      }
      if (escaped === "_") {
        if (quote === null) end();
        else field += " ";
        continue;
      }
      const value =
        escaped === undefined ? undefined : ENV_SPLIT_ESCAPES[escaped];
      if (value === undefined) return undefined;
      field = (field ?? "") + value;
      continue;
    }
    if (character === "$" && text[index + 1] === "{") expands = true;
    if (quote === '"') {
      if (character === '"') quote = null;
      else field += character;
      continue;
    }
    if (character === " " || character === "\t") end();
    else if (character === "#" && field === null) break;
    else if (character === "'" || character === '"') {
      quote = character;
      field ??= "";
    } else field = (field ?? "") + character;
  }
  if (quote !== null) return undefined;
  end();
  return fields;
};
