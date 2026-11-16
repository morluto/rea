import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect } from "vitest";

import { PRODUCT_IDENTITY } from "../../../src/identity.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
  type TestWorkspace,
} from "../../support/workspace/workspaceFixture.js";

/**
 * Parity goldens for the CLI layer REA is moving off incur (#11654). Each case
 * runs the compiled `rea` and compares its exit code, stdout and stderr with a
 * reviewed file in tests/fixtures/cli-parity. A replacement of the parser,
 * help, completions, formatter or dispatch must keep every file unchanged
 * unless the owner approves the difference.
 *
 * Record after an approved change with
 * `REA_RECORD_CLI_PARITY=1 npm run test:focused -- tests/boundary/cli/cliParityGoldens.test.ts`
 * and review the diff.
 */

const GOLDEN_DIRECTORY = new URL("../../fixtures/cli-parity/", import.meta.url);
const RECORD = process.env.REA_RECORD_CLI_PARITY === "1";

/** Bytes whose entropy, length and digest the output cases select. */
const SAMPLE = Buffer.from("REA\x00\x01\x02parity-golden\n", "latin1");
const SENSITIVE = "secret-literal";

interface ParityCase {
  readonly name: string;
  readonly arguments: (workspace: TestWorkspace) => readonly string[];
  /** Shell completion protocol requests. */
  readonly complete?: "bash" | "zsh" | "fish" | "nushell";
  /** Run with stdout on a pseudo-terminal, as a user's terminal would. */
  readonly terminal?: boolean;
  /** Environment beyond the workspace's for this case. */
  readonly environment?: (workspace: TestWorkspace) => NodeJS.ProcessEnv;
}

const sample = (workspace: TestWorkspace) => workspace.path("sample.bin");
const entropy = (
  workspace: TestWorkspace,
  ...rest: readonly string[]
): readonly string[] => ["inspect-byte-entropy", sample(workspace), ...rest];
const SELECTION = [
  "--filter-output",
  "normalized_result.window,normalized_result.blocks,normalized_result.thresholds",
] as const;
const BLOCKS = ["--filter-output", "normalized_result.blocks"] as const;
const WINDOW = ["--filter-output", "normalized_result.window"] as const;
const fixed =
  (...arguments_: readonly string[]) =>
  (): readonly string[] =>
    arguments_;
const completion = (
  shell: NonNullable<ParityCase["complete"]>,
  name: string,
  ...words: readonly string[]
): ParityCase => ({
  name: `complete-${shell}-${name}`,
  complete: shell,
  arguments: fixed("--", "rea", ...words),
});

/**
 * Terminal ("human") cases. incur treats a terminal stdout as a person
 * reading: help instead of an error for a bare command, errors followed by
 * usage, agent-only results (setup) hidden, and an update notice. Notices are
 * off except in the notice case, whose fresh cache names a newer version so
 * no registry check is scheduled.
 */
const terminal = (
  name: string,
  arguments_: ParityCase["arguments"],
  environment: ParityCase["environment"] = () => ({ NO_UPDATE_NOTIFIER: "1" }),
): ParityCase => ({
  name: `terminal-${name}`,
  terminal: true,
  arguments: arguments_,
  environment,
});
const UPDATE_CACHE = "update-cache";
const NEWER_VERSION = "999.0.0";

const TERMINAL_CASES: readonly ParityCase[] = [
  terminal("help-root-bare", fixed()),
  terminal("help-command", fixed("inspect-byte-entropy", "--help")),
  terminal("output", (w) => entropy(w, ...WINDOW)),
  terminal("output-explicit-format", (w) =>
    entropy(w, ...WINDOW, "--format", "json"),
  ),
  terminal("output-full-output", (w) => entropy(w, ...WINDOW, "--full-output")),
  terminal("error-unknown-command", fixed("no-such-command")),
  terminal("error-unknown-flag", (w) => entropy(w, "--no-such-flag")),
  terminal("error-refined-number", (w) => entropy(w, "--block-size", "100")),
  terminal("error-refined-number-json", (w) =>
    entropy(w, "--block-size", "100", "--json"),
  ),
  terminal("setup-dry-run", fixed("setup", "--dry-run")),
  terminal("update-notice", fixed("no-such-command"), (w) => ({
    XDG_CACHE_HOME: w.path(UPDATE_CACHE),
    // A refresh, if one were scheduled, stays on this host.
    npm_config_registry: "http://127.0.0.1:9/",
  })),
];

