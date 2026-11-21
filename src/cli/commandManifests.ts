/*
 * The --llms index, the --llms-full manifest and the --schema document are
 * adapted from Incur's manifest and skill generators.
 * Copyright (c) 2025-present weth, LLC
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */
import { z } from "zod";

import type { CliCommandEntry } from "./commandRegistry.js";
import { optionFlagName } from "./optionFields.js";

/** The manifests' format version, which callers may already check. */
const MANIFEST_VERSION = "incur.v1";

type JsonSchema = Record<string, unknown> & {
  readonly type?: unknown;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly default?: unknown;
  readonly deprecated?: unknown;
};

/**
 * A command input as JSON Schema, without `$schema`. Bigints and dates are
 * strings, and unrepresentable types accept anything.
 */
export const commandInputJsonSchema = (schema: z.ZodType): JsonSchema => {
  const result = z.toJSONSchema(schema, {
    unrepresentable: "any",
    override: (context) => {
      const type = context.zodSchema._zod.def.type;
      if (type === "bigint" || type === "date")
        context.jsonSchema.type = "string";
    },
  }) as JsonSchema;
  delete result.$schema;
  return result;
};

/** The JSON type a manifest table shows, with integers shown as numbers. */
const tableType = (property: JsonSchema | undefined): string => {
  const type = property?.type;
  if (typeof type !== "string") return "unknown";
  return type === "integer" ? "number" : type;
};

const shape = (schema: z.ZodObject): Readonly<Record<string, z.ZodType>> =>
  schema.shape as Readonly<Record<string, z.ZodType>>;

/** `rea <command> <required> [optional] <variadic...>`. */
const signature = (cli: string, { name, definition }: CliCommandEntry) => {
  const base = `${cli} ${name}`;
  if (definition.args === undefined) return base;
  const json = commandInputJsonSchema(definition.args);
  const required = new Set(json.required ?? []);
  const names = Object.keys(shape(definition.args)).map((key) => {
    const label = json.properties?.[key]?.type === "array" ? `${key}...` : key;
    return required.has(key) ? `<${label}>` : `[${label}]`;
  });
  return `${base} ${names.join(" ")}`;
};

/** The `--llms` Markdown index: one row per command. */
export const formatLlmsIndex = (
  cli: string,
  commands: readonly CliCommandEntry[],
  description: string,
): string =>
  [
    `# ${cli}`,
    "",
    description,
    "",
    "| Command | Description |",
    "|---------|-------------|",
    ...commands.map(
      (command) =>
        `| \`${signature(cli, command)}\` | ${command.definition.description ?? ""} |`,
    ),
    "",
    `Run \`${cli} --llms-full\` for full manifest. Run \`${cli} <command> --schema\` for argument details.`,
  ].join("\n");

const commandBody = (cli: string, { name, definition }: CliCommandEntry) => {
  const heading =
    definition.description === undefined || definition.description === ""
      ? `# ${cli} ${name}`
      : `# ${cli} ${name}\n\n${definition.description}`;
  const sections = [heading];
  if (definition.args !== undefined) {
    const json = commandInputJsonSchema(definition.args);
    const required = new Set(json.required ?? []);
    const rows = Object.entries(shape(definition.args)).map(
      ([key, field]) =>
        `| \`${key}\` | \`${tableType(json.properties?.[key])}\` | ${required.has(key) ? "yes" : "no"} | ${field.description ?? ""} |`,
    );
    sections.push(
      `## Arguments\n\n| Name | Type | Required | Description |\n|------|------|----------|-------------|\n${rows.join("\n")}`,
    );
  }
  if (definition.options !== undefined) {
    const json = commandInputJsonSchema(definition.options);
    const rows = Object.entries(shape(definition.options)).map(
      ([key, field]) => {
        const property = json.properties?.[key];
        const fallback =
          property?.default === undefined ? "" : String(property.default);
        const text = field.description ?? "";
        const description =
          property?.deprecated === true ? `**Deprecated.** ${text}` : text;
        return `| \`--${optionFlagName(key)}\` | \`${tableType(property)}\` | ${fallback === "" ? "" : `\`${fallback}\``} | ${description} |`;
      },
    );
    sections.push(
      `## Options\n\n| Flag | Type | Default | Description |\n|------|------|---------|-------------|\n${rows.join("\n")}`,
    );
  }
  return sections.join("\n\n");
};

/** The `--llms-full` Markdown manifest: each command's arguments and options. */
export const formatLlmsFull = (
  cli: string,
  commands: readonly CliCommandEntry[],
): string => commands.map((command) => commandBody(cli, command)).join("\n\n");

/** The `--llms` document for a structured format: names and descriptions. */
export const llmsIndexManifest = (
  commands: readonly CliCommandEntry[],
  globals: z.ZodObject,
) => ({
  version: MANIFEST_VERSION,
  commands: commands.map(({ name, definition }) => ({
    name,
    ...(definition.description ? { description: definition.description } : {}),
  })),
  globals: commandInputJsonSchema(globals),
});

/** The `--llms-full` document for a structured format: each command's input schemas. */
export const llmsFullManifest = (
  commands: readonly CliCommandEntry[],
  globals: z.ZodObject,
) => ({
  version: MANIFEST_VERSION,
  commands: commands.map(({ name, definition }) => ({
    name,
    ...(definition.description ? { description: definition.description } : {}),
    ...(definition.args === undefined && definition.options === undefined
      ? {}
      : {
          schema: {
            ...(definition.args === undefined
              ? {}
              : { args: commandInputJsonSchema(definition.args) }),
            ...(definition.options === undefined
              ? {}
              : { options: commandInputJsonSchema(definition.options) }),
          },
        }),
  })),
  globals: commandInputJsonSchema(globals),
});

/** The `--schema` document of one command. */
export const commandSchemaDocument = (
  { definition }: CliCommandEntry,
  globals: z.ZodObject,
) => ({
  ...(definition.args === undefined
    ? {}
    : { args: commandInputJsonSchema(definition.args) }),
  ...(definition.options === undefined
    ? {}
    : { options: commandInputJsonSchema(definition.options) }),
  globals: commandInputJsonSchema(globals),
});
