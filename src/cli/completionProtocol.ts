import { z } from "zod";

import {
  declaredOptionType,
  isCountOption,
  optionFlagName,
} from "./optionFields.js";

/**
 * REA's shell completion protocol: the hook script each shell sources, the
 * candidates for the words before the cursor, and their per-shell encoding.
 * A hook calls back into the binary as `COMPLETE=<shell> rea -- <words>`.
 * Function names keep the `_incur_complete_` prefix so hooks that users
 * already installed keep working.
 */

/** Shells with a completion hook. */
export type CompletionShell = "bash" | "zsh" | "fish" | "nushell";

/** One node of the command tree that completion walks. */
export interface CompletionCommand {
  readonly description?: string | undefined;
  readonly options?: z.ZodObject | undefined;
  /** Short alias by option key, such as `{ yes: "y" }`. */
  readonly alias?: Readonly<Record<string, string>> | undefined;
  /** A group selects a nested command map instead of running. */
  readonly _group?: true | undefined;
  readonly commands?: ReadonlyMap<string, CompletionCommand> | undefined;
  /** A group's own options, used while the group is the active scope. */
  readonly root?: CompletionCommand | undefined;
  /** An alias entry names its canonical sibling in `target`. */
  readonly _alias?: true | undefined;
  readonly target?: string | undefined;
}

/** Options that apply to every command in the active scope. */
export interface CompletionGlobals {
  readonly schema: z.ZodObject;
  readonly alias?: Readonly<Record<string, string>> | undefined;
}

export interface CompletionCandidate {
  readonly value: string;
  readonly description?: string | undefined;
  /** A group keeps the cursor on the word so a subcommand can follow. */
  readonly noSpace?: true | undefined;
}

// Bash can place operators next to words without a space.
const BASH_OPERATOR = /^[&();<>|]/u;

/** Reassemble Bash completion fragments at their boundaries in the raw line. */
export const bashCompletionInput = (
  words: readonly string[],
  index: number,
  line: string,
  fragment: string,
) => {
  const assembled: string[] = [];
  let end = 0;
  let replacementPrefix = "";
  for (let position = 0; position <= index; position += 1) {
    const atCursor = position === index;
    const word = atCursor
      ? line.slice(end).replace(/^[ \t\n]+/u, "")
      : words[position]!;
    const start = atCursor
      ? line.length - word.length
      : line.indexOf(word, end);
    if (start < end) return undefined;
    const previous = assembled.at(-1);
    // At a word break, the Readline fragment can still precede COMP_CWORD.
    const cursorBeforeWordBreak = atCursor && word === "" && fragment !== "";
    if (
      start === end &&
      !cursorBeforeWordBreak &&
      previous !== undefined &&
      !BASH_OPERATOR.test(words[position - 1]!) &&
      !BASH_OPERATOR.test(word)
    ) {
      const joined = previous + word;
      assembled[assembled.length - 1] = joined;
      // Readline keeps the portion of the shell word outside its fragment.
      if (atCursor && joined.endsWith(fragment))
        replacementPrefix = joined.slice(0, joined.length - fragment.length);
    } else {
      // For an unsplit word, Bash includes any text beyond the cursor.
      assembled.push(atCursor ? (words[position] ?? word) : word);
    }
    end = start + word.length;
  }
  const current = assembled.pop() ?? "";
  return {
    before: assembled.slice(1),
    current,
    replacementPrefix,
  };
};

const identifier = (name: string): string =>
  name.replace(/[^a-zA-Z0-9_]/gu, "_");

/** Register the dynamic Bash protocol, including macOS system Bash 3.2. */
export const bashCompletionScript = (name: string): string => {
  const id = identifier(name);
  const command = `'${name.replaceAll("'", "'\\''")}'`;
  return `_incur_complete_${id}() {
    local IFS=$'\\013'
    local _COMPLETE_INDEX=\${COMP_CWORD}
    local _line=\${COMP_LINE-}
    local _completions _output
    if ! _output=$(
        export COMPLETE="bash"
        export _COMPLETE_INDEX="$_COMPLETE_INDEX"
        export _COMPLETE_BASH_LINE="\${_line:0:\${COMP_POINT:-0}}"
        export _COMPLETE_BASH_FRAGMENT="\${2-}"
        ${command} -- "\${COMP_WORDS[@]}"
    ); then
        unset COMPREPLY
        return
    fi
    # Split the protocol records without expanding pathname patterns.
    read -r -d '' -a _completions < <(printf '%s\\0' "$_output")
    local _nospace=false
    local _nospace_marker=$'\\001'
    local _c
    COMPREPLY=()
    for _c in "\${_completions[@]}"; do
        if [[ "$_c" == *"$_nospace_marker" ]]; then
            _nospace=true
            COMPREPLY+=("\${_c%"$_nospace_marker"}")
        else
            COMPREPLY+=("$_c")
        fi
    done
    if [[ $_nospace == true ]] && type compopt >/dev/null 2>&1; then
        compopt -o nospace
    fi
    return 0
}
complete -o default -o bashdefault -o nosort -F _incur_complete_${id} ${command} 2>/dev/null ||
    complete -o default -o bashdefault -F _incur_complete_${id} ${command}`;
};

