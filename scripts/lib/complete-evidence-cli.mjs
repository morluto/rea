/**
 * Verifier helpers that read complete Evidence from the compiled CLI request
 * it explicitly. A command that takes `--detail`, given neither `--detail`
 * nor `--view`, gets `--detail complete` after the command word; the set of
 * such commands is read from the compiled CLI's own registry.
 */
let detailCommands;

const loadDetailCommands = async () => {
  if (detailCommands !== undefined) return detailCommands;
  const [{ createCli }, { cliCommands }] = await Promise.all([
    import("../../dist/cli.js"),
    import("../../dist/cli/commandRegistry.js"),
  ]);
  detailCommands = new Set(
    cliCommands(createCli({}))
      .filter(
        (entry) =>
          entry.definition.options?.shape !== undefined &&
          Object.hasOwn(entry.definition.options.shape, "detail"),
      )
      .map(({ name }) => name),
  );
  return detailCommands;
};

/** The argv for one CLI invocation that reads complete Evidence. */
export const completeEvidenceCliArguments = async (arguments_) => {
  const [command, ...rest] = arguments_;
  if (command === undefined || !(await loadDetailCommands()).has(command))
    return arguments_;
  const selects = (flag) =>
    rest.some(
      (argument) => argument === flag || argument.startsWith(`${flag}=`),
    );
  return selects("--detail") || selects("--view")
    ? arguments_
    : [command, "--detail", "complete", ...rest];
};
