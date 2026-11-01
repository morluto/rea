/** Global output flags that take a value. */
export const VALUED_OUTPUT_FLAGS: ReadonlySet<string> = new Set([
  "--format",
  "--filter-output",
  "--columns",
  "--token-limit",
  "--token-offset",
]);

export const OUTPUT_SWITCHES: ReadonlySet<string> = new Set([
  "--json",
  "--full-output",
  "--token-count",
  "--timings",
]);

/** Valueless flags Incur removes from every position before command parsing. */
export const INCUR_BUILTIN_FLAGS: ReadonlySet<string> = new Set([
  "--full-output",
  "--llms",
  "--llms-full",
  "--mcp",
  "--help",
  "-h",
  "--update",
  // Incur's internal update-check flag.
  "--incur-update-check",
  "--schema",
  "--json",
  "--token-count",
  "--timings",
]);

/** Command tokens and output-flag values as Incur's builtin pass assigns them. */
export interface IncurBuiltinArgumentSplit {
  /** Tokens left for command resolution and command option parsing. */
  readonly command: readonly string[];
  /** Valueless global flags extracted by Incur before command dispatch. */
  readonly flags: ReadonlySet<string>;
  /** Positions of nonempty values consumed by valued output flags. */
  readonly outputValues: readonly {
    readonly flag: string;
    readonly index: number;
  }[];
}

/**
 * Mirror Incur's builtin pass over normalized arguments without stopping at a
 * rejected value, so callers can still see every later token. REA's boolean
 * timing global follows the same valueless pass; no config flag is registered.
 */
export const splitIncurBuiltinArguments = (
  arguments_: readonly string[],
): IncurBuiltinArgumentSplit => {
  const command: string[] = [];
  const flags = new Set<string>();
  const outputValues: { readonly flag: string; readonly index: number }[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    const next = arguments_[index + 1];
    if (
      INCUR_BUILTIN_FLAGS.has(argument) ||
      // A following value belongs to a command-local `--version` option.
      (argument === "--version" && (next === undefined || next.startsWith("-")))
    ) {
      flags.add(argument);
      continue;
    }
    if (VALUED_OUTPUT_FLAGS.has(argument) && next) {
      outputValues.push({ flag: argument, index: index + 1 });
      index += 1;
      continue;
    }
    command.push(argument);
  }
  return { command, flags, outputValues };
};

/**
 * Route the root update alias and split `--flag=value` output forms. Incur reads these
 * flags only in spaced form, so `--format=json` otherwise reaches the command
 * parser and fails as an unknown flag. Command options accept both forms.
 */
export const normalizeCliArguments = (
  arguments_: readonly string[],
): string[] => {
  const normalized: string[] = [];
  const updates = new Set<number>();
  let rootUpdate = true;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (VALUED_OUTPUT_FLAGS.has(argument) && arguments_[index + 1]) {
      // Incur consumes a nonempty spaced value before looking for more flags.
      // Its contents belong to that option, even when they look like a flag.
      normalized.push(argument, arguments_[index + 1]!);
      index += 1;
      continue;
    }
    const separator = argument.indexOf("=");
    const flag = argument.slice(0, separator);
    if (separator >= 0 && VALUED_OUTPUT_FLAGS.has(flag))
      normalized.push(flag, argument.slice(separator + 1));
    else {
      if (argument === "--update") updates.add(normalized.length);
      else if (!OUTPUT_SWITCHES.has(argument)) rootUpdate = false;
      normalized.push(argument);
    }
  }
  // Output option values were consumed above; flag-shaped data is never an alias.
  // Help/check/command/unknown tokens retain Incur's parsing and precedence.
  return rootUpdate && updates.size > 0
    ? ["update", ...normalized.filter((_, index) => !updates.has(index))]
    : normalized;
};

/** Keep REA-owned delimited formats out of Incur's narrower formatter surface. */
export const adaptCliOutputArgumentsForIncur = (
  arguments_: readonly string[],
): string[] => {
  const adapted: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    const value = arguments_[index + 1];
    if (VALUED_OUTPUT_FLAGS.has(argument)) {
      if (argument === "--columns") {
        if (value !== undefined) index += 1;
        continue;
      }
      if (argument === "--format" && (value === "csv" || value === "tsv")) {
        adapted.push("--format", "json");
        index += 1;
        continue;
      }
      adapted.push(argument);
      if (value) {
        adapted.push(value);
        index += 1;
      }
      continue;
    }
    adapted.push(argument);
  }
  return adapted;
};

/** Select production doctor using the same normalized builtin argument owner as CLI dispatch. */
export const productionMcpDoctorArguments = (
  arguments_: readonly string[],
): readonly string[] | undefined => {
  const normalized = normalizeCliArguments(arguments_);
  const split = splitIncurBuiltinArguments(normalized);
  if (split.command[0] !== "mcp" || split.command[1] !== "doctor")
    return undefined;
  const values = new Set(split.outputValues.map(({ index }) => index));
  const mcp = normalized.findIndex(
    (token, index) => token === "mcp" && !values.has(index),
  );
  const doctor = normalized.findIndex(
    (token, index) => index > mcp && token === "doctor" && !values.has(index),
  );
  return normalized.filter((_, index) => index !== mcp && index !== doctor);
};

