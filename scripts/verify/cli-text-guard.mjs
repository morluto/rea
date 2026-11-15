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
export const HOST_ONLY_COMMANDS = new Map([
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
export const CLI_ONLY_FILES = new Map([
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

/** @param {string} content */
export const cliTextOutsideCliCount = (content) => {
  let count = 0;
  for (const [text] of content.matchAll(cliText)) {
    const command = /\brea ([a-z][a-z-]*)$/u.exec(text)?.[1];
    if (command !== undefined && HOST_ONLY_COMMANDS.has(command)) continue;
    count += 1;
  }
  return count;
};
