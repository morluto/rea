import { z } from "zod";

/** @typedef {import("../../src/cli/commandRegistry.js").CliCommandEntry} CliCommandEntry */

const INPUT_GROUPS = /** @type {const} */ (["args", "options"]);

/**
 * Read primary names from the command owner's records. Command aliases are
 * not part of the REA registration contract; option aliases remain on definitions.
 * @param {readonly CliCommandEntry[]} entries
 */
export const createCliInventory = (entries) => {
  if (entries.length === 0)
    throw new Error("REA exposed no primary CLI commands");
  return {
    primary: entries
      .map(({ name }) => name)
      .sort((left, right) => left.localeCompare(right)),
    aliases:
      /** @type {readonly { readonly name: string; readonly target: string }[]} */ ([]),
  };
};

/**
 * Read one primary command's declared option names from its registered schema.
 * @param {readonly CliCommandEntry[]} entries
 * @param {string} name
 */
export const cliCommandOptionNames = (entries, name) => {
  const command = entries.find((entry) => entry.name === name)?.definition;
  if (command?.options === undefined) return [];
  const schema = z.toJSONSchema(command.options);
  return Object.keys(schema.properties ?? {}).sort((left, right) =>
    left.localeCompare(right),
  );
};

/**
 * Report primary CLI fields whose generated JSON Schema lacks help text.
 * @param {readonly CliCommandEntry[]} entries
 */
export const cliCommandDescriptionIssues = (entries) => {
  const missing = [];
  for (const { name: commandName, definition } of entries) {
    for (const groupName of INPUT_GROUPS) {
      const group = definition[groupName];
      if (group === undefined) continue;
      const properties = z.toJSONSchema(group).properties ?? {};
      for (const [propertyName, property] of Object.entries(properties)) {
        if (
          typeof property !== "object" ||
          property === null ||
          typeof property.description !== "string" ||
          property.description.trim() === ""
        )
          missing.push(`${commandName}.${groupName}.${propertyName}`);
      }
    }
  }
  return missing;
};
