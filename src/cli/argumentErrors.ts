import { projectInputIssues } from "../domain/inputIssueProjection.js";
import { redactExplicitText } from "../domain/explicitSensitiveValues.js";
import {
  CLI_DOCUMENT_OUTPUT_FORMATS,
  type ParsedCliOutputArguments,
} from "./cliOutput.js";
import { estimateTokenCount } from "tokenx";
import { formatCliOutput } from "./cliOutputFormatter.js";
import type { CliArgvFailure, CliFieldError } from "./argvParser.js";
import type { CliCommandEntry } from "./commandRegistry.js";
import { formatCommandHelp } from "./help.js";
import { optionFlagName } from "./optionFields.js";
import { renderFailure, type CallToAction } from "./outputEnvelope.js";

const ARGUMENT_GUIDANCE =
  "REA could not read the command arguments. Check the named argument and its expected type, then try again.";

export interface CliCommandFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
  readonly fieldErrors?: readonly (CliFieldError & {
    readonly maximum?: number;
  })[];
}

const adbPackageCommands = new Set([
  "pull-adb-package",
  "inspect-adb-package",
  "uninstall-adb-package",
  "start-adb-app",
  "stop-adb-app",
]);
const isAdbSelector = (command: string, field: string): boolean =>
  (command.includes("-adb-") && field === "serial") ||
  (adbPackageCommands.has(command) && field === "package") ||
  (command === "list-adb-directory" && field === "device-path") ||
  (command === "resolve-adb-packages" && field === "query") ||
  (["pull-adb-file", "push-adb-file"].includes(command) &&
    field === "device-path") ||
  (command === "start-adb-activity" &&
    ["action", "component", "data-uri"].includes(field)) ||
  (command === "read-adb-setting" && field === "key");

/** Project the parser's retained facts, without serializing an exception cause. */
export const cliArgumentFailure = (
  cli: string,
  command: string,
  failure: CliArgvFailure,
): CliCommandFailure => {
  if (failure.kind === "dry_run" || failure.kind === "flag_spelling")
    return { code: "PARSE_ERROR", message: failure.message, retryable: false };
  if (failure.kind !== "validation")
    return {
      code: "UNKNOWN",
      message:
        failure.message +
        (failure.kind === "surplus"
          ? ` Use '${cli} ${command} --help' for the declared argument shape.`
          : ""),
    };
  return {
    code: "VALIDATION_ERROR",
    message: ARGUMENT_GUIDANCE,
    fieldErrors: failure.fieldErrors.map((field, index) => {
      const issue = failure.issues[index];
      if (
        !command.includes("-adb-") ||
        issue === undefined ||
        issue.path.length !== 1 ||
        issue.path[0] !== field.path ||
        issue.code !== field.code ||
        !isAdbSelector(command, field.path) ||
        (issue.code !== "too_big" && issue.code !== "invalid_format")
      )
        return field;
      const projected = projectInputIssues([issue], undefined)[0];
      if (projected?.maximum !== undefined)
        return { ...field, maximum: projected.maximum };
      return projected?.expected === "regex"
        ? { ...field, expected: "regex" }
        : field;
    }),
  };
};

/** Paths and expectations remain schema facts; caller text is redacted before rendering. */
export const redactCliCommandFailure = (
  failure: CliCommandFailure,
  values: readonly string[],
): CliCommandFailure => ({
  ...failure,
  message: redactExplicitText(failure.message, values),
  ...(failure.fieldErrors === undefined
    ? {}
    : {
        fieldErrors: failure.fieldErrors.map((field) => ({
          ...field,
          received: redactExplicitText(field.received, values),
          message: redactExplicitText(field.message, values),
        })),
      }),
});

const validationUsage = (
  cli: string,
  entry: CliCommandEntry,
  fields: NonNullable<CliCommandFailure["fieldErrors"]>,
): string => {
  const lines = fields.map((field) => {
    const [head, ...tail] = field.path.split(".");
    const option =
      head !== undefined && entry.definition.options?.shape[head] !== undefined;
    const label = option
      ? `--${optionFlagName(head!)}${tail.length === 0 ? "" : `.${tail.join(".")}`}`
      : `<${field.path}>`;
    return field.missing
      ? `Error: missing required ${option ? "option" : "argument"} ${label}`
      : `Error: invalid value for ${label}: ${field.message}`;
  });
  return [
    ...lines,
    "See below for usage.",
    "",
    formatCommandHelp(`${cli} ${entry.name}`, {
      ...entry.definition,
      globalOptions: { formats: CLI_DOCUMENT_OUTPUT_FORMATS },
    }),
  ].join("\n");
};

/** Preserve ordinary-command diagnostic presentation while removing SDK middleware. */
export const renderCliCommandFailure = (
  failure: CliCommandFailure,
  input: {
    readonly cli: string;
    readonly entry: CliCommandEntry;
    readonly duration: string;
    readonly stdoutIsTerminal: boolean;
    readonly controls: ParsedCliOutputArguments;
    readonly cta?: CallToAction | undefined;
  },
): string => {
  const { controls, stdoutIsTerminal, cta } = input;
  const human = stdoutIsTerminal && !controls.formatExplicit;
  if (human && failure.fieldErrors !== undefined)
    return `${validationUsage(input.cli, input.entry, failure.fieldErrors)}\n`;
  const format =
    controls.format === "csv" || controls.format === "tsv"
      ? "json"
      : controls.format;
  // Preserve the ordinary command's established count policy. JSONL errors
  // remain diagnostic records; the common renderer owns their framing.
  if (controls.tokenCount && format !== "jsonl")
    return `${estimateTokenCount(formatCliOutput(failure, format))}\n`;
  return renderFailure(
    failure,
    { command: input.entry.name, duration: input.duration },
    cta,
    {
      format,
      human,
      fullOutput: controls.fullOutput,
      tokenCount: false,
      tokenLimit: controls.tokenLimit,
      tokenOffset: controls.tokenOffset,
    },
  );
};