/** Incur accepts the schema key and its kebab-case spelling. */
const FLAGS = ["--sensitive-value", "--sensitiveValue"] as const;

/**
 * Read declarations from the tokens Incur leaves for command parsing. Incur
 * rejects a malformed token before it reaches later declarations, so this scan
 * is independent of parse success. A token following a declaration flag counts
 * as declared even where the command parser would bind it to another option.
 */
export const declaredSensitiveValues = (
  command: IncurBuiltinArgumentSplit["command"],
): readonly string[] => {
  const values = new Set<string>();
  for (let index = 0; index < command.length; index += 1) {
    const token = command[index]!;
    const flag = FLAGS.find(
      (candidate) => token === candidate || token.startsWith(`${candidate}=`),
    );
    if (flag === undefined) continue;
    if (token !== flag) values.add(token.slice(flag.length + 1));
    else if (index + 1 < command.length) {
      values.add(command[index + 1]!);
      index += 1;
    }
  }
  values.delete("");
  return [...values];
};
/** Valued `mcp add` options from its public help. */
const MCP_ADD_VALUED_OPTIONS = ["--agent", "--command", "-c"] as const;

/**
 * Flags that divert Incur before registration when they appear ahead of the
 * `add` word, so they are never missing-value cases: `--mcp` serves stdio,
 * `--llms` and `--llms-full` print docs, `--schema` and `--update` fail with
 * their own errors, and `--incur-update-check` runs the update check. Each
 * was verified against the built runtime; pure output flags such as
 * `--json` and `--full-output` do reach registration and stay in scope.
 */
const MCP_ADD_MODE_FLAGS: ReadonlySet<string> = new Set([
  "--mcp",
  "--llms",
  "--llms-full",
  "--schema",
  "--update",
  "--incur-update-check",
]);

/**
 * Find a valued `mcp add` option supplied without its value. Incur's
 * registration helper consumes an agent or command only when the next token
 * is truthy, so a trailing valued option (or one followed by another flag)
 * silently falls back to the defaults and registers anyway, unlike REA-owned
 * commands whose parser rejects a missing value. An equals form with an
 * empty remainder (`--agent=`) is the same missing value: Incur sees no
 * value to consume and registers with the defaults. An empty string value
 * (`--agent ""`) is the same missing value: Incur sees no usable value and
 * registers with the defaults. REA rejects that here, in its own entry
 * point, before Incur runs, so no runner is invoked and no client settings
 * are written. The command is located through REA's own normalization and
 * builtin split, so global output flags before `mcp add` or between its
 * words cannot hide a missing value either. Help requests are left alone:
 * Incur strips help flags before command parsing and shows help without
 * side effects. A lone `-` still counts as a value, matching the parser's
 * treatment of a present token. Returns the offending option, or undefined
 * when the invocation is not a `mcp add` with an incomplete valued option.
 */
export const findMcpAddMissingValue = (
  arguments_: readonly string[],
): string | undefined => {
  const normalized = normalizeCliArguments(arguments_);
  const split = splitIncurBuiltinArguments(normalized);
  if (split.flags.has("--help") || split.flags.has("-h")) return undefined;
  if (split.command[0] !== "mcp" || split.command[1] !== "add")
    return undefined;
  // Locate the `add` word in normalized form by walking it alongside the
  // split command, so builtin flags and consumed output values do not shift
  // it. A mode flag ahead of that word means Incur never reaches
  // registration for this invocation, so it is not a missing-value case.
  let addIndex = -1;
  let commandCursor = 0;
  for (
    let index = 0;
    index < normalized.length && commandCursor < split.command.length;
    index += 1
  ) {
    if (normalized[index] === split.command[commandCursor]) {
      if (commandCursor === 1) addIndex = index;
      commandCursor += 1;
    }
  }
  if (
    addIndex > 0 &&
    normalized.slice(0, addIndex).some((token) => MCP_ADD_MODE_FLAGS.has(token))
  )
    return undefined;
  const rest = split.command.slice(2);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    const emptyEquals = MCP_ADD_VALUED_OPTIONS.find(
      (candidate) => token === `${candidate}=`,
    );
    if (emptyEquals !== undefined) return emptyEquals;
    const option = MCP_ADD_VALUED_OPTIONS.find(
      (candidate) => token === candidate,
    );
    if (option === undefined) continue;
    const next = rest[index + 1];
    if (
      next === undefined ||
      next === "" ||
      (next.startsWith("-") && next !== "-")
    )
      return option;
  }
  return undefined;
};

/** Shell completion is a transport protocol; its words are not CLI invocations. */
export const CLI_COMPLETION_SHELLS = [
  "bash",
  "zsh",
  "fish",
  "nushell",
] as const;
export const cliCompletionShell = (environment: Readonly<NodeJS.ProcessEnv>) =>
  CLI_COMPLETION_SHELLS.find((shell) => shell === environment.COMPLETE);
