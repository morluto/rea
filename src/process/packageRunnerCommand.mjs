/** Host argv shared by setup registrations and the source-only plugin launcher. */
export const packageRunnerCommand = (runner, packageSpecifier, platform) => {
  if (runner !== "npx" && runner !== "bunx")
    throw new Error("Unsupported package runner");
  // Windows cmd.exe consumes these tokens itself. Package registrations use
  // exact registry references, never shell expressions or arbitrary operands.
  if (!/^[@A-Za-z0-9_./+-]+$/u.test(packageSpecifier))
    throw new Error("Package runner requires a shell-safe registry reference");
  const command =
    runner === "npx"
      ? ["npx", "-y", packageSpecifier, "mcp"]
      : ["bunx", packageSpecifier, "mcp"];
  // npm's .cmd shim is not a native executable. Disable cmd AutoRun, matching
  // the setup registration policy, and keep all dynamic values out of syntax.
  return platform === "win32" ? ["cmd.exe", "/d", "/c", ...command] : command;
};