const CASES: readonly ParityCase[] = [
  // Help and manifests
  { name: "help-root-bare", arguments: fixed() },
  { name: "help-root", arguments: fixed("--help") },
  { name: "help-root-short", arguments: fixed("-h") },
  {
    name: "help-root-with-format",
    arguments: fixed("--help", "--format", "json"),
  },
  { name: "version", arguments: fixed("--version") },
  {
    name: "version-after-command",
    arguments: fixed("inspect-byte-entropy", "--version"),
  },
  {
    name: "help-contract-command",
    arguments: fixed("inspect-byte-entropy", "--help"),
  },
  {
    name: "help-contract-optional-positional",
    arguments: fixed("instructions", "--help"),
  },
  {
    name: "help-contract-long-description",
    arguments: fixed("decompile", "--help"),
  },
  { name: "help-contract-defaults", arguments: fixed("read-bytes", "--help") },
  { name: "help-hand-built-setup", arguments: fixed("setup", "--help") },
  { name: "help-hand-built-doctor", arguments: fixed("doctor", "--help") },
  { name: "help-hand-built-guidance", arguments: fixed("guidance", "--help") },
  {
    name: "help-hand-built-capture-process",
    arguments: fixed("capture-process", "--help"),
  },
  {
    name: "help-hand-built-environment-build",
    arguments: fixed("environment-build", "--help"),
  },
  { name: "help-update", arguments: fixed("update", "--help") },
  { name: "help-mcp", arguments: fixed("mcp", "--help") },
  { name: "help-mcp-add", arguments: fixed("mcp", "add", "--help") },
  { name: "help-mcp-doctor", arguments: fixed("mcp", "doctor", "--help") },
  { name: "help-completions", arguments: fixed("completions", "--help") },
  { name: "help-completions-bare", arguments: fixed("completions") },
  {
    name: "schema-command",
    arguments: fixed("inspect-byte-entropy", "--schema"),
  },
  {
    name: "schema-command-json",
    arguments: fixed("inspect-byte-entropy", "--schema", "--format", "json"),
  },
  { name: "llms-command", arguments: fixed("inspect-byte-entropy", "--llms") },
  {
    name: "llms-full-command",
    arguments: fixed("inspect-byte-entropy", "--llms-full"),
  },

  // Completion scripts and the completion protocol
  { name: "completions-bash", arguments: fixed("completions", "bash") },
  { name: "completions-zsh", arguments: fixed("completions", "zsh") },
  { name: "completions-fish", arguments: fixed("completions", "fish") },
  { name: "completions-nushell", arguments: fixed("completions", "nushell") },
  {
    name: "completions-unknown-shell",
    arguments: fixed("completions", "powershell"),
  },
  completion("bash", "command-prefix", "inspect-byte-e"),
  completion("bash", "option-prefix", "inspect-byte-entropy", "--bl"),
  completion("bash", "mcp-subcommands", "mcp", ""),
  completion("bash", "completion-shells", "completions", ""),
  completion("bash", "format-values", "inspect-byte-entropy", "--format", ""),
  completion("bash", "enum-values", "instructions", "--target-format", ""),
  completion("bash", "global-prefix", "inspect-byte-entropy", "--tok"),
  completion("bash", "group-prefix", "mc"),
  completion("bash", "short-aliases", "setup", "-"),
  completion(
    "bash",
    "hand-built-enum-values",
    "setup",
    "--tool-catalog-profile",
    "",
  ),
  completion("bash", "aliased-option-value", "mcp", "add", "-c", ""),
  completion(
    "bash",
    "boolean-before-subcommand",
    "inspect-byte-entropy",
    "--json",
    "",
  ),
  completion("bash", "after-separator", "inspect-byte-entropy", "--", ""),
  completion("zsh", "mcp-doctor-options", "mcp", "doctor", "--"),
  completion("zsh", "described-commands", "inspect-pe-"),
  completion("zsh", "format-values", "inspect-byte-entropy", "--format", ""),
  completion("fish", "described-commands", "inspect-pe-"),
  completion("nushell", "described-commands", "inspect-pe-"),

  // Command resolution and argument errors
  { name: "error-unknown-command", arguments: fixed("no-such-command") },
  { name: "error-empty-command", arguments: fixed("") },
  { name: "error-unknown-mcp-subcommand", arguments: fixed("mcp", "bogus") },
  {
    name: "error-missing-positional",
    arguments: fixed("inspect-byte-entropy"),
  },
  { name: "error-extra-positional", arguments: (w) => entropy(w, "extra") },
  {
    name: "error-unknown-flag",
    arguments: (w) => entropy(w, "--no-such-flag"),
  },
  {
    name: "error-missing-flag-value",
    arguments: (w) => entropy(w, "--block-size"),
  },
  {
    name: "error-invalid-number",
    arguments: (w) => entropy(w, "--block-size", "abc"),
  },
  {
    name: "error-refined-number",
    arguments: (w) => entropy(w, "--block-size", "100"),
  },
  {
    name: "error-refined-number-json",
    arguments: (w) => entropy(w, "--block-size", "100", "--format", "json"),
  },
  {
    name: "error-refined-number-md",
    arguments: (w) => entropy(w, "--block-size", "100", "--format", "md"),
  },
  {
    name: "error-refined-number-full-output",
    arguments: (w) =>
      entropy(w, "--block-size", "100", "--json", "--full-output"),
  },
  {
    name: "error-separator",
    arguments: (w) => entropy(w, "--", "--block-size"),
  },
  {
    name: "error-format-invalid",
    arguments: (w) => entropy(w, "--format", "bogus"),
  },
  { name: "error-format-missing", arguments: (w) => entropy(w, "--format") },
  {
    name: "error-delimited-without-columns",
    arguments: (w) => entropy(w, ...BLOCKS, "--format", "csv"),
  },
  {
    name: "error-jsonl-not-collection",
    arguments: (w) => entropy(w, ...BLOCKS, "--format", "jsonl"),
  },
  {
    name: "error-sensitive-output-value",
    arguments: (w) => [
      "inspect-web-network-capture",
      w.path("capture.har"),
      "--format",
      SENSITIVE,
      "--sensitive-value",
      SENSITIVE,
    ],
  },
  {
    name: "error-sensitive-positional",
    arguments: (w) => [
      "inspect-web-network-capture",
      w.path("capture.har"),
      "har",
      SENSITIVE,
      "--sensitive-value",
      SENSITIVE,
    ],
  },

  // Output formats, filtering and global output controls
  { name: "output-toon", arguments: (w) => entropy(w, ...SELECTION) },
  {
    name: "output-json",
    arguments: (w) => entropy(w, ...SELECTION, "--format", "json"),
  },
  {
    name: "output-json-switch",
    arguments: (w) => entropy(w, ...SELECTION, "--json"),
  },
  {
    name: "output-json-equals",
    arguments: (w) =>
      entropy(w, `--filter-output=${SELECTION[1]}`, "--format=json"),
  },
  {
    name: "output-yaml",
    arguments: (w) => entropy(w, ...SELECTION, "--format", "yaml"),
  },
  {
    name: "output-md",
    arguments: (w) => entropy(w, ...SELECTION, "--format", "md"),
  },
  {
    name: "output-csv",
    arguments: (w) =>
      entropy(
        w,
        ...BLOCKS,
        "--columns",
        "offset,length,entropy",
        "--format",
        "csv",
      ),
  },
  {
    name: "output-tsv",
    arguments: (w) =>
      entropy(w, ...BLOCKS, "--columns", "offset,entropy", "--format", "tsv"),
  },
  {
    name: "output-full-output",
    arguments: (w) => entropy(w, ...WINDOW, "--full-output"),
  },
  {
    name: "output-full-output-json",
    arguments: (w) => entropy(w, ...WINDOW, "--full-output", "--json"),
  },
  {
    name: "output-token-count",
    arguments: (w) => entropy(w, ...WINDOW, "--token-count"),
  },
  {
    name: "output-token-limit",
    arguments: (w) => entropy(w, ...SELECTION, "--token-limit", "5"),
  },
  {
    name: "output-token-offset",
    arguments: (w) =>
      entropy(w, ...SELECTION, "--token-limit", "5", "--token-offset", "5"),
  },
  {
    name: "output-timings",
    arguments: (w) => entropy(w, ...WINDOW, "--timings"),
  },
];

