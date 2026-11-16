import { z } from "zod";

import { declaredOptionType, optionFlagName } from "./optionFields.js";

/**
 * REA's command help text. The layout is the one the CLI has always printed:
 * a `name — description` title, a usage line, aligned option rows with type
 * placeholders and shown defaults, an optional hint, then the global options the
 * entry accepts.
 */

/** The global options block of an entry that accepts them. */
export interface GlobalOptionsHelp {
  /** The `--format` values this entry accepts, in display order. */
  readonly formats: readonly string[];
}

export interface CommandHelp {
  readonly description?: string | undefined;
  readonly options?: z.ZodObject | undefined;
  /** Short alias by option key, such as `{ help: "h" }`. */
  readonly alias?: Readonly<Record<string, string>> | undefined;
  /** A paragraph printed after the options. */
  readonly hint?: string | undefined;
  /** Omitted for an entry that accepts only its own options. */
  readonly globalOptions?: GlobalOptionsHelp | undefined;
}

interface Row {
  readonly label: string;
  readonly description: string;
}

/** Two-column rows with the descriptions aligned after the longest label. */
const alignedRows = (rows: readonly Row[]): string[] => {
  const width = Math.max(...rows.map((row) => row.label.length));
  return rows.map(
    (row) =>
      `  ${row.label}${" ".repeat(width - row.label.length)}  ${row.description}`,
  );
};

/** The placeholder shown after a value-taking flag. */
const typeName = (field: z.ZodType): string => {
  const type = declaredOptionType(field);
  if (type instanceof z.ZodString) return "string";
  if (type instanceof z.ZodNumber) return "number";
  if (type instanceof z.ZodBoolean) return "boolean";
  if (type instanceof z.ZodArray) return "array";
  if (type instanceof z.ZodEnum)
    return type.options.map((value) => String(value)).join("|");
  if (
    type instanceof z.ZodUnion &&
    type.options.every((option) => option instanceof z.ZodLiteral)
  )
    return type.options.map((option) => String(option.value)).join("|");
  return "value";
};

/** A shown default; empty arrays and a `false` boolean default are not shown. */
const shownDefault = (field: z.ZodType, type: string): unknown => {
  const value =
    field instanceof z.ZodDefault
      ? (field.def.defaultValue as unknown)
      : field instanceof z.ZodOptional
        ? shownDefault(field.unwrap() as z.ZodType, type)
        : undefined;
  if (Array.isArray(value) && value.length === 0) return undefined;
  if (type === "boolean" && value === false) return undefined;
  return value;
};

const optionRows = (
  options: z.ZodObject,
  alias: Readonly<Record<string, string>> | undefined,
): Row[] =>
  Object.entries(options.shape as Readonly<Record<string, z.ZodType>>).map(
    ([key, field]) => {
      const type = typeName(field);
      const short = alias?.[key];
      const value = type === "boolean" ? "" : ` <${type}>`;
      const label = `--${optionFlagName(key)}${short === undefined ? "" : `, -${short}`}${value}`;
      const defaultValue = shownDefault(field, type);
      const description = field.description ?? "";
      return {
        label,
        description:
          defaultValue === undefined
            ? description
            : `${description} (default: ${String(defaultValue)})`,
      };
    },
  );

/** The global options every command entry accepts, sorted by flag. */
const globalOptionRows = ({ formats }: GlobalOptionsHelp): Row[] =>
  [
    {
      label: "--filter-output <keys>",
      description: "Filter output by key paths (e.g. foo,bar.baz,a[0,3])",
    },
    { label: `--format <${formats.join("|")}>`, description: "Output format" },
    { label: "--help", description: "Show help" },
    {
      label: "--llms, --llms-full",
      description: "Print LLM-readable manifest",
    },
    { label: "--schema", description: "Show JSON Schema for command" },
    {
      label: "--token-count",
      description: "Print token count of output (instead of output)",
    },
    { label: "--token-limit <n>", description: "Limit output to n tokens" },
    {
      label: "--token-offset <n>",
      description: "Skip first n tokens of output",
    },
    { label: "--full-output", description: "Show full output envelope" },
  ].sort((left, right) => left.label.localeCompare(right.label));

/** Render one command's help, without a trailing newline. */
export const formatCommandHelp = (name: string, help: CommandHelp): string => {
  const lines = [
    help.description === undefined ? name : `${name} — ${help.description}`,
    "",
    `Usage: ${name}${help.options === undefined ? "" : " [options]"}`,
  ];
  const options =
    help.options === undefined ? [] : optionRows(help.options, help.alias);
  if (options.length > 0) lines.push("", "Options:", ...alignedRows(options));
  if (help.hint !== undefined) lines.push("", help.hint);
  if (help.globalOptions !== undefined)
    lines.push(
      "",
      "Global Options:",
      ...alignedRows(globalOptionRows(help.globalOptions)),
    );
  return lines.join("\n");
};