const zshCompletionScript = (name: string): string => {
  const id = identifier(name);
  return `#compdef ${name}
_incur_complete_${id}() {
    local completions=("\${(@f)$(
        export _COMPLETE_INDEX=$(( CURRENT - 1 ))
        export COMPLETE="zsh"
        "${name}" -- "\${words[@]}" 2>/dev/null
    )}")
    if [[ -n $completions ]]; then
        _describe 'values' completions -S ''
    fi
}
compdef _incur_complete_${id} ${name}`;
};

const fishCompletionScript = (name: string): string =>
  `complete --keep-order --exclusive --command ${name} \\
    --arguments "(COMPLETE=fish ${name} -- (commandline --current-process --tokenize --cut-at-cursor) (commandline --current-token))"`;

const nushellCompletionScript = (name: string): string => {
  const id = identifier(name);
  return `# External completer for ${name}
# Add to $env.config.completions.external.completer or use in a dispatch completer.
let _incur_complete_${id} = {|spans|
    COMPLETE=nushell ${name} -- ...$spans | from json
}`;
};

/** The hook script a shell evaluates to register completion for `name`. */
export const completionScript = (
  shell: CompletionShell,
  name: string,
): string => {
  switch (shell) {
    case "bash":
      return bashCompletionScript(name);
    case "zsh":
      return zshCompletionScript(name);
    case "fish":
      return fishCompletionScript(name);
    case "nushell":
      return nushellCompletionScript(name);
  }
};

const isFlagOption = (field: z.ZodType): boolean =>
  isCountOption(field) || declaredOptionType(field) instanceof z.ZodBoolean;

const enumValues = (field: z.ZodType): readonly string[] | undefined => {
  const type = declaredOptionType(field);
  return type instanceof z.ZodEnum
    ? type.options.map((value) => String(value))
    : undefined;
};

/** Resolve `--foo-bar`, `--fooBar` or a short alias to its option key. */
const optionKey = (
  token: string,
  options: z.ZodObject,
  alias: Readonly<Record<string, string>> | undefined,
): string | undefined => {
  const keys = Object.keys(options.shape);
  if (token.startsWith("--")) {
    const raw = token.slice(2);
    return (
      keys.find((key) => optionFlagName(key) === raw) ??
      (keys.includes(raw) ? raw : undefined)
    );
  }
  if (token.length === 2 && alias !== undefined)
    return Object.entries(alias).find(([, short]) => short === token[1])?.[0];
  return undefined;
};

const flagCandidates = (
  current: string,
  options: z.ZodObject,
  alias: Readonly<Record<string, string>> | undefined,
  candidates: CompletionCandidate[],
): void => {
  const shape = options.shape as Record<string, z.ZodType>;
  const add = (value: string, key: string) => {
    if (
      value.startsWith(current) &&
      !candidates.some((candidate) => candidate.value === value)
    )
      candidates.push({ value, description: shape[key]?.description });
  };
  for (const key of Object.keys(shape)) add(`--${optionFlagName(key)}`, key);
  for (const [key, short] of Object.entries(alias ?? {})) add(`-${short}`, key);
};

/**
 * Value candidates for a separate or inline option. `undefined` means the
 * option does not take a value in this scope; an empty list means it takes a
 * free-form value or its enum has no matching values.
 */
const valueCandidates = (
  option: string,
  current: string,
  options: z.ZodObject,
  alias: Readonly<Record<string, string>> | undefined,
): CompletionCandidate[] | undefined => {
  const key = optionKey(option, options, alias);
  if (key === undefined) return undefined;
  const field = (options.shape as Record<string, z.ZodType>)[key]!;
  const values = enumValues(field);
  if (values !== undefined)
    return values
      .filter((value) => value.startsWith(current))
      .map((value) => ({ value }));
  return isFlagOption(field) ? undefined : [];
};