/** Rows of the root command list kept in the golden; the rest are elided. */
const ROOT_HELP_ROWS: ReadonlySet<string> = new Set([
  "address-to-file-offset",
  "build-reconstruction-obligation-ledger",
  "decompile",
  "inspect-byte-entropy",
  "setup",
  "xrefs",
]);
const ELIDED_ROWS = "  <registered command rows elided>";

/**
 * The root command list grows with every new command. Check its layout here
 * (sorted, every description starting two columns after the longest name)
 * and keep only sample rows in the golden, written with a two-space gap
 * instead of the measured padding, so adding a command, including one with a
 * longer name, does not change the goldens.
 */
const elideRootCommandRows = (stdout: string): string => {
  const lines = stdout.split("\n");
  const start = lines.indexOf("Commands:");
  if (start < 0) return stdout;
  const end = lines.indexOf("", start);
  const rows = lines.slice(start + 1, end);
  const parsed = rows.map((row) => /^ {2}(\S+)( +)\S/u.exec(row));
  expect(parsed.every((match) => match !== null)).toBe(true);
  const names = parsed.map((match) => match![1]!);
  expect(names).toEqual([...names].sort());
  const width = Math.max(...names.map((name) => name.length));
  for (const match of parsed)
    expect(match![1]!.length + match![2]!.length).toBe(width + 2);
  const kept: string[] = [];
  rows.forEach((row, index) => {
    if (ROOT_HELP_ROWS.has(names[index]!))
      kept.push(`  ${names[index]!}  ${row.slice(width + 4)}`);
    else if (kept.at(-1) !== ELIDED_ROWS) kept.push(ELIDED_ROWS);
  });
  return [...lines.slice(0, start + 1), ...kept, ...lines.slice(end)].join(
    "\n",
  );
};

