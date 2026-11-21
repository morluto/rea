/** Independent protocol oracle for the Codex and Claude setup fixtures. */
export const setupPluginOperation = (
  /** @type {string} */ client,
  /** @type {readonly string[]} */ args,
) => {
  if (client !== "codex" && client !== "claude")
    throw new Error(`Unmodeled plugin client: ${client}`);
  const commands = {
    list: ["plugin", "list", "--json"],
    marketplace: ["plugin", "marketplace", "add", "morluto/rea"],
    install:
      client === "codex"
        ? ["plugin", "add", "rea@rea"]
        : ["plugin", "install", "rea@rea", "--scope", "user"],
    enable:
      client === "codex"
        ? ["plugin", "enable", "rea@rea"]
        : ["plugin", "enable", "rea@rea", "--scope", "user"],
  };
  const operation = Object.entries(commands).find(
    ([, expected]) =>
      args.length === expected.length &&
      args.every((argument, index) => argument === expected[index]),
  );
  if (operation === undefined)
    throw new Error(`Unmodeled ${client} command: ${JSON.stringify(args)}`);
  return operation[0];
};