const expectsCommandValue = (
  words: readonly string[],
  options: z.ZodObject,
  alias: Readonly<Record<string, string>> | undefined,
): boolean => {
  const shape = options.shape as Record<string, z.ZodType>;
  let pending = false;
  for (const word of words) {
    if (pending || !word.startsWith("-") || word.startsWith("--no-")) {
      pending = false;
      continue;
    }
    const flag = word.startsWith("--") ? word : `-${word.slice(-1)}`;
    const key = optionKey(flag, options, alias);
    pending = key !== undefined && !isFlagOption(shape[key]!);
  }
  return pending;
};

/**
 * Candidates for `words[index]`. Earlier words select the command scope;
 * a separated or inline value lists enum values, a dash-prefixed word lists
 * options, and otherwise subcommands are listed in registration order.
 */
export const completeWords = (
  commands: ReadonlyMap<string, CompletionCommand>,
  words: readonly string[],
  index: number,
  globals: CompletionGlobals,
): CompletionCandidate[] => {
  const current = words[index] ?? "";
  let scope: {
    commands: ReadonlyMap<string, CompletionCommand>;
    leaf: CompletionCommand | undefined;
  } = { commands, leaf: undefined };
  const precedingWords = words.slice(0, index);
  for (const token of precedingWords) {
    if (token.startsWith("-")) continue;
    let entry = scope.commands.get(token);
    if (entry?._alias === true && entry.target !== undefined)
      entry = scope.commands.get(entry.target);
    if (entry === undefined) continue;
    if (entry._group === true && entry.commands !== undefined)
      scope = { commands: entry.commands, leaf: entry.root };
    else {
      scope = { commands: new Map(), leaf: entry };
      break;
    }
  }
  const { leaf } = scope;
  const equals = current.startsWith("--") ? current.indexOf("=") : -1;
  const previous = index > 0 ? words[index - 1]! : "";
  if (equals >= 0 || (!current.startsWith("-") && previous.startsWith("-"))) {
    const option = equals >= 0 ? current.slice(0, equals) : previous;
    const prefix = equals >= 0 ? current.slice(equals + 1) : current;
    if (
      equals >= 0 &&
      leaf?.options !== undefined &&
      optionKey(option, globals.schema, globals.alias) === undefined &&
      expectsCommandValue(precedingWords, leaf.options, leaf.alias)
    )
      return [];
    const values =
      (leaf?.options === undefined
        ? undefined
        : valueCandidates(option, prefix, leaf.options, leaf.alias)) ??
      valueCandidates(option, prefix, globals.schema, globals.alias);
    if (equals >= 0)
      return (values ?? []).map(({ value }) => ({
        value: `${option}=${value}`,
      }));
    if (values !== undefined) return values;
  }
  const candidates: CompletionCandidate[] = [];
  if (current.startsWith("-")) {
    if (leaf?.options !== undefined)
      flagCandidates(current, leaf.options, leaf.alias, candidates);
    flagCandidates(current, globals.schema, globals.alias, candidates);
    return candidates;
  }
  for (const [name, entry] of scope.commands)
    if (entry._alias !== true && name.startsWith(current))
      candidates.push({
        value: name,
        description: entry.description,
        ...(entry._group === true ? { noSpace: true as const } : {}),
      });
  return candidates;
};

/**
 * Encode candidates for one shell: bash `\v`-separated values (a group ends
 * with `\x01`), zsh `value:description` lines (`:` escaped in values), fish
 * `value\tdescription` lines, nushell a JSON array of records.
 */
export const formatCompletions = (
  shell: CompletionShell,
  candidates: readonly CompletionCandidate[],
): string => {
  switch (shell) {
    case "bash":
      return candidates
        .map(({ value, noSpace }) => (noSpace ? `${value}\x01` : value))
        .join("\v");
    case "zsh":
      return candidates
        .map(({ value, description }) => {
          const escaped = value.replaceAll(":", "\\:");
          return description ? `${escaped}:${description}` : escaped;
        })
        .join("\n");
    case "fish":
      return candidates
        .map(({ value, description }) =>
          description ? `${value}\t${description}` : value,
        )
        .join("\n");
    case "nushell":
      return JSON.stringify(
        candidates.map(({ value, description }) =>
          description ? { value, description } : { value },
        ),
      );
  }
};