/** Visible, reviewable text for protocol control bytes. */
const visible = (text: string): string =>
  text.replace(
    // oxlint-disable-next-line no-control-regex -- the completion protocol separates records with control bytes.
    /[\x00-\x08\x0b-\x1f\x7f]/gu,
    (character) =>
      `<0x${character.charCodeAt(0).toString(16).padStart(2, "0")}>`,
  );

const normalize = (text: string, workspace: TestWorkspace): string =>
  visible(
    text
      .split(workspace.root)
      .join("<workspace>")
      .split(`rea@${PRODUCT_IDENTITY.packageVersion}`)
      .join("rea@<version>")
      .replace(/^\d+\.\d+\.\d+(?:-[\w.]+)?\n$/u, (line) =>
        line === `${PRODUCT_IDENTITY.packageVersion}\n` ? "<version>\n" : line,
      )
      .split(`from ${PRODUCT_IDENTITY.packageVersion} to`)
      .join("from <version> to")
      .replace(/(duration"?:\s*"?)\d+ms/gu, "$1<ms>ms")
      .replace(/("command_ms":)\d+/gu, "$1<ms>"),
  );

const render = (
  testCase: ParityCase,
  workspace: TestWorkspace,
  result: { exitCode: number | null; stdout: string; stderr: string },
): string => {
  const command = testCase
    .arguments(workspace)
    .map((argument) =>
      argument === "" || /\s/u.test(argument)
        ? JSON.stringify(argument)
        : argument,
    );
  const stdout = /^(?:terminal-)?help-root/u.test(testCase.name)
    ? elideRootCommandRows(result.stdout)
    : result.stdout;
  return [
    `$ ${testCase.complete === undefined ? "" : `COMPLETE=${testCase.complete} `}rea ${command.join(" ")}`.trimEnd() +
      (testCase.terminal === true ? "  # stdout is a terminal" : ""),
    `exit: ${result.exitCode}`,
    "--- stdout",
    `${normalize(stdout, workspace)}<end>`,
    "--- stderr",
    `${normalize(result.stderr, workspace)}<end>`,
    "",
  ]
    .join("\n")
    .split(workspace.root)
    .join("<workspace>");
};

describe("CLI parity goldens", () => {
  // One workspace and environment for the file, so the shared CLI process
  // serves every non-completion case instead of restarting per case.
  let workspace: TestWorkspace;
  beforeAll(async () => {
    workspace = await createTestWorkspace("rea-cli-parity-");
    await workspace.write("sample.bin", SAMPLE);
    await workspace.write(
      `${UPDATE_CACHE}/incur/updates/${PRODUCT_IDENTITY.packageName}.json`,
      `${JSON.stringify({ checkedAt: Date.now(), latest: NEWER_VERSION })}\n`,
    );
  });
  afterAll(async () => {
    await removeTestWorkspace(workspace.root);
  });

  // Recording writes the files of new cases, so only orphans fail then.
  cliTest("every golden belongs to a case", async () => {
    const files = (await readdir(GOLDEN_DIRECTORY)).filter((file) =>
      file.endsWith(".txt"),
    );
    const expected = [...CASES, ...TERMINAL_CASES]
      .map(({ name }) => `${name}.txt`)
      .sort();
    if (RECORD)
      expect(files.filter((file) => !expected.includes(file))).toEqual([]);
    else expect(files.sort()).toEqual(expected);
  });

  const check = async (testCase: ParityCase, cli: TestCli): Promise<void> => {
    const result = await cli.run({
      arguments: testCase.arguments(workspace),
      cwd: workspace.root,
      environment: {
        ...workspace.environment,
        ...testCase.environment?.(workspace),
        ...(testCase.complete === undefined
          ? {}
          : { COMPLETE: testCase.complete }),
      },
      ...(testCase.complete === undefined ? {} : { freshProcess: true }),
      ...(testCase.terminal === true ? { terminal: true } : {}),
    });
    const actual = render(testCase, workspace, result);
    const golden = new URL(`${testCase.name}.txt`, GOLDEN_DIRECTORY);
    if (RECORD) {
      await mkdir(GOLDEN_DIRECTORY, { recursive: true });
      await writeFile(golden, actual, "utf8");
      return;
    }
    expect(actual).toBe(await readFile(golden, "utf8"));
  };

  cliTest.for(CASES)("$name", (testCase, { cli }) => check(testCase, cli));
  // Windows has no POSIX pseudo-terminal for the terminal driver.
  cliTest.skipIf(process.platform === "win32").for(TERMINAL_CASES)(
    "$name",
    (testCase, { cli }) => check(testCase, cli),
  );
});
