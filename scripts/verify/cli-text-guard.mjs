// Services name the contract field they refuse or ask the caller to change,
// and a failure binds its per-call control as `limit`; the CLI layer owns
// option and command spellings (projectCliInputFields adds `cli_flag`). A
// `--flag`, "on the CLI" or `rea <command>` written outside src/cli copies
// that mapping into output MCP clients also receive, including text built
// from a template such as `--${name}` or `rea inspect-... <path>`.
const cliText =
  /\(CLI\b[^)\n]*|\bon the CLI\b|\bor (?:use|pass) (?:--[a-z]|rea [a-z][a-z-]*)|\bcli(?:Flag|Total|PerFile)?:\s*"--[a-z]|(?:message|userMessage):\s*["`]--[a-z]|`rea [a-z][a-z-]*/gu;

/**
 * Host commands with no MCP operation. Telling an operator to run one is an
 * operator instruction, not a copy of an adapter spelling, so the text stays
 * where it is (maintainer decision on #11476).
 * @type {ReadonlyMap<string, string>}
 */
const HOST_ONLY_COMMANDS = new Map([
  [
    "doctor",
    "Checks the host installation and provider readiness; no MCP operation does this.",
  ],
  [
    "setup",
    "Installs and configures providers on the host after operator approval; no MCP operation does this.",
  ],
  [
    "environment-serve",
    "Starts a host environment server process; no MCP operation does this.",
  ],
]);

/**
 * Files that run only through the CLI, so their recovery may name CLI
 * options. Each entry gives the reason.
 * @type {ReadonlyMap<string, string>}
 */
const CLI_ONLY_FILES = new Map([
  [
    "src/application/Doctor.ts",
    "Setup and doctor run only through the CLI, so their recovery may name CLI options such as --skill=false.",
  ],
]);

/** @param {string} path */
export const cliTextGuardSelects = (path) =>
  !path.startsWith("src/cli/") &&
  !/^src\/cli[^/]*\.ts$/u.test(path) &&
  !CLI_ONLY_FILES.has(path);

// One `rea <command>` with the arguments written after it. They end at a
// closing backtick or parenthesis, a comma or semicolon, or the next
// `rea <command>`, so one exemption never removes another command.
const reaCommand = /\brea ([a-z][a-z-]*)(?:(?!\brea [a-z])[^`)\n,;])*/gu;
const remainingCliText = /--[a-z]|\brea [a-z]|\bon the CLI\b/u;

/**
 * Whether a matched phrase still names CLI text once each host-only command
 * and its own arguments are removed. A phrase that names only those commands
 * is an operator instruction; one that also names another option or command
 * still counts.
 * @param {string} text
 */
const namesCliText = (text) => {
  let hostOnly = false;
  const rest = text.replace(reaCommand, (command, name) => {
    if (!HOST_ONLY_COMMANDS.has(name)) return command;
    hostOnly = true;
    return "";
  });
  return !hostOnly || remainingCliText.test(rest);
};

/** @param {string} content */
export const cliTextOutsideCliCount = (content) => {
  let count = 0;
  for (const [text] of content.matchAll(cliText))
    if (namesCliText(text)) count += 1;
  return count;
};
