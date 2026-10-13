/** Host argv shared by setup registrations and the source-only plugin launcher. */
export const packageRunnerCommand = (
  runner,
  packageSpecifier,
  platform,
  prefix,
) => {
  if (runner !== "npx" && runner !== "bunx")
    throw new Error("Unsupported package runner");
  // Windows cmd.exe consumes these tokens itself. Package registrations use
  // exact registry references, never shell expressions or arbitrary operands.
  if (!/^[@A-Za-z0-9_./+-]+$/u.test(packageSpecifier))
    throw new Error("Package runner requires a shell-safe registry reference");
  const command = runner === "npx" ? ["npx", "-y"] : ["bunx"];
  if (prefix !== undefined) {
    if (runner !== "npx") throw new Error("Only npx accepts a prefix");
    command.push(
      platform === "win32"
        ? `--prefix=${escapeWindowsCmdArgument(prefix)}`
        : `--prefix=${prefix}`,
    );
  }
  command.push(packageSpecifier, "mcp");
  // npm's .cmd shim is not a native executable. Disable cmd AutoRun, matching
  // the setup registration policy, and keep all dynamic values out of syntax.
  return platform === "win32" ? ["cmd.exe", "/d", "/c", ...command] : command;
};

/** Quote and escape a token for cmd.exe and the nested npx.cmd shim. */
const escapeWindowsCmdArgument = (input) => {
  if (/[\0\r\n]/u.test(input))
    throw new Error(
      "Windows package runner prefix contains a command separator",
    );

  let result;
  if (!/[ \t\n\v"]/.test(input)) {
    result = input;
  } else {
    result = '"';
    for (let index = 0; index <= input.length; index += 1) {
      let slashCount = 0;
      while (input[index] === "\\") {
        index += 1;
        slashCount += 1;
      }
      if (index === input.length) {
        result += "\\".repeat(slashCount * 2);
        break;
      }
      if (input[index] === '"') {
        result += "\\".repeat(slashCount * 2 + 1) + input[index];
      } else {
        result += "\\".repeat(slashCount) + input[index];
      }
    }
    result += '"';
  }

  const escapeShellMeta = (value) => value.replace(/[ !%^&()<>|"]/gu, "^$&");
  return escapeShellMeta(escapeShellMeta(result));
};
